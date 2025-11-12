import mongoose from 'mongoose';

const MONGO_URI = 'mongodb://localhost:27017/deal_finder'; // Replace with your URI

async function cleanIndexes() {
  try {
    await mongoose.connect(MONGO_URI);

    const indexes = await mongoose.connection.db.collection('users').indexes();
    console.log('Current indexes on users:', indexes);

    const badIndex = indexes.find((i) => i.name === 'id_1');
    if (badIndex) {
      console.log('Dropping bad index: id_1...');
      await mongoose.connection.db.collection('users').dropIndex('id_1');
      console.log('Dropped index successfully.');
    } else {
      console.log('No problematic id_1 index found.');
    }

    await mongoose.disconnect();
  } catch (err) {
    console.error('Error cleaning indexes:', err);
    process.exit(1);
  }
}

cleanIndexes();