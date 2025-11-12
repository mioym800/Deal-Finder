// ESM script to copy redfinPrice -> redfin_value when target is null

import 'dotenv/config';
import mongoose from 'mongoose';

// NOTE: from vendors/redfin -> up two levels to models
import Property from '../../models/Property.js';

const MONGO_URI = process.env.MONGO_URI || 'mongodb://localhost:27017/real-estate';

async function main() {
  await mongoose.connect(MONGO_URI, { autoIndex: false });

  // Only migrate docs that have redfinPrice AND lack redfin_value
  const cursor = Property.find({
    $and: [
      { redfinPrice: { $ne: null } },
      { $or: [{ redfin_value: null }, { redfin_value: { $exists: false } }] }
    ]
  }).cursor();

  let migrated = 0;
  for await (const doc of cursor) {
    doc.redfin_value = doc.redfinPrice;
    await doc.save();
    migrated++;
  }

  console.log(`Migrated ${migrated} docs (redfinPrice -> redfin_value).`);
}

main()
  .then(() => mongoose.disconnect())
  .catch(async (err) => {
    console.error('Migration failed:', err);
    try { await mongoose.disconnect(); } catch {}
    process.exit(1);
  });