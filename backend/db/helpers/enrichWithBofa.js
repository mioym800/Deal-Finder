import { Property } from '../models/propertyModel.js';
import { appendBofaValuesToProperties } from '../helpers.js';

const properties = await Property.find({ bofa_value: { $exists: false } }); // Or use a flag like `needs_enrichment: true`
const enriched = await appendBofaValuesToProperties(properties);

for (const p of enriched) {
  await Property.updateOne({ _id: p._id }, { $set: { 
    bofa_value: p.bofa_value,
    bofa_value_40: p.bofa_value_40,
    bofa_value_30: p.bofa_value_30,
    home_value_80: p.home_value_80,
    // ... any other enrichment
  }});
}