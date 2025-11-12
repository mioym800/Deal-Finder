import Property from '../models/Property.js';
import { log } from '../utils/logger.js';

import { computeAMV } from '../services/amv.js';
import mongoose from 'mongoose';

const { Types } = mongoose;


// Scoped logger for this controller
const L = log.child('property');

// normalize address for CI search
function normAddr(s = '') {
  return String(s).replace(/\s+/g, ' ').trim().toLowerCase();
}

// --- helpers ---
const num = (v) => {
  if (v == null) return null;
  const n = Number(String(v).replace(/[^0-9.\-]/g, ''));
  return Number.isFinite(n) ? n : null;
};

function recomputeAmvAndDeal(doc) {
// Extract vendor values we care about for AMV
  const bofa_value = num(doc.bofa_value);
  const redfin_avm_value = num(doc.redfin_avm_value);

  // Compute AMV from available vendors (BofA + Redfin AVM only)
  const amvVal = computeAMV({ bofa_value, redfin_avm_value });

  // Deal classification at ≤ 50% of AMV
  const price = num(doc.price);
  const deal = (Number.isFinite(price) && Number.isFinite(amvVal))
    ? price <= Math.round(amvVal * 0.50)
    : false;

  return { amv: amvVal ?? null, deal };
}

// Compare primitives & shallow values
function same(a, b) {
  if (Number.isNaN(a) && Number.isNaN(b)) return true;
  return a === b;
}

// Extract the inputs that influence AMV
function amvInputsOf(doc = {}) {
  const n = (v) => (v == null ? null : num(v));
  const mLow  = n(doc.movoto_range_low);
  const mHigh = n(doc.movoto_range_high);
  return {
    bofa:  n(doc.bofa_value),
    chase: n(doc.chase_value),
    movoto_low:  Number.isFinite(mLow)  ? mLow  : null,
    movoto_high: Number.isFinite(mHigh) ? mHigh : null,
    // not strictly an AMV input, but we use price for deal calc:
    price: n(doc.price),
  };
}

function amvInputSig(doc = {}) {
  // A stable signature string so we can skip recomputation/logging when unchanged
  const i = amvInputsOf(doc);
  return JSON.stringify(i);
}

 async function recomputeAMVIfPossible(identifier) {
  try {
    let doc = null;

    // If we were passed a full document with _id, use it directly
    if (identifier && typeof identifier === 'object' && identifier._id) {
      doc = identifier;
    } else if (typeof identifier === 'string') {
      // If it looks like an ObjectId, try by id first; otherwise treat as fullAddress
      if (Types.ObjectId.isValid(identifier)) {
        doc = await Property.findById(identifier).lean();
      }
      if (!doc) {
        doc = await getPropertyByFullAddress(identifier);
      }
    }

    if (!doc || !doc._id) {
      L.warn('recomputeAMVIfPossible: property not found', { identifier });
      return null;
    }

    // Compute current signature + AMV & deal from vendor inputs
    const nextSig = amvInputSig(doc);
    const { amv, deal } = recomputeAmvAndDeal(doc);

    const missingInputs =
      !Number.isFinite(num(doc.bofa_value)) &&
      !Number.isFinite(num(doc.chase_value)) &&
      !(Number.isFinite(num(doc.movoto_range_low)) || Number.isFinite(num(doc.movoto_range_high)));

    const setFields = {
      amv: amv ?? null,
      deal: !!deal,
      amv_input_sig: nextSig,
      needs_vendor_valuations: !!missingInputs,
      updatedAt: new Date(),
    };

    const updated = await Property.findByIdAndUpdate(
      doc._id,
      { $set: setFields },
      { new: true, runValidators: true }
    );

    L.info('recomputeAMVIfPossible: recomputed', {
      id: String(doc._id),
      address: doc.fullAddress,
      bofa_value: Number.isFinite(num(doc.bofa_value)) ? num(doc.bofa_value) : null,
      redfin_avm_value: Number.isFinite(num(doc.redfin_avm_value)) ? num(doc.redfin_avm_value) : null,
      amv: updated?.amv ?? null,
      price: Number.isFinite(num(doc.price)) ? num(doc.price) : null,
      deal: updated?.deal ?? false,
      needs_vendor_valuations: setFields.needs_vendor_valuations,
    });

    return updated;
  } catch (e) {
    L.warn('recomputeAMVIfPossible failed', { identifier, error: e?.message || String(e) });
    return null;
  }
}

function parseUSFullAddress(fullAddress = '') {
  const parts = String(fullAddress || '').split(',').map(s => s.trim()).filter(Boolean);
  if (parts.length < 3) return null; // expect: "street, city, ST ZIP"

  const address = parts[0];
  const city = parts[1];
  const stateZip = parts.slice(2).join(', '); // allow for extra commas in some addresses

  const m = stateZip.match(/\b([A-Z]{2})\b(?:\s+(\d{5}(?:-\d{4})?))?/i);
  if (!m) return null;

  const state = m[1].toUpperCase();
  const zip = m[2] ? m[2] : undefined;
  return { address, city, state, zip };
}

function slugifyId({ address, city, state, zip }) {
  const base = [address, city, state, zip || ''].join('-').toLowerCase();
  return base
    .normalize('NFKD')
    .replace(/[^\w\s-]/g, '')
    .replace(/\s+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '');
}

function shortHash(str = '') {
  // Non-cryptographic short hash for suffixing IDs when necessary
  let h = 0;
  for (let i = 0; i < str.length; i++) {
    h = ((h << 5) - h + str.charCodeAt(i)) | 0;
  }
  const v = Math.abs(h).toString(36);
  return v.slice(0, 6);
}

// Picks only keys whose value is not undefined (null is allowed)
function pickDefined(obj = {}) {
  return Object.fromEntries(
    Object.entries(obj).filter(([, v]) => v !== undefined)
  );
}

// Create a new property
const createProperty = async (propertyData) => {
  try {
    const normalize = (s = '') => String(s).trim();
    const toLower = (s = '') => normalize(s).toLowerCase();
    const toUpper = (s = '') => normalize(s).toUpperCase();

    const fullAddress = normalize(propertyData.fullAddress || '');
    if (!fullAddress) throw new Error('fullAddress is required');

    // Coerce numeric price if present
    const priceNum = num(
  propertyData.price ??
  propertyData.listingPrice ??
  propertyData.listPrice ??
  propertyData.asking_price ??
  propertyData.lp
);

    // Ensure required address parts exist; parse from fullAddress if not provided
    const parsed = parseUSFullAddress(fullAddress);
    if (!parsed) {
      throw new Error('Cannot create Property: address/city/state/zip could not be parsed from fullAddress');
    }

    const address = propertyData.address ? normalize(propertyData.address) : parsed.address;
    const city    = propertyData.city ? normalize(propertyData.city) : parsed.city;
    const state   = propertyData.state ? toUpper(propertyData.state) : parsed.state;
    const zip     = propertyData.zip ? normalize(propertyData.zip) : (parsed.zip || '');

    // Generate stable prop_id if missing
    const base_prop_id = propertyData.prop_id || slugifyId({ address, city, state, zip });

    // Prepare the document we would insert
    const details = propertyData.details || {};
    const detailsCoerced = {
      ...details,
      beds:  details.beds  != null ? num(details.beds)  : null,
      baths: details.baths != null ? num(details.baths) : null,
      sqft:  details.sqft  != null ? num(details.sqft)  : null,
      _raw:  details._raw || {},
    };

    const docOnInsert = {
      ...propertyData,
      prop_id: base_prop_id,
      address,
      city,
      state,
      zip,
      fullAddress,
      fullAddress_ci: toLower(fullAddress),
      price: priceNum != null && !Number.isNaN(priceNum) ? priceNum : propertyData.price,
      details: detailsCoerced,
    };

    // Precompute AMV/Deal for insert
    const { amv, deal } = recomputeAmvAndDeal(docOnInsert);
    if (amv != null) docOnInsert.amv = amv;
    if (typeof deal === 'boolean') docOnInsert.deal = deal;

    // Stamp AMV input signature and vendor valuation need state at insert time
    docOnInsert.amv_input_sig = amvInputSig(docOnInsert);
    docOnInsert.needs_vendor_valuations =
      !Number.isFinite(num(docOnInsert.bofa_value)) &&
      !Number.isFinite(num(docOnInsert.chase_value)) &&
      !(Number.isFinite(num(docOnInsert.movoto_range_low)) || Number.isFinite(num(docOnInsert.movoto_range_high)));

    const now = new Date();

    // Atomic upsert by case-insensitive fullAddress (prevents race-duplicates)
    const searchCriteria = {
      $or: [
        { fullAddress_ci: toLower(fullAddress) },
        { fullAddress: { $regex: `^${fullAddress.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`, $options: 'i' } },
      ],
    };

    const property = await Property.findOneAndUpdate(
      searchCriteria,
      {
        $setOnInsert: { ...docOnInsert, createdAt: now },
        $set: { updatedAt: now },
      },
      { new: true, upsert: true }
    );

    // Very rare prop_id collision guard: if inserted doc's fullAddress mismatches another existing doc with same prop_id, patch prop_id with a short hash
    if (property.isNew === true || (property.createdAt && Math.abs(now - property.createdAt) < 5000)) {
      // nothing further; just created
    } else {
      // If we did not insert (doc existed), we simply return the existing/updated doc.
    }

    L.success('Property saved (atomic upsert)', { fullAddress, id: property?._id });
    return property;
  } catch (error) {
    L.error('Error saving property', { fullAddress: propertyData?.fullAddress, error: error.message });
    throw error;
  }
};

// Read properties (optionally with a filter)
const getProperties = async (filter = {}) => {
  try {
    L.info('Fetching properties', { filter });
    const properties = await Property.find(filter);
    L.success('Properties retrieved', { count: properties.length });
    return properties;
  } catch (error) {
    L.error('Error retrieving properties', { error: error.message });
    throw error;
  }
};

const getPropertiesWithNoEmails = async () => {
  // Only deals that STILL don't have an agent email in either legacy or new field
  const filter = {
    deal: true,
    $and: [
      { $or: [{ agentEmail: null }, { agentEmail: '' }, { agentEmail: { $exists: false } }] },
      { $or: [{ agent_email: null }, { agent_email: '' }, { agent_email: { $exists: false } }] },
    ],
  };

  L.info('Fetching DEAL properties missing agentEmail (including legacy agent_email)', { filter });
  const props = await Property.find(filter);
  L.success('Fetched DEAL properties missing agentEmail', { count: props.length });
  return props;
};

// --- Get deals with optional minBeds filtering ---
/**
 * Fetches deal properties, optionally filtering by minimum beds.
 * If minBeds is provided and numeric, uses a simple numeric query first.
 * If that yields zero results, falls back to an aggregation that coerces beds to number.
 * @param {Object} options
 * @param {number} [options.minBeds]
 * @returns {Promise<Array>}
 */
 async function getDealsFiltered({ minBeds } = {}) {
  let docs = [];
  let query = { deal: true };
  let hasMinBeds = Number.isFinite(minBeds);
  if (hasMinBeds) {
    query['details.beds'] = { $gte: minBeds };
  }
  docs = await Property.find(query).lean();
  if (docs.length === 0 && hasMinBeds) {
    // Fallback: aggregation to coerce details.beds to number
    docs = await Property.aggregate([
      { $match: { deal: true } },
      { $addFields: { bedsNum: { $toDouble: "$details.beds" } } },
      { $match: { bedsNum: { $gte: minBeds } } },
      // Optionally remove the bedsNum field from output
      { $project: { bedsNum: 0 } }
    ]);
  }
  return docs;
}

/**
 * Express HTTP handler for listing deals with optional minBeds filter.
 * Responds with { rows: docs }
 */
 async function listDealsHttp(req, res) {
  try {
    // Accept minBeds from either ?minBeds= or ?min_beds=
    let minBedsRaw = req.query.minBeds ?? req.query.min_beds;
    let minBeds = minBedsRaw !== undefined ? Number(minBedsRaw) : undefined;
    if (!Number.isFinite(minBeds)) minBeds = undefined;
    const docs = await getDealsFiltered({ minBeds });
    res.json({ rows: docs });
  } catch (err) {
    res.status(500).json({ error: err?.message || "Internal server error" });
  }
}

// Update a property by ID (normalize numbers, keep fullAddress_ci/state uppercase, recompute AMV & deal)
const updateProperty = async (id, updates = {}) => {
  try {
    L.info('Updating property', { id });

    const normalized = { ...updates };

    // --- Guard against accidental conflicting price writes ---
// If 'price' is present as null/undefined/empty string, drop it entirely (prevents conflicts)
if ('price' in normalized) {
  const p = num(normalized.price);
  if (p == null || p <= 0) {
    delete normalized.price;
  } else {
    normalized.price = p;
  }
}

// If caller ALSO leaked a nested 'details.price' (seen in some raw payloads), drop it;
// we do not support a price under details to avoid path conflicts.
if (normalized.details && typeof normalized.details === 'object') {
  if ('price' in normalized.details) delete normalized.details.price;
}

    // Normalize top-level numeric fields when provided
    if ('price' in updates) normalized.price = num(updates.price);
    if ('bofa_value' in updates) normalized.bofa_value = num(updates.bofa_value);
    if ('chase_value' in updates) normalized.chase_value = num(updates.chase_value);
    if ('movoto_range_low' in updates) normalized.movoto_range_low = num(updates.movoto_range_low);
    if ('movoto_range_high' in updates) normalized.movoto_range_high = num(updates.movoto_range_high);
    if ('movoto_adjusted' in updates) normalized.movoto_adjusted = num(updates.movoto_adjusted);

    // Build dot-notation updates for the nested details object
    const dotSet = {};
    if (updates.details && typeof updates.details === 'object') {
      if ('beds'  in updates.details) dotSet['details.beds']  = num(updates.details.beds);
      if ('baths' in updates.details) dotSet['details.baths'] = num(updates.details.baths);
      if ('sqft'  in updates.details) dotSet['details.sqft']  = num(updates.details.sqft);
      if ('built' in updates.details) dotSet['details.built'] = num(updates.details.built);
      if (updates.details._raw && typeof updates.details._raw === 'object') {
        // merge, don’t replace
        for (const [k, v] of Object.entries(updates.details._raw)) {
          dotSet[`details._raw.${k}`] = v;
        }
      }
    }

    // Absolutely ensure no parent/child conflict on 'details'
    // Remove any accidental parent path or flattened child paths from normalized
    for (const k of Object.keys(normalized)) {
      if (k === 'details' || k.startsWith('details.')) {
        delete normalized[k];
      }
    }

    // Normalize address fields if present
    if ('fullAddress' in updates && typeof updates.fullAddress === 'string') {
      const fa = updates.fullAddress.trim();
      normalized.fullAddress = fa;
      normalized.fullAddress_ci = fa.toLowerCase();
    }
    if ('state' in updates && typeof updates.state === 'string') {
      normalized.state = updates.state.trim().toUpperCase();
    }

    // Load current doc to compute derived fields accurately
    const current = await Property.findById(id).lean();
    if (!current) {
      L.warn('Property not found for update', { id });
      return null;
    }

    // Prepare a merged preview for computing derived fields
    const mergedPreview = { ...current, ...normalized };

    // Build the final $set payload (top-level + nested dotSet)
    const setFields = { ...normalized, ...dotSet };

    // Remove keys whose value wouldn't actually change (prevents no-op writes & duplicate logs)
    for (const k of Object.keys(setFields)) {
      const next = setFields[k];
      const prev = k.includes('.')
        ? k.split('.').reduce((o, p) => (o && o[p] != null ? o[p] : undefined), current)
        : current[k];
      if (same(prev, next)) delete setFields[k];
    }

    // Whether there are effective top-level/nested changes (before derived recompute)
    const hasEffectiveChanges = Object.keys(setFields).length > 0;

    // Decide whether AMV/deal need recompute (only if AMV inputs changed)
    const prevSig = current.amv_input_sig || amvInputSig(current);
    const nextSig = amvInputSig({ ...mergedPreview, ...dotSet });

    let amv = current.amv ?? null;
    let deal = current.deal ?? false;
    let needs_vendor_valuations = current.needs_vendor_valuations ?? false;

    if (prevSig !== nextSig) {
      const recomputed = recomputeAmvAndDeal({ ...mergedPreview, ...dotSet });
      amv = recomputed.amv ?? null;
      deal = !!recomputed.deal;
      setFields.amv = amv;
      setFields.deal = deal;
      setFields.amv_input_sig = nextSig;

       // Verbose AMV trace: show vendor inputs and result
      L.info('AMV recomputed (controller)', {
        address: mergedPreview.fullAddress,
        bofa_value: Number.isFinite(num(mergedPreview.bofa_value)) ? num(mergedPreview.bofa_value) : null,
        redfin_avm_value: Number.isFinite(num(mergedPreview.redfin_avm_value)) ? num(mergedPreview.redfin_avm_value) : null,
        amv,
        price: Number.isFinite(num(mergedPreview.price)) ? num(mergedPreview.price) : null,
        deal,
      });

      const missingInputs =
        !Number.isFinite(num(mergedPreview.bofa_value)) &&
        !Number.isFinite(num(mergedPreview.chase_value)) &&
        !(Number.isFinite(num(mergedPreview.movoto_range_low)) || Number.isFinite(num(mergedPreview.movoto_range_high)));

      if (missingInputs) {
        if (!needs_vendor_valuations) {
          // Only log once when we transition into "needs_vendor_valuations"
          L.info('AMV not computed — missing vendor values', {
            address: mergedPreview.fullAddress,
            haveBofa:  Number.isFinite(num(mergedPreview.bofa_value)),
            haveChase: Number.isFinite(num(mergedPreview.chase_value)),
            haveMovotoRange:
              Number.isFinite(num(mergedPreview.movoto_range_low)) || Number.isFinite(num(mergedPreview.movoto_range_high)),
          });
        }
        needs_vendor_valuations = true;
      } else {
        needs_vendor_valuations = false;
      }
      setFields.needs_vendor_valuations = needs_vendor_valuations;
    }

    // If after pruning and no AMV-input change there’s nothing to write, short-circuit as a no-op
    if (!hasEffectiveChanges && prevSig === nextSig) {
      L.info('No-op property update (no effective changes)', { id, fullAddress: current.fullAddress });
      return await Property.findById(id);
    }

    // We know changes exist; stamp updatedAt only now
    setFields.updatedAt = new Date();
    // Remove undefineds and ensure unique paths
for (const k of Object.keys(setFields)) {
  if (setFields[k] === undefined) delete setFields[k];
}

// Explicitly ensure we are not setting the same path via two different shapes
// (defensive: in case a future change reintroduces collisions)
if ('price' in setFields && typeof setFields.price !== 'number') {
  const p = num(setFields.price);
  if (p == null) delete setFields.price;
  else setFields.price = p;
}
// Drop any nested price paths to avoid "Updating the path 'price' would create a conflict at 'price'"
for (const k of Object.keys(setFields)) {
  if (k.startsWith('price.')) delete setFields[k];
}

    const property = await Property.findByIdAndUpdate(
      id,
      { $set: setFields },
      { new: true, runValidators: true, overwrite: false }
    );
    L.success('Property updated', {
   id,
   fullAddress: property?.fullAddress,
   bofa_value: property?.bofa_value ?? null,
   redfin_avm_value: property?.redfin_avm_value ?? null,
   amv: property?.amv,
   deal: property?.deal
 });    return property;
  } catch (error) {
    L.error('Error updating property', { id, error: error.message });
    throw error;
  }
};

// Get a property by fullAddress (case-insensitive)
const getPropertyByFullAddress = async (fullAddress) => {
  try {
    const norm = String(fullAddress || '').replace(/\s+/g, ' ').trim();
    L.info('Fetching property by fullAddress (ci)', { fullAddress: norm });

    // Also derive a deterministic prop_id from the provided full address (if parsable)
    let pid = null;
    const parsed = parseUSFullAddress(norm);
    if (parsed) {
      pid = slugifyId(parsed);
    }

    const query = {
      $or: [
        { fullAddress_ci: norm.toLowerCase() },
        { fullAddress: { $regex: `^${norm.replace(/[.*+?^${}()|[\\]\\\\]/g, '\\\\$&')}$`, $options: 'i' } },
        ...(pid ? [{ prop_id: pid }] : []),
      ],
    };

    const property = await Property.findOne(query).lean().exec();

    if (!property) {
      L.warn('Property with fullAddress not found', { fullAddress: norm });
      return null;
    }
    L.success('Property retrieved by fullAddress', { fullAddress: norm, id: property._id });
    return property;
  } catch (error) {
    L.error('Error retrieving property by fullAddress', { fullAddress, error: error.message });
    throw error;
  }
};

const upsertProperty = async (data = {}) => {
  const normalize = (s = '') => String(s).trim();
  const toLower = (s = '') => normalize(s).toLowerCase();
  const toUpper = (s = '') => normalize(s).toUpperCase();

  try {
    const fullAddress = normalize(data.fullAddress || '');
    if (!fullAddress) {
      L.warn('upsertProperty called without fullAddress in data', { data });
      return { doc: null, created: false, updated: false };
    }

    // Parse address parts; required to derive prop_id deterministically
    const parsed = parseUSFullAddress(fullAddress);
    if (!parsed) {
      throw new Error('Cannot upsert Property: address/city/state/zip could not be parsed from fullAddress');
    }

    const address = data.address ? normalize(data.address) : parsed.address;
    const city    = data.city ? normalize(data.city) : parsed.city;
    const state   = data.state ? toUpper(data.state) : parsed.state;
    const zip     = data.zip ? normalize(data.zip) : (parsed.zip || '');

    // Deterministic identity key
    const prop_id = data.prop_id || slugifyId({ address, city, state, zip });
    const now = new Date();
    const fa_ci = toLower(fullAddress);

    // ---------- Build conflict-safe ops ----------
    // Insert-only identity fields
    const setOnInsert = pickDefined({
      prop_id,
      address,
      city,
      state,
      zip,
      fullAddress,
      fullAddress_ci: fa_ci,
      createdAt: now,
    });

    // Update fields (numeric guarded where applicable)
    const set = pickDefined({
      updatedAt: now,

      // top-level numeric fields (guarded)
      price: (() => {
  const cand =
    data.price ??
    data.listingPrice ??
    data.listPrice ??
    data.asking_price ??
    data.lp;
  const n = Number(String(cand ?? '').replace(/[^0-9.\-]/g, ''));
  return Number.isFinite(n) ? n : undefined;
})(),

      // vendor valuations (guarded)
      bofa_value: Number.isFinite(Number(data.bofa_value)) ? Number(data.bofa_value) : undefined,
      chase_value: Number.isFinite(Number(data.chase_value)) ? Number(data.chase_value) : undefined,

      // movoto inputs (guarded)
      movoto_range_low:  Number.isFinite(Number(data.movoto_range_low))  ? Number(data.movoto_range_low)  : undefined,
      movoto_range_high: Number.isFinite(Number(data.movoto_range_high)) ? Number(data.movoto_range_high) : undefined,
      movoto_adjusted:   Number.isFinite(Number(data.movoto_adjusted))   ? Number(data.movoto_adjusted)   : undefined,
    });

    // Ensure no duplication of keys between $set and $setOnInsert
    for (const k of Object.keys(setOnInsert)) {
      if (k in set) delete set[k];
    }

    const filter = { prop_id }; // <<< single-key identity prevents E11000 races
    const update = {};
    if (Object.keys(set).length) update.$set = set;
    if (Object.keys(setOnInsert).length) update.$setOnInsert = setOnInsert;

    let doc;
    try {
      doc = await Property.findOneAndUpdate(
        filter,
        update,
        { new: true, upsert: true, setDefaultsOnInsert: true }
      ).exec();
    } catch (err) {
      // Rare race: try a non-upsert update if duplicate sneaks in
      if (err && (err.code === 11000 || /E11000/.test(String(err)))) {
        doc = await Property.findOneAndUpdate(filter, update, { new: true, upsert: false }).exec();
      } else {
        throw err;
      }
    }

    // For existing docs, optionally re-run our normalized update path to compute deriveds, etc.
    const created = !!(doc && doc.createdAt && Math.abs(now - doc.createdAt) < 5000);
    if (!created && doc?._id) {
      const updatedDoc = await updateProperty(doc._id, { ...data, fullAddress });
      L.success('upsertProperty: updated existing property by prop_id', { id: updatedDoc?._id, prop_id });
      return { doc: updatedDoc || doc, created: false, updated: true };
    }

    L.success('upsertProperty: created/updated by prop_id', { id: doc?._id, prop_id });
    return { doc, created, updated: true };
  } catch (error) {
    L.error('upsertProperty: error during upsert', { error: error.message });
    throw error;
  }
};

export const upsertPropertyFromFullAddress = (fullAddress, updates = {}) =>
  upsertProperty({ fullAddress, ...updates }, { createIfMissing: true, matchBy: 'fullAddress' });

export async function upsertPropertyDetailsFromRaw(raw = {}) {
  try {
    if (!raw?.fullAddress || !raw?.details) return null;

    const d = raw.details || {};

    // Normalize numbers using the existing helper
    const beds  = num(d.beds);
    const baths = num(d.baths);
    const built = num(d.built);
    // Normalize "squareft" → "sqft" and coerce to number
    const sqftNormalized =
      d.squareft != null ? num(d.squareft) :
      d.sqft     != null ? num(d.sqft)     :
      null;

    // Build a payload that ONLY includes keys with finite numbers
    // This prevents wiping existing values by writing nulls.
    const detailsPayload = { _raw: d._raw || {} };
    if (Number.isFinite(beds))  detailsPayload.beds  = beds;
    if (Number.isFinite(baths)) detailsPayload.baths = baths;
    if (Number.isFinite(sqftNormalized)) detailsPayload.sqft = sqftNormalized;
    if (Number.isFinite(built)) detailsPayload.built = built;

    // If nothing to set (besides _raw), still pass _raw so we can merge source texts
    const payload = { fullAddress: raw.fullAddress, details: detailsPayload };

    const { doc } = await upsertProperty(
      payload,
      { createIfMissing: true, matchBy: 'fullAddress' }
    );

    return doc || null;
  } catch (e) {
    L.warn('upsertPropertyDetailsFromRaw failed', { error: e?.message || String(e) });
    return null;
  }
}

// Get a property by ID
const getPropertyById = async (id) => {
  try {
    L.info('Fetching property by ID', { id });
    const property = await Property.findById(id);
    if (!property) {
      L.warn('Property with ID not found', { id });
      return null;
    }
    L.success('Property retrieved', { id, fullAddress: property.fullAddress });
    return property;
  } catch (error) {
    L.error('Error retrieving property by ID', { id, error: error.message });
    throw error;
  }
};

// Delete a property by ID
const deleteProperty = async (id) => {
  try {
    L.info('Deleting property', { id });
    await Property.findByIdAndDelete(id);
    L.success('Property deleted', { id });
  } catch (error) {
    L.error('Error deleting property', { id, error: error.message });
    throw error;
  }
};

export {
  createProperty,
  upsertProperty,
  getProperties,
  updateProperty,
  deleteProperty,
  getPropertyByFullAddress,
  getPropertyById,
  parseUSFullAddress,
  slugifyId,
  getPropertiesWithNoEmails,
  recomputeAMVIfPossible,
  getDealsFiltered,
  listDealsHttp,
};