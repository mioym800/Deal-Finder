// ESM – Human-in-the-loop Realtor capture
// Run: node vendors/realtor/realtorManual.js
// Flow:
//  - Finds properties missing or stale `realtor_value`
//  - Opens Realtor search in your default browser
//  - Prompts you to paste RealEstimate/price (or 's' to skip, 'q' to quit)
//  - Saves value + metadata to Mongo

import "dotenv/config.js";
import { MongoClient } from "mongodb";
import open from "open";
import readline from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";

/* -------------------- CONFIG -------------------- */
const {
  MONGO_URI,
  MONGO_DB = "deal_finder",
  MONGO_COLLECTION = "properties",
  LIMIT = "50",
  START_SKIP = "0",
} = process.env;

if (!MONGO_URI) {
  console.error("Missing MONGO_URI in .env");
  process.exit(1);
}

/* -------------------- HELPERS -------------------- */
function normalizeAddress(doc) {
  if (doc.fullAddress) return doc.fullAddress;
  const street = doc.address || doc.street || "";
  const parts = [street, doc.city, doc.state, doc.zip].filter(Boolean);
  return parts.join(", ");
}

function parseCurrencyToNumber(text) {
  if (!text) return null;
  const cleaned = ("" + text).replace(/[^\d.]/g, "");
  return cleaned ? Number(cleaned) : null;
}

function realtorSearchUrl(address) {
  // Use generic search (works better than "myhome" for manual lookups)
  // Encodes spaces as '-' for nicer URLs, but plain encodeURIComponent also works.
  const pretty = address.replace(/\s+/g, "-");
  return `https://www.realtor.com/realestateandhomes-search/${encodeURIComponent(pretty)}`;
}

/* -------------------- MAIN -------------------- */
async function run() {
  const limit = parseInt(LIMIT, 10) || 50;
  const skip = parseInt(START_SKIP, 10) || 0;

  const client = new MongoClient(MONGO_URI);
  await client.connect();
  const col = client.db(MONGO_DB).collection(MONGO_COLLECTION);

  const THIRTY_DAYS = 30 * 24 * 3600 * 1000;
  const filter = {
    $or: [
      { realtor_value: { $exists: false } },
      { realtor_value: null },
      { "realtor_meta.lastChecked": { $lt: new Date(Date.now() - THIRTY_DAYS) } },
    ],
  };

  const docs = await col.find(filter).skip(skip).limit(limit).toArray();
  if (!docs.length) {
    console.log("No matching properties found for update.");
    await client.close();
    return;
  }

  const rl = readline.createInterface({ input, output });
  console.log(`\nReady to capture Realtor values for ${docs.length} properties.`);
  console.log("Commands: paste price (e.g., $201,000) | 's' skip | 'q' quit\n");

  try {
    for (const doc of docs) {
      const _id = doc._id;
      const addr = normalizeAddress(doc);
      if (!addr) {
        console.log(`[SKIP] ${_id} missing address fields`);
        continue;
      }

      const url = realtorSearchUrl(addr);
      console.log(`\n[OPEN] ${_id} :: ${addr}`);
      console.log(`       ${url}`);

      // Open in user's default browser (non-automated)
      await open(url);

      // Prompt for input
      const answer = (await rl.question("Paste RealEstimate/price (or 's' skip, 'q' quit): ")).trim();

      if (answer.toLowerCase() === "q") {
        console.log("Quitting.");
        break;
      }
      if (answer.toLowerCase() === "s" || answer === "") {
        // Mark as deferred so we don't reopen immediately on next run
        await col.updateOne(
          { _id },
          {
            $set: {
              "realtor_meta.lastChecked": new Date(),
              "realtor_meta.status": "deferred",
              "realtor_meta.url_last_opened": url,
            },
          }
        );
        console.log(`[DEFER] ${_id}`);
        continue;
      }

      const value = parseCurrencyToNumber(answer);
      if (!value) {
        await col.updateOne(
          { _id },
          {
            $set: {
              "realtor_meta.lastChecked": new Date(),
              "realtor_meta.status": "error",
              "realtor_meta.error": `parse_fail(${answer})`,
              "realtor_meta.url_last_opened": url,
            },
          }
        );
        console.log(`[FAIL] ${_id} – could not parse "${answer}"`);
        continue;
      }

      await col.updateOne(
        { _id },
        {
          $set: {
            realtor_value: value,
            "realtor_meta.rawText": answer,
            "realtor_meta.lastChecked": new Date(),
            "realtor_meta.source": "realtor_manual",
            "realtor_meta.status": "ok",
            "realtor_meta.url_last_opened": url,
          },
        }
      );
      console.log(`[OK] ${_id} -> ${answer}`);
    }
  } finally {
    rl.close();
    await client.close();
  }

  console.log("\nDone.\n");
}

run().catch((e) => {
  console.error("Fatal error:", e);
  process.exit(1);
});