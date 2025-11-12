import { createProperty, updateProperty, getProperties } from '../controllers/propertyController.js';
import connectDB from '../db/db.js';
import { calculateFortyPercent, calculateThirtyPercent, parsePrice } from '../helpers.js';

connectDB();


const updateMissingPropertiesData = async () => {
  try {
    const properties = await getProperties();
    console.log(`Found ${properties.length} properties to update`);

    for (const property of properties) {
      const numericBofa = parsePrice(property.bofa_value);
      if (!property.bofa_value_40 || !property.bofa_value_30) {
        console.log(`Updating missing data for property: ${property.fullAddress}`);
        const updatedData = {
          bofa_value_40: calculateFortyPercent(numericBofa),
          bofa_value_30: calculateThirtyPercent(numericBofa),
        };
        await updateProperty(property._id, updatedData);
        console.log(`Updated property ${property.fullAddress} with agent name and phone`);
      } else {
        console.log(`Property ${property.fullAddress} already has agent data`);
      }
    }
  } catch (error) {
    console.error('Error updating properties:', error);
  }
}

// await updateMissingPropertiesData();