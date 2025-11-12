import mongoose from 'mongoose';
import dotenv from 'dotenv';
import { log } from '../utils/logger.js';

dotenv.config();

const L = log.child('db');

const dbURI = process.env.MONGO_URI || 'mongodb://localhost:27017/deal_finder';

const connectDB = async () => {
  try {
    if (mongoose.connection.readyState === 1) {
      L.info('MongoDB already connected', { db: mongoose.connection.name });
      return;
    }

    L.start('Connecting to MongoDB…');
    await mongoose.connect(dbURI, {
      serverSelectionTimeoutMS: 30000, // Increase timeout to 30 seconds
    });

    const { name } = mongoose.connection;
    L.success('MongoDB connected successfully', { db: name });
  } catch (err) {
    L.error('MongoDB connection error', { error: err.message });
    if (err && err.stack) {
      // debug stack when available
      log.debug('MongoDB connection stack', { stack: err.stack });
    }
    // Do NOT exit; allow caller/guards to decide next steps
    return null;
  }
};

export default connectDB;