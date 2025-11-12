import 'dotenv/config';
import mongoose from 'mongoose';
import { runAllCities } from './redfin/runner.js';

async function connectMongo() {
  const uri = process.env.MONGO_URI || 'mongodb://localhost:27017/yourdb';
  mongoose.set('strictQuery', true);
  await mongoose.connect(uri, { serverSelectionTimeoutMS: 20000 });
  console.log('✅ Mongo connected');
}

try {
  await connectMongo();
  await runAllCities();
} catch (e) {
  console.error(e);
} finally {
  await mongoose.disconnect();
  process.exit(0);
}