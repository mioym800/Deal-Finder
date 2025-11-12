// backend/models/rawProperty.js
import mongoose from 'mongoose';
const { Schema, model } = mongoose;

const rawPropertySchema = new Schema(
  {
    fullAddress: { type: String, required: true, unique: true },
    address: { type: String, required: true },
    city: { type: String, default: '' },
    state: { type: String, default: '' },
    zip: { type: String, default: '' },
    price: { type: Number, default: null },
    details: { type: Schema.Types.Mixed, default: {} },
    bofa_value: { type: Number, default: null },
    chase_value: { type: Number, default: null },
    redfinPrice:       { type: Number, default: null },
    chasePrice:        { type: Number, default: null },
    amv: { type: Number, default: null },
    agent_name:  { type: String, default: null },
    agent_email: { type: String, default: null },
    status: {
      type: String,
      enum: [
        'scraped',
        'valued',
        'archived',
        'error',
        'checked',
        'not_found',
        'no_tier_or_spread',
        'bofa_no_data',
        'bofa_network_error',
        'bofa_error',
        'homes_ok',
        'homes_blocked',
        'homes_network_error',
        'homes_parsing_error'
      ],
      default: 'scraped',
    },
    scrapedAt: { type: Date, default: Date.now },
  },
  { timestamps: true }
);

export default model('RawProperty', rawPropertySchema);