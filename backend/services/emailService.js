// backend/services/emailService.js
// Composes + sends Agent Offers with robust fallbacks.

import axios from 'axios';
import Mustache from 'mustache';
import fs from 'fs/promises';
import path from 'path';
import { fileURLToPath } from 'url';

// ---------- price computation (robust; no $0 fallbacks) ----------
export function computeOfferPrice(property, override) {
  if (typeof override === 'number' && isFinite(override) && override > 0) return Math.round(override);

  const lp  = Number(property?.offerAmount ?? property?.listPrice ?? property?.price ?? NaN);
  const amv = Number(property?.amv ?? NaN);

  // Preferred rule: lowest of 80% LP and 40% AMV
  const lp80  = Number.isFinite(lp)  && lp > 0 ? lp * 0.80 : Infinity;
  const amv40 = Number.isFinite(amv) && amv > 0 ? amv * 0.40 : Infinity;

  const candidate = Math.min(lp80, amv40);
  if (!Number.isFinite(candidate) || candidate === Infinity) return null; // signal "TBD"
  return Math.round(candidate);
}

// ---------- sender with fallback (no hard dependency on ../email.js) ----------
let _localSender = null;
async function getLocalSender() {
  if (_localSender !== null) return _localSender;
  try {
    const mod = await import('../email.js'); // optional module; only if you actually have it
    const fn = mod.sendAgentEmail || mod.default || null;
    _localSender = typeof fn === 'function' ? fn : null;
  } catch {
    _localSender = null;
  }
  return _localSender;
}

export async function sendAgentEmail(payload) {
  const local = await getLocalSender();
  if (local) return local(payload);

  // HTTP fallback to your existing route
  const port = process.env.PORT || 3015;
  const base = process.env.PUBLIC_BASE_URL || `http://127.0.0.1:${port}`;
  const url = `${base}/email/send-email`;
  const res = await axios.post(url, payload, {
    headers: { 'Content-Type': 'application/json' },
    timeout: 15000,
  });
  return res?.data || { ok: true };
}

// ---------- templates: resolve with multiple fallbacks ----------
function candidateTemplateDirs() {
  const thisFile = fileURLToPath(import.meta.url);
  const here = path.dirname(thisFile);
  return [
    path.resolve(here, '..', 'templates'),                 // backend/templates
    path.resolve(here, '..', 'vendors', 'templates'),      // backend/vendors/templates
    path.resolve(here, '..', 'vendors'),                   // backend/vendors
    process.cwd(),                                         // repo root
  ];
}

async function loadTemplate(templateName, asText = false) {
  const names = Array.isArray(templateName) ? templateName : [templateName];
  const exts = asText ? ['.txt'] : ['.html'];
  const dirs = candidateTemplateDirs();

  for (const n of names) {
    const base = n.replace(/\.(html|txt)$/i, '');
    for (const d of dirs) {
      for (const ext of exts) {
        const p = path.join(d, base + ext);
        try {
          const c = await fs.readFile(p, 'utf8');
          return c;
        } catch {}
      }
    }
  }
  // Minimal fallback
  return asText
    ? `OFFER TO PURCHASE\nDate: {{date}}\nAgent Name: {{agent_name}}\nAddress: {{property_address}}\nOffer Price: {{offer_price}}\nEMD: {{emd}}\nTerms: {{terms}}\nSent by {{reply_to}} via Mioym Deal Finder.`
    : `<h2>OFFER TO PURCHASE</h2>\n<p><b>Date:</b> {{date}}</p>\n<p><b>Agent Name:</b> {{agent_name}}</p>\n<p><b>Subject Address:</b> {{property_address}}</p>\n<p><b>Offer Price:</b> {{offer_price}}</p>\n<p><b>EMD:</b> {{emd}}</p>\n<p><b>Terms:</b> {{terms}}</p>\n<p>This offer was sent by {{reply_to}} via Mioym Deal Finder.</p>`;
}

function normalizeAgentFields(property = {}) {
  return {
    agentEmail: property.agentEmail || property.agent_email || '',
    agentName:  property.agentName  || property.agent      || '',
  };
}

export async function composeOfferPayload({ to, from, replyTo, subject, template, variables, property, subadmin, offerPrice }) {
  // Allow call with only property/subadmin
  const { agentEmail, agentName } = normalizeAgentFields(property || {});
  const _to = to || agentEmail;
  if (!_to) throw new Error('agent email missing (to)');

  const _from = from
    || (subadmin?.email ? `${subadmin?.name || subadmin.email} <${subadmin.email}>` : null)
    || process.env.SMTP_FROM
    || 'Mioym Deal Finder <no-reply@mioym.com>';

  const computed = computeOfferPrice(property || {}, offerPrice);
  const pretty = computed != null ? `$${computed.toLocaleString('en-US')}` : '';

  const htmlTpl = await loadTemplate(template || 'agent_offer_v1.html');
  const txtTpl  = await loadTemplate(template || 'agent_offer_v1.txt', true);

  const defaults = {
    date: new Date().toISOString().slice(0, 10),
    agent_name: agentName || 'Listing Agent',
    property_address: property?.fullAddress || '',
    offer_price: pretty,
    emd: '$5,000',
    terms: 'As-is, cash, 7–10 day close',
    reply_to: replyTo || subadmin?.email || '',
  };
  const vars = { ...defaults, ...(variables || {}) };

  return {
    to: _to,
    from: _from,
    replyTo: vars.reply_to || undefined,
    subject: subject || `Offer to Purchase — ${property?.fullAddress || ''}`,
    html: Mustache.render(htmlTpl, vars),
    text: Mustache.render(txtTpl, vars),
    headers: { 'List-Unsubscribe': '<mailto:unsubscribe@livemarketdeals.com>' },
  };
}

// New universal signature
// sendOffer({ to, from, replyTo, subject, template, variables, property, subadmin })
// OR legacy: sendOffer({ property, subadmin })
export async function sendOffer(args) {
  // Legacy shape detection
  const legacy = args && args.property && !('to' in args);

  if (legacy) {
    const { property, subadmin } = args;
    const offerPrice = computeOfferPrice(property);
    if (offerPrice == null) throw new Error('Cannot compute offer price (need valid listPrice/offerAmount or AMV)');
    const payload = await composeOfferPayload({ property, subadmin, offerPrice });
    return sendAgentEmail(payload);
  }

  // New shape
  const payload = await composeOfferPayload(args);
  return sendAgentEmail(payload);
}

export default { sendOffer, computeOfferPrice, composeOfferPayload, sendAgentEmail };