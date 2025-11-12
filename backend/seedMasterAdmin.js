// backend/scripts/auditListPrice.js
import 'dotenv/config';
import mongoose from 'mongoose';
import Property from './models/Property.js';

const toNum = (v) => {
  if (v == null) return null;
  if (typeof v === 'number' && isFinite(v) && v > 0) return v;
  const s = String(v).replace(/\$/g, '').replace(/,/g, '').trim();
  const n = Number(s);
  return isFinite(n) && n > 0 ? n : null;
};

const pickLP = (r) => {
  const cand = [
    r.listingPrice, r.price, r.listPrice, r.list_price, r.lp,
    r.askingPrice, r.asking_price, r.askPrice, r.listprice,
    r.currentListPrice, r.originalListPrice
  ];
  for (const v of cand) {
    const n = toNum(v);
    if (n) return n;
  }
  // derive from lp80 if present (UI does not *display* this as LP, but useful for auditing)
  const lp80 = toNum(r.lp80);
  if (lp80) return Math.round(lp80 / 0.8);
  return null;
};

(async () => {
  await mongoose.connect(process.env.MONGO_URI);
  const docs = await Property.find(/* { deal: true } */).limit(5000).lean();

  let missing = 0, present = 0;
  for (const r of docs) {
    const lp = pickLP(r);
    if (lp == null) {
      missing++;
      console.log('NO-LP:', (r.fullAddress || r.address || r._id), {
        listingPrice: r.listingPrice, price: r.price, listPrice: r.listPrice,
        list_price: r.list_price, lp: r.lp, lp80: r.lp80
      });
    } else {
      present++;
    }
  }
  console.log({ present, missing, total: present + missing });
  await mongoose.disconnect();
})();