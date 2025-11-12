// backend/seedDeals.js
import dotenv from 'dotenv';
import mongoose from 'mongoose';
import connectDB from './db/db.js';
import Property from './models/Property.js';

dotenv.config();

const toId = (s) => new mongoose.Types.ObjectId(s);

const updates = [
  {
    _id: toId('68ddcf79f36ff7dadb1e290e'),
    beds: 3,
  baths: 2,
  sqft: 1620,
  },
];

(async () => {
  try {
    await connectDB();

    for (const u of updates) {
      const { _id, ...fields } = u;

      const $set = {
        ...fields,
        agent: fields.agentName ?? null,
        agent_email: fields.agentEmail ?? null,
        agent_phone: fields.agentPhone ?? null,
        agentEmailSent: fields.agentEmail ? false : null,
      };

      const res = await Property.updateOne({ _id }, { $set });
      console.log(
        `Updated ${_id.toString()}: matched=${res.matchedCount ?? res.n}, modified=${res.modifiedCount ?? res.nModified}`
      );
    }
  } catch (err) {
    console.error('Seeder error:', err);
    process.exitCode = 1;
  } finally {
    await mongoose.connection.close().catch(() => {});
  }
})();