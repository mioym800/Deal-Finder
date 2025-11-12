// backend/controllers/rawPropertyController.js
import RawProperty from '../models/rawProperty.js';
import { log } from '../utils/logger.js';
import { upsertProperty } from './propertyController.js';
// Scoped logger for raw property operations
const L = log.child('rawProperty');

// Only pass finite numbers when mirroring into main Property
function onlyFiniteNumber(x) {
  return typeof x === 'number' && Number.isFinite(x) ? x : null;
}

// Coerce common numeric fields safely
const num = (v) => {
  if (v == null) return null;
  const n = Number(String(v).replace(/[^0-9.\-]/g, ''));
  return Number.isFinite(n) ? n : null;
};

// Build a safe payload for Property upsert: drop null/undefined and conflicting price shapes
const sanitizeForProperty = (doc = {}) => {
  const src = (doc?.toObject?.() ? doc.toObject() : doc) || {};
  const out = { ...src };

  // Remove empty or object-shaped price to avoid parent/child path conflicts downstream
  if (out.price == null || typeof out.price === 'object') {
    delete out.price;
  } else {
    const p = num(out.price);
    if (p == null) delete out.price;
    else out.price = p;
  }

  // Normalize known numeric vendor/value fields and drop if null
  const numericKeys = [
    'bofa_value',
    'chase_value',
    'movoto_range_low',
    'movoto_range_high',
    'movoto_adjusted',
    'amv',
    'sqft',
    'beds',
    'baths',
    'lot_size',
    'year_built'
  ];
  for (const k of numericKeys) {
    if (out.hasOwnProperty(k)) {
      const v = num(out[k]);
      if (v == null) delete out[k];
      else out[k] = v;
    }
  }

  // Drop obviously undefined/null scalar fields
  for (const [k, v] of Object.entries(out)) {
    if (v === undefined || v === null) delete out[k];
  }

  return out;
};

// Mirror a subset of fields into the main Property collection using conflict-safe upsert
export async function mirrorToMainProperty(raw) {
  const payload = {
    fullAddress: raw?.fullAddress || raw?.address,
    city: raw?.city || '',
    state: raw?.state || '',
    zip: raw?.zip || '',
  };

  const val = onlyFiniteNumber(raw?.bofa_value);
  if (val !== null) payload.bofa_value = val;

  const p = onlyFiniteNumber(raw?.price);
  if (p !== null) payload.price = p;

  if (payload.fullAddress) {
    await upsertProperty(payload);
  }
}

/**
 * Retrieve all raw properties (no filter).
 * @returns {Promise<Array>} List of all RawProperty documents.
 */
export const getAllRawProperties = async () => {
  try {
    L.info('Fetching all raw properties');
    const props = await RawProperty.find({}).sort({ scrapedAt: -1 });
    L.success('All raw properties retrieved', { count: props.length });
    return props;
  } catch (error) {
    L.error('Error retrieving all raw properties', { error: error.message });
    throw error;
  }
};

/**
 * Upsert (create or update) a raw property by fullAddress.
 * @param {Object} propertyData - The raw property data.
 * @returns {Promise<Object>} The upserted RawProperty document.
 */
export const upsertRawProperty = async (propertyData) => {
  try {
    if (!propertyData || typeof propertyData.fullAddress !== 'string' || !propertyData.fullAddress.trim()) {
      const msg = 'Invalid propertyData.fullAddress: It must be a non-empty string.';
      L.error('Upsert validation failed', { reason: msg });
      throw new Error(msg);
    }

    const filter = { fullAddress: propertyData.fullAddress };
    const update = { ...propertyData, status: 'scraped', scrapedAt: new Date() };
    const options = { new: true, upsert: true, setDefaultsOnInsert: true };

    L.info('Upserting raw property', { fullAddress: propertyData.fullAddress });
    const property = await RawProperty.findOneAndUpdate(filter, update, options);
    L.success('Raw property upserted', {
      id: property?._id,
      fullAddress: property?.fullAddress,
      status: property?.status,
    });
    try {
      await mirrorToMainProperty(property);
    } catch {}
    return property;
  } catch (error) {
    L.error('Failed to upsert raw property', { fullAddress: propertyData?.fullAddress, error: error.message });
    throw error;
  }
};

/**
 * Retrieve raw properties, optionally filtered by status.
 * @param {String} [status] - Optional status to filter by ('scraped', 'valued', etc.).
 * @returns {Promise<Array>} List of RawProperty documents.
 */
export const getRawProperties = async (status) => {
  try {
    const filter = status ? { status } : {};
    L.info('Fetching raw properties', { filter });
    const props = await RawProperty.find(filter).sort({ scrapedAt: -1 });
    L.success('Raw properties retrieved', { count: props.length });
    return props;
  } catch (error) {
    L.error('Error retrieving raw properties', { error: error.message });
    throw error;
  }
};

/**
 * Get a raw property by its Mongo ID.
 * @param {String} id - The RawProperty document ID.
 * @returns {Promise<Object|null>} The RawProperty document or null if not found.
 */
export const getRawPropertyById = async (id) => {
  try {
    L.info('Fetching raw property by ID', { id });
    const property = await RawProperty.findById(id);
    if (!property) {
      L.warn('Raw property not found by ID', { id });
      return null;
    }
    L.success('Raw property retrieved by ID', { id: property._id, fullAddress: property.fullAddress });
    return property;
  } catch (error) {
    L.error('Error retrieving raw property by ID', { id, error: error.message });
    throw error;
  }
};

/**
 * Get a raw property by its fullAddress.
 * @param {String} fullAddress - The fullAddress of the property.
 * @returns {Promise<Object|null>} The RawProperty document or null if not found.
 */
export const getRawPropertyByFullAddress = async (fullAddress) => {
  try {
    L.info('Fetching raw property by fullAddress', { fullAddress });
    const property = await RawProperty.findOne({ fullAddress });
    if (!property) {
      L.warn('Raw property not found by fullAddress', { fullAddress });
      return null;
    }
    L.success('Raw property retrieved by fullAddress', { id: property._id, fullAddress: property.fullAddress });
    return property;
  } catch (error) {
    L.error('Error retrieving raw property by fullAddress', { fullAddress, error: error.message });
    throw error;
  }
};

/**
 * Set vendor valuation fields on a raw property and mark status as 'valued' (unless overridden).
 * Accepts any subset of: bofa_value, chase_value, movoto_range_low, movoto_range_high, movoto_adjusted, amv.
 * @param {String} id - RawProperty _id
 * @param {Object} values - Partial valuations
 * @returns {Promise<Object|null>} Updated RawProperty
 */
export const setRawValuations = async (id, values = {}) => {
  try {
    const update = {};
    if (values.hasOwnProperty('bofa_value'))        update.bofa_value        = num(values.bofa_value);
    if (values.hasOwnProperty('chase_value'))       update.chase_value       = num(values.chase_value);
    if (values.hasOwnProperty('movoto_range_low'))  update.movoto_range_low  = num(values.movoto_range_low);
    if (values.hasOwnProperty('movoto_range_high')) update.movoto_range_high = num(values.movoto_range_high);
    if (values.hasOwnProperty('movoto_adjusted'))   update.movoto_adjusted   = num(values.movoto_adjusted);
    if (values.hasOwnProperty('amv'))               update.amv               = num(values.amv);

    // Default status to 'valued' unless caller explicitly passes another status
    update.status = values.status || 'valued';

    L.info('Setting raw valuations', { id, fields: Object.keys(update) });
    const doc = await RawProperty.findByIdAndUpdate(id, update, { new: true });
    if (!doc) {
      L.warn('Raw property not found for valuations update', { id });
      return null;
    }
    L.success('Raw valuations updated', { id: doc._id, status: doc.status });
    // Mirror sanitized subset into Property (conflict-safe)
    try {
      await mirrorToMainProperty(doc);
    } catch (e) {
      L.warn('Mirror to Property failed (valuations)', { id, error: e?.message });
    }
    return doc;
  } catch (error) {
    L.error('Error setting raw valuations', { id, error: error.message });
    throw error;
  }
};

/**
 * Update fields of a raw property by ID.
 * @param {String} id - The RawProperty document ID.
 * @param {Object} updates - The fields to update.
 * @returns {Promise<Object|null>} The updated RawProperty document or null if not found.
 */
export const updateRawProperty = async (id, updates) => {
  try {
    const keys = updates ? Object.keys(updates) : [];
    L.info('Updating raw property', { id, fields: keys });

    // Coerce known numeric fields if present
    const normalized = { ...updates };
    if (keys.includes('price'))              normalized.price              = num(updates.price);
    if (keys.includes('bofa_value'))         normalized.bofa_value         = num(updates.bofa_value);
    if (keys.includes('chase_value'))        normalized.chase_value        = num(updates.chase_value);
    if (keys.includes('movoto_range_low'))   normalized.movoto_range_low   = num(updates.movoto_range_low);
    if (keys.includes('movoto_range_high'))  normalized.movoto_range_high  = num(updates.movoto_range_high);
    if (keys.includes('movoto_adjusted'))    normalized.movoto_adjusted    = num(updates.movoto_adjusted);
    if (keys.includes('amv'))                normalized.amv                = num(updates.amv);

    const property = await RawProperty.findByIdAndUpdate(id,{ $set: normalized }, { new: true });
    if (!property) {
      L.warn('Raw property not found for update', { id });
      return null;
    }
    L.success('Raw property updated', { id: property._id, fullAddress: property.fullAddress });
    // If meaningful fields changed, mirror a sanitized payload into Property
    try {
      const mirrorKeys = new Set([
        'fullAddress',
        'city',
        'state',
        'zip',
        'price',
        'bofa_value',
        'chase_value',
        'movoto_range_low',
        'movoto_range_high',
        'movoto_adjusted',
        'amv'
      ]);
      const shouldMirror = Object.keys(normalized || {}).some(k => mirrorKeys.has(k));
      if (shouldMirror) {
        await mirrorToMainProperty(property);
      }
    } catch (e) {
      L.warn('Mirror to Property failed (updateRawProperty)', { id, error: e?.message });
    }
    return property;
  } catch (error) {
    L.error('Error updating raw property', { id, error: error.message });
    throw error;
  }
};

/**
 * Delete a raw property by ID.
 * @param {String} id - The RawProperty document ID.
 * @returns {Promise<void>}
 */
export const deleteRawProperty = async (id) => {
  try {
    L.info('Deleting raw property', { id });
    await RawProperty.findByIdAndDelete(id);
    L.success('Raw property deleted', { id });
  } catch (error) {
    L.error('Error deleting raw property', { id, error: error.message });
    throw error;
  }
};

/**
 * Mark a raw property status.
 * @param {String} id - The RawProperty document ID.
 * @param {String} statusUpdate - Status to set (e.g., 'scraped','valued','not_found','error').
 * @returns {Promise<Object|null>} The updated RawProperty document or null if not found.
 */
export const markRawPropertyStatus = async (id, statusUpdate) => {
  try {
    L.info('Updating raw property status', { id, status: statusUpdate });
    const property = await RawProperty.findByIdAndUpdate(
      id,
      { status: statusUpdate },
      { new: true }
    );
    if (!property) {
      L.warn('Raw property not found for status update', { id, status: statusUpdate });
      return null;
    }
    L.success('Raw property status updated', { id: property._id, status: property.status });
    return property;
  } catch (error) {
    L.error('Error updating raw property status', { id, status: statusUpdate, error: error.message });
    throw error;
  }
};

export { markRawPropertyStatus as updateRawPropertyStatus };