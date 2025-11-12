import express from 'express';
import Property from '../models/Property.js';
import { updateProperty } from '../controllers/propertyController.js';
import { requireAuth, scopeByState } from '../middleware/authMiddleware.js';
import mongoose from 'mongoose';


const router = express.Router();
const { Types } = mongoose;

const num = (v) => {
  if (v == null) return null;
  const n = Number(String(v).replace(/[^0-9.\-]/g, ''));
  return Number.isFinite(n) ? n : null;
};

function escapeRegex(s = '') {
  return String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function buildIdOrFilter(idParam) {
  const ors = [];
  if (Types.ObjectId.isValid(idParam)) {
    ors.push({ _id: new Types.ObjectId(idParam) });
  }
  ors.push({ prop_id: idParam });
  ors.push({ fullAddress_ci: String(idParam).toLowerCase() });
  ors.push({ fullAddress: { $regex: `^${escapeRegex(String(idParam))}$`, $options: 'i' } });
  return { $or: ors };
}

// Frontend table (auth + state-scoped)
// Maps DB fields to the exact columns the frontend expects and computes LP80 / AMV40 / AMV30.
router.get('/table', requireAuth, scopeByState(), async (req, res) => {
  try {
    const baseFilter = req.stateFilter || {};
    const onlyDeals = String(req.query?.onlyDeals || '').toLowerCase() === 'true';

    // Extra filters from query string
    const { hasEmail, minPrice, states, minBeds } = req.query || {};
    const ands = [baseFilter];

    if (onlyDeals) ands.push({ deal: true });

    // Filter by one or more states: ?states=AL,GA,FL
    if (typeof states === 'string' && states.trim()) {
      const stateList = states.split(',').map(s => String(s).trim().toUpperCase()).filter(Boolean);
      if (stateList.length) ands.push({ state: { $in: stateList } });
    }

    // Filter by presence/absence of an agent email: ?hasEmail=true|false
    if (typeof hasEmail !== 'undefined') {
      const wantEmail = String(hasEmail).toLowerCase() === 'true';
      if (wantEmail) {
        // at least one of agentEmail / agent_email has a non-empty, non-whitespace value
        ands.push({
          $or: [
            { agentEmail: { $regex: /\S/ } },
            { agent_email: { $regex: /\S/ } }
          ]
        });
      } else {
        // both camel & snake are missing/empty
        ands.push({
          $and: [
            { $or: [
              { agentEmail: { $exists: false } },
              { agentEmail: null },
              { agentEmail: '' }
            ]},
            { $or: [
              { agent_email: { $exists: false } },
              { agent_email: null },
              { agent_email: '' }
            ]}
          ]
        });
      }
    }

    // Filter by minimum listing price: ?minPrice=500000
    if (minPrice != null) {
      const mp = num(minPrice);
      if (Number.isFinite(mp) && mp > 0) {
        // Accept either stored price or listingPrice if your data sometimes uses both
        ands.push({ $or: [ { price: { $gt: mp } }, { listingPrice: { $gt: mp } } ] });
      }
    }

    const filter = ands.length > 1 ? { $and: ands } : ands[0];

    const mb = num(minBeds);
    const wantMinBeds = Number.isFinite(mb) && mb > 0;

    // robust number parser (no default 0)
    const toNum = (v) => {
      if (v == null) return null;
      if (typeof v === 'number') return Number.isFinite(v) ? v : null;
      if (typeof v === 'string') {
        const n = Number(v.replace(/[$,]/g, '').trim());
        return Number.isFinite(n) ? n : null;
      }
      if (typeof v === 'object') {
        if ('$numberInt' in v) return Number(v.$numberInt);
        if ('$numberLong' in v) return Number(v.$numberLong);
        if ('$numberDouble' in v) return Number(v.$numberDouble);
      }
      return null;
    };

    const pipeline = [
      { $match: filter },
      { $addFields: {
          fullAddress_ci_norm: { $toLower: { $ifNull: ["$fullAddress_ci", "$fullAddress"] } }
        }
      },
       { $addFields: {
     hasPrice: {
        $cond: [
          { $and: [
            { $ne: ["$price", null] },
            { $ne: ["$price", undefined] },
            { $gt: ["$price", 0] }   // ← require strictly positive
          ]},
          1, 0
        ]
      }
          }},
 // Prefer docs that have a price; then fall back to newest
 { $sort: { hasPrice: -1, updatedAt: -1, _id: -1 } },
      { $group: { _id: "$fullAddress_ci_norm", doc: { $first: "$$ROOT" } } },
      { $replaceRoot: { newRoot: "$doc" } },
    ];

    if (wantMinBeds) {
      pipeline.push(
        { $addFields: {
            __bedsNum: {
              $convert: {
                input: { $ifNull: ["$details.beds", "$beds"] },
                to: "double",
                onError: null,
                onNull: null
              }
            }
          }
        },
        { $match: { __bedsNum: { $gte: mb } } }
      );
    }

    pipeline.push(
      { $project: {
          _id: 1, prop_id: 1, fullAddress_ci: 1, updatedAt: 1,
          address: 1, fullAddress: 1, city: 1, state: 1, zip: 1,
          // include BOTH price + listingPrice and precomputed helpers if present
         price: { $cond: [ { $gt: ["$price", 0] }, "$price", null ] },
      listingPrice: 1,
          amv: 1, lp80: 1, amv40: 1, amv30: 1,
          // vendor + details
          bofa_value: 1, chase_value: 1, movoto_adjusted: 1, movoto_value: 1, movoto_range_high: 1,
          details: 1, beds: 1, baths: 1, sqft: 1,
          // agent (new + legacy)
          agentName: 1, agentPhone: 1, agentEmail: 1, agent: 1, agent_phone: 1, agent_email: 1,
          offerStatus: 1, deal: 1
      } }
    );

    const docs = await Property.aggregate(pipeline);

    const rows = docs.map((p) => {
      // prefer explicit listingPrice; else fall back to price
      let listingPrice = toNum(p.listingPrice ?? p.price);
 if (!(Number.isFinite(listingPrice) && listingPrice > 0)) {
   listingPrice = null;
 }
      const amv          = toNum(p.amv);

      // prefer stored helpers; else compute from listingPrice / amv
      const lp80  = toNum(p.lp80);
      const amv40 = toNum(p.amv40);
      const amv30 = toNum(p.amv30);

      const lp80Final  = lp80  ?? (listingPrice != null ? Math.round(listingPrice * 0.80) : null);
      const amv40Final = amv40 ?? (amv != null ? Math.round(amv * 0.40) : null);
      const amv30Final = amv30 ?? (amv != null ? Math.round(amv * 0.30) : null);

      const d = p.details || {};
      const beds  = toNum(d.beds  ?? p.beds);
      const baths = toNum(d.baths ?? p.baths);
      const sqft  = toNum(d.sqft  ?? p.sqft);

      return {
        _id: String(p._id),
        prop_id: p.prop_id || null,

        // address
        fullAddress: p.fullAddress || [p.address, p.city, p.state, p.zip].filter(Boolean).join(', '),
        address: p.address ?? null,
        city: p.city ?? null,
        state: p.state ?? null,
        zip: p.zip ?? null,

        // pricing/valuations (NEVER default to 0)
        listingPrice,
        amv,
        lp80: lp80Final,
        amv40: amv40Final,
        amv30: amv30Final,

        // vendor valuations for modal
        bofa_value: toNum(p.bofa_value),
        chase_value: toNum(p.chase_value),
        movoto_adjusted: toNum(p.movoto_adjusted),
        movoto_value: toNum(p.movoto_value ?? p.movoto_range_high),

        // details
        beds: Number.isFinite(beds) ? beds : null,
        baths: Number.isFinite(baths) ? baths : null,
        squareFeet: Number.isFinite(sqft) ? sqft : null,

        // agent (prefer camelCase)
        agentName:  p.agentName  ?? p.agent       ?? null,
        agentPhone: p.agentPhone ?? p.agent_phone ?? null,
        agentEmail: p.agentEmail ?? p.agent_email ?? null,

        offerStatus: p.offerStatus ?? null,
        deal: !!p.deal,
        updatedAt: p.updatedAt ?? null,
      };
    });

    // Your frontend supports either {rows} or raw array; return {rows} for clarity:
    res.status(200).json({ rows });
  } catch (error) {
    console.error('❌ /api/properties/table failed', error);
    res.status(500).json({ error: 'Failed to retrieve table data' });
  }
});

// --- PUT /api/properties/:id (edit ANY card field safely) ---
router.put('/:id', requireAuth, scopeByState(), async (req, res) => {
  try {
    const base = req.stateFilter || {};
    const idFilter = buildIdOrFilter(req.params.id);

    // Load document first (we support :id as ObjectId, prop_id, or fullAddress ci)
    const current = await Property.findOne({ ...base, ...idFilter }).lean();
    if (!current) return res.status(404).json({ error: 'Property not found' });

    // Map card fields -> controller's flexible updater
    const b = req.body || {};
    const payload = {
      // address fields
      ...(b.fullAddress != null ? { fullAddress: String(b.fullAddress) } : {}),
      ...(b.address     != null ? { address: String(b.address) }       : {}),
      ...(b.city        != null ? { city: String(b.city) }             : {}),
      ...(b.state       != null ? { state: String(b.state) }           : {}),
      ...(b.zip         != null ? { zip: String(b.zip) }               : {}),

      // pricing / valuations
      ...(b.listingPrice != null ? { price: b.listingPrice } : {}),
      ...(b.amv          != null ? { amv: b.amv }            : {}),
      ...(b.bofa_value   != null ? { bofa_value: b.bofa_value } : {}),
      ...(b.chase_value  != null ? { chase_value: b.chase_value } : {}),
      ...(b.movoto_adjusted   != null ? { movoto_adjusted: b.movoto_adjusted } : {}),
      ...(b.movoto_value      != null ? { movoto_range_high: b.movoto_value } : {}),

      // nested details
      details: {
        ...(b.beds        != null ? { beds: b.beds }     : {}),
        ...(b.baths       != null ? { baths: b.baths }   : {}),
        ...(b.squareFeet  != null ? { sqft: b.squareFeet }: {}),
        ...(b.built       != null ? { built: b.built }   : {}),
      },

      // agent
      ...(b.agentName  != null ? { agentName:  b.agentName }  : {}),
      ...(b.agentPhone != null ? { agentPhone: b.agentPhone } : {}),
      ...(b.agentEmail != null ? { agentEmail: b.agentEmail } : {}),
    };

    const updated = await updateProperty(current._id, payload);
    return res.json({ ok: true, id: updated._id, prop_id: updated.prop_id });
  } catch (e) {
    console.error('PUT /properties/:id failed', e);
    return res.status(500).json({ error: 'Failed to update property' });
  }
});

// --- DELETE /api/properties/:id ---
router.delete('/:id', requireAuth, scopeByState(), async (req, res) => {
  try {
    const base = req.stateFilter || {};
    const idFilter = buildIdOrFilter(req.params.id);

    const doc = await Property.findOneAndDelete({ ...base, ...idFilter }).lean();
    if (!doc) return res.status(404).json({ error: 'Property not found' });

    return res.status(204).send(); // frontend treats 204 as ok
  } catch (e) {
    console.error('DELETE /properties/:id failed', e);
    return res.status(500).json({ error: 'Failed to delete property' });
  }
});

export default router;