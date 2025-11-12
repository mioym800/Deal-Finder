import mongoose from 'mongoose';

const PropertySchema = new mongoose.Schema({
  // Identity
  prop_id: { type: String, required: true, unique: true },

  // Addressing
  fullAddress:    { type: String, required: true },
  fullAddress_ci: { type: String, required: true, unique: true }, // normalized, case-insensitive dedupe
  address: { type: String, required: true },
  city:    { type: String, required: true },
  state:   { type: String, required: true }, // store 2-letter uppercase
  zip:     { type: String, default: '' },    // not always provided by source; allow empty string

  // Listing price (may be unknown at create time)
  price: { type: Number, default: null },

  // Listing details
  details: {
    beds:  { type: Number, default: null },
    baths: { type: Number, default: null },
    sqft:  { type: Number, default: null },
    built: { type: Number, default: null }, // ← add this if you want it
    _raw:  { type: mongoose.Schema.Types.Mixed, default: {} },
  },

  // Valuations (from vendors)
  // redfin_value/redfinPrice -> listing-derived estimate (legacy, mirrored)
  // redfin_avm_*             -> Redfin "What is my home worth" AVM results (new canonical for AMV)
  bofa_value:              { type: Number, default: null },
  redfinPrice:             { type: Number, default: null },           // legacy mirror of redfin_value
  redfin_value:            { type: Number, default: null },           // legacy canonical for listing-based estimate
  redfin_avm_value:        { type: Number, default: null },           // NEW: AVM numeric value
  redfin_avm_value_raw:    { type: String, default: null },           // e.g. "$216,023"
  redfin_avm_skip_reason:  { type: String, default: null },           // e.g. "NO_ESTIMATE", "NOT_FOUND", "NO_NAVIGATION"
  redfin_avm_skipped_at:   { type: Date, default: null },             // when we marked a skip
  redfin_avm_scraped_at:   { type: Date, default: null },             // when we saved a value

  // Aggregation
  amv:  { type: Number, default: null },                  // avg of available vendor values
  deal: { type: Boolean, default: false },                // price <= 0.50 * amv

  // Agent contact (Homes.com for DEALS)
  agent:       { type: String, default: null },
  agent_phone: { type: String, default: null },
  agent_email: { type: String, default: null },

  // Agent (normalized, camelCase) — used by enrich-agent + UI
  agentName:            { type: String, default: null },
  agentFirstName:       { type: String, default: null },
  agentLastName:        { type: String, default: null },
  agentPhone:           { type: String, default: null },
  agentEmail:           { type: String, default: null },
  agentCompany:         { type: String, default: null },
  agentEmailCandidates: { type: [String], default: [] },
  agentVerification:    { type: String, default: null }, // e.g. 'unverified' | 'verified'
  agentSources:         { type: [String], default: [] },
  agentDateChecked:     { type: String, default: null },

  // Media & misc
  images: { type: [String], default: [] },
  notes:  { type: [String], default: [] },


  // Optional legacy field; not required by spec
  tier: { type: String, enum: ['1', '2'], default: null },
}, { timestamps: true });

PropertySchema.index({ deal: 1, state: 1 });
PropertySchema.index({ createdAt: -1 });

// --- Agent field sync helpers (camelCase ↔️ snake_case) ---
const agentFieldPairs = [
  ['agent', 'agentName'],
  ['agent_phone', 'agentPhone'],
  ['agent_email', 'agentEmail'],
];

function normalizeAgentValue(v) {
  if (v == null) return null;
  if (typeof v === 'string') {
    const s = v.trim();
    if (!s) return null;
    if (s.toLowerCase() === 'not found') return null;
    return s;
  }
  return v;
}

function syncAgentFieldsDoc(doc) {
  // Prefer camelCase; mirror to snake_case. If only snake_case present, mirror to camelCase.
  for (const [snake, camel] of agentFieldPairs) {
    const camelVal = normalizeAgentValue(doc[camel]);
    const snakeVal = normalizeAgentValue(doc[snake]);

    if (camelVal != null) {
      doc[camel] = camelVal;
      doc[snake] = camelVal;
    } else if (snakeVal != null) {
      doc[camel] = snakeVal;
      doc[snake] = snakeVal;
    } else {
      doc[camel] = null;
      doc[snake] = null;
    }
  }
}

function syncAgentFieldsUpdate(update) {
  // Ensure $set exists for mirroring values
  update.$set = update.$set || {};
  const set = update.$set;

  for (const [snake, camel] of agentFieldPairs) {
    const hasCamel = Object.prototype.hasOwnProperty.call(set, camel);
    const hasSnake = Object.prototype.hasOwnProperty.call(set, snake);

    if (hasCamel) {
      const val = normalizeAgentValue(set[camel]);
      set[camel] = val;
      set[snake] = val;
    } else if (hasSnake) {
      const val = normalizeAgentValue(set[snake]);
      set[snake] = val;
      set[camel] = val;
    }
  }
}
// --- Redfin field sync (canonical: redfin_value; mirror legacy redfinPrice) ---
function toNum(v) {
  if (typeof v === 'number' && Number.isFinite(v)) return v;
  if (typeof v === 'string') {
    const n = Number(v.replace(/[^0-9.\-]/g, ''));
    return Number.isFinite(n) ? n : null;
  }
  return null;
}

function syncRedfinFieldsDoc(doc) {
  const canonical = toNum(doc.redfin_value);
  const legacy    = toNum(doc.redfinPrice);

  if (canonical != null) {
    doc.redfin_value = canonical;
    doc.redfinPrice  = canonical; // mirror for old readers
  } else if (legacy != null) {
    doc.redfin_value = legacy;    // prefer canonical
    doc.redfinPrice  = legacy;
  } else {
    doc.redfin_value = null;
    doc.redfinPrice  = null;
  }
}

function syncRedfinFieldsUpdate(update) {
  update.$set = update.$set || {};
  const set = update.$set;

  const hasCanonical = Object.prototype.hasOwnProperty.call(set, 'redfin_value');
  const hasLegacy    = Object.prototype.hasOwnProperty.call(set, 'redfinPrice');

  if (hasCanonical) {
    const v = toNum(set.redfin_value);
    set.redfin_value = v;
    set.redfinPrice  = v;
  } else if (hasLegacy) {
    const v = toNum(set.redfinPrice);
    set.redfinPrice  = v;
    set.redfin_value = v;
  }
}

// Normalization hooks
PropertySchema.pre('validate', function(next) {
  syncAgentFieldsDoc(this);
  syncRedfinFieldsDoc(this);
  if (this.fullAddress) {
    this.fullAddress = String(this.fullAddress).trim();
    this.fullAddress_ci = this.fullAddress.toLowerCase();
  }
  if (typeof this.state === 'string') {
    this.state = this.state.trim().toUpperCase();
  }
  next();
});

PropertySchema.pre('save', function(next) {
  syncAgentFieldsDoc(this);
  syncRedfinFieldsDoc(this);
  if (this.fullAddress && !this.fullAddress_ci) {
    this.fullAddress_ci = this.fullAddress.trim().toLowerCase();
  }
  if (typeof this.state === 'string') this.state = this.state.trim().toUpperCase();
  next();
});

// Keep agent fields in sync for update operations that bypass .save()
PropertySchema.pre(['findOneAndUpdate', 'updateOne', 'updateMany'], function(next) {
  const update = this.getUpdate() || {};
  syncAgentFieldsUpdate(update);
  syncRedfinFieldsUpdate(update);
  this.setUpdate(update);
  next();
});

// --- AMV (canonical): average of available { bofa_value, redfin_avm_value } ---
export function computeAMV({ bofa_value = null, redfin_avm_value = null } = {}) {
  const vals = [];
  const b = toNum(bofa_value);
  const r = toNum(redfin_avm_value);
  if (b != null) vals.push(b);
  if (r != null) vals.push(r);
  if (!vals.length) return null;
  return Math.round(vals.reduce((a, c) => a + c, 0) / vals.length);
}
PropertySchema.statics.computeAMV = computeAMV;

const Property = mongoose.model('Property', PropertySchema);
export default Property;