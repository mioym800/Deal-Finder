// backend/services/enrichAgentService.js
import axios from 'axios';
import * as propertyService from '../db/helpers/propertyService.js';

// NOTE: Enrichment is LLM-only; no web or SERP. It relies on model priors and DB persistence only.


// OpenAI Responses API (LLM-only; no live web)
const OPENAI_URL = 'https://api.openai.com/v1/responses';
const MODEL = process.env.OPENAI_MODEL || 'gpt-4.1';

// --- helpers (your originals with tiny tweaks) ---
function slugifyLetters(s = '') {
  return (s || '').toLowerCase().normalize('NFKD').replace(/[^a-z]/g, '');
}

function deriveDomainFromCompany(companyRaw = '') {
  if (!companyRaw) return null;
  const lower = companyRaw.trim().toLowerCase();
  const domainLike = lower.match(/\b([a-z0-9-]+\.)+[a-z]{2,}\b/);
  if (domainLike) return domainLike[0].replace(/^https?:\/\//, '').replace(/^www\./, '');
  const stop = new Set(['real', 'estate', 'realty', 'realtors', 'group', 'company', 'co', 'inc', 'llc', 'llp', 'properties', 'prop', 'brokerage', 'the']);
  const tokens = lower.split(/[^a-z0-9]+/).filter(Boolean).filter(t => !stop.has(t));
  if (!tokens.length) return null;
  return tokens.join('') + '.com';
}

function buildEmailCandidates(firstRaw, lastRaw, companyRaw) {
  const first = slugifyLetters(firstRaw);
  const last = slugifyLetters(lastRaw);
  const domain = deriveDomainFromCompany(companyRaw);
  if (!first || !last || !domain) return [];
  const fi = first[0], li = last[0];
  return [
    `${fi}${last}@${domain}`,
    `${first}${li}@${domain}`,
    `${first}@${domain}`,
    `${last}@${domain}`,
  ];
}


// --- light address normalization (same spirit as your earlier code) ---
function normalizeAddressTokens(addr = '') {
  let s = String(addr || '').replace(/\s+/g, ' ').trim();
  s = s.replace(/,\s*([A-Za-z]{2})\s+(\d{5}(?:-\d{4})?)/, (_, st, zip) => `, ${st.toUpperCase()} ${zip}`);
  s = s.replace(/\b(nw|ne|sw|se|n|s|e|w)\b/gi, (m) => m.toUpperCase());
  s = s.split(' ').map(tok => (/^[A-Z]{2,}$/.test(tok) ? tok : (tok.charAt(0).toUpperCase() + tok.slice(1).toLowerCase()))).join(' ');
  return s;
}

function toNull(v) {
  if (v == null) return null;
  const s = String(v).trim();
  // Keep the literal "Not found" so we can see what the model returned in DB.
  // Only coerce truly empty strings to null.
  if (!s) return null;
  return s;
}



// ChatGPT-only mode: no web search/evidence is fetched by this service.

/**
 * ChatGPT-only enrichment:
 * - No external web calls (no SERP/Bing, no scraping).
 * - The model must return "Not found" for unverifiable fields.
 */
async function callOpenAIJson(prompt, { maxRetries = 3 } = {}) {
const payload = {
  model: MODEL,
  // Responses API accepts either a string or a message array.
  // Using messages keeps it future-proof.
  input: [
    {
      role: 'user',
      content: [
        { type: 'input_text', text: prompt }
      ]
    }
  ],
  max_output_tokens: 900,
  // ✅ Correct location for JSON schema in Responses API
  text: {
    format: {
      type: 'json_schema',
      name: 'AgentInfo',
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          agentName:      { type: 'string' },
          agentFirstName: { type: 'string' },
          agentLastName:  { type: 'string' },
          agentPhone:     { type: 'string' },
          agentEmail:     { type: 'string' },
          agentCompany:   { type: 'string' },
          sources:        { type: 'array', items: { type: 'string' }, default: [] },
          dateChecked:    { type: 'string' }
        },
        required: [
          'agentName','agentFirstName','agentLastName',
          'agentPhone','agentEmail','agentCompany',
          'sources','dateChecked'
        ]
      }
    }
  }
};
  let lastErr;
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      const { data } = await axios.post(OPENAI_URL, payload, {
        headers: { Authorization: `Bearer ${process.env.OPENAI_API_KEY}`, 'Content-Type': 'application/json' },
        timeout: 60000
      });

      // Prefer parsed JSON if present; otherwise parse output_text.
      const content = data?.output?.[0]?.content;
      const jsonPart = Array.isArray(content) ? content.find(c => c?.type === 'output_json' && c?.parsed) : null;
      if (jsonPart?.parsed) return jsonPart.parsed;

      const text = data?.output_text
        ?? (Array.isArray(content) ? content.find(c => c?.type === 'output_text')?.text : undefined)
        ?? data?.choices?.[0]?.message?.content
        ?? '{}';

      try { return typeof text === 'string' ? JSON.parse(text) : (text || {}); }
      catch { return {}; }
    } catch (e) {
      lastErr = e;
      const status = e?.response?.status;
      // Backoff on rate limits or transient 5xx
      if (status === 429 || (status >= 500 && status < 600)) {
        const wait = Math.min(2000 * attempt, 8000);
        await new Promise(r => setTimeout(r, wait));
        continue;
      }
      // 400 typically means schema/input issue; bubble immediately
      throw e;
    }
  }
  throw lastErr || new Error('OpenAI call failed');
}

export async function enrichAgentForProperty({ id, fullAddress }) {
  if (!id || !fullAddress) throw new Error('id and fullAddress are required');
  if (!process.env.OPENAI_API_KEY) throw new Error('OPENAI_API_KEY missing');

  const addr = normalizeAddressTokens(fullAddress);

  const prompt = `
You are a Real Estate Data Detective.

Address: ${addr}

IMPORTANT:
- You have no live web access.
- Provide your **best-guess** details based on your priors; if truly unknown, use an empty string "".
- Do not fabricate URLs; \`sources\` will normally be empty in this mode.
- Provide ISO date in \`dateChecked\`.

Return strict JSON with these fields:
- agentName (string or "")
- agentFirstName (string or "")
- agentLastName (string or "")
- agentPhone (string or "")
- agentEmail (string or "")
- agentCompany (string or "")
- sources (array of URLs, likely empty here)
- dateChecked (ISO date)
`;

  // 1) Ask the model (no web)
  let parsed = {};
  try {
    parsed = await callOpenAIJson(prompt, { maxRetries: 3 });
  } catch (e) {
    console.warn('[enrich] OpenAI call failed:', e?.response?.data || e?.message || e);
    parsed = {};
  }

  // Ensure sources is always an array (ChatGPT-only path usually has none)
  if (!Array.isArray(parsed.sources)) parsed.sources = [];

  // 2) Fill first/last if only full name present
  if ((!parsed.agentFirstName || !parsed.agentLastName) && parsed.agentName) {
    const parts = String(parsed.agentName).trim().split(/\s+/);
    if (parts.length >= 2) {
      parsed.agentFirstName = parsed.agentFirstName || parts[0];
      parsed.agentLastName  = parsed.agentLastName  || parts[parts.length - 1];
    }
  }

  // 3) Build email candidates if email missing but we have some name/company
  let emailCandidates = [];
  if (!parsed.agentEmail && (parsed.agentCompany || parsed.agentName)) {
    const first = parsed.agentFirstName || (parsed.agentName ? parsed.agentName.split(/\s+/)[0] : '');
    const last  = parsed.agentLastName  || (parsed.agentName ? parsed.agentName.split(/\s+/).slice(-1)[0] : '');
    emailCandidates = buildEmailCandidates(first, last, parsed.agentCompany);
  }

  if (emailCandidates.length) {
    const seen = new Set();
    emailCandidates = emailCandidates
      .map(e => String(e).trim().toLowerCase())
      .filter(e => (seen.has(e) ? false : seen.add(e)));
  }

  // 4) Coerce to DB format
  const updatePayload = {
    agentName:            toNull(parsed.agentName),
    agentFirstName:       toNull(parsed.agentFirstName),
    agentLastName:        toNull(parsed.agentLastName),
    agentPhone:           toNull(parsed.agentPhone),
    agentEmail:           toNull(parsed.agentEmail),
    agentCompany:         toNull(parsed.agentCompany),
    agentEmailCandidates: emailCandidates.length ? emailCandidates : null,
    agentSources:         Array.isArray(parsed.sources) && parsed.sources.length ? parsed.sources : null,
    agentDateChecked:     toNull(parsed.dateChecked),
  };

  // Debug log before upserting agent info
  console.debug('[enrich] Upserting agent info', { id, addr, updatePayload });

  // 5) Persist by id if available, else by address
  let updated;
  if (propertyService.updatePropertyAgentInfoById) {
    updated = await propertyService.updatePropertyAgentInfoById(id, updatePayload);
  } else {
    updated = await propertyService.updatePropertyAgentInfo(fullAddress, updatePayload);
  }

  return { updated, parsed, emailCandidates, evidenceUrls: [] };
}