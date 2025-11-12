// backend/controllers/agentOffersController.js
import mongoose from 'mongoose';
import AgentSend from '../models/AgentSend.js';
import connectDB from '../db/db.js';
import runAgentOffers from '../vendors/agent_offers.js';
import { sendOffer } from '../services/emailService.js';

// --- unified money parsing + UI-matching offer calc ---
const toNum = (v) => {
  if (v == null) return null;
  if (typeof v === 'number') return Number.isFinite(v) ? v : null;
  if (typeof v === 'string') {
    const n = Number(v.replace(/[$,]/g, '').trim());
    return Number.isFinite(n) ? n : null;
  }
  if (typeof v === 'object') {
    if ('$numberInt' in v) return Number(v.$numberInt);
    if ('$numberLong' in v) return Number(v.$numberLong);
    if ('$numberDouble' in v) return Number(v.$numberDouble);
  }
  return null;
};

/**
 * Compute offer to match UI: min(LP*0.80, AMV*0.40).
 * Falls back gracefully if one input is missing.
 */
function computeOfferFrom(doc = {}) {
  const lp  = toNum(doc.listingPrice ?? doc.price ?? doc.listPrice ?? doc.list_price ?? doc.lp);
  const amv = toNum(doc.amv);

  const lp80  = (typeof toNum(doc.lp80)  === 'number') ? toNum(doc.lp80)  : (typeof lp === 'number'  ? Math.round(lp  * 0.80) : null);
  const amv40 = (typeof toNum(doc.amv40) === 'number') ? toNum(doc.amv40) : (typeof amv === 'number' ? Math.round(amv * 0.40) : null);

  let offer = null;
  if (typeof lp80 === 'number' && typeof amv40 === 'number') offer = Math.min(lp80, amv40);
  else if (typeof lp80 === 'number') offer = lp80;
  else if (typeof amv40 === 'number') offer = amv40;

  return { offer, lp, amv, lp80, amv40 };
}

function parseDateOrNull(v) {
  if (!v) return null;
  const d = new Date(v);
  return Number.isFinite(d.getTime()) ? d : null;
}

function isSubadmin(u) {
  return /subadmin/i.test(String(u?.role || ''));
}
// ADD: sendNow — save agent details on the property and send the email immediately
export async function sendNow(req, res) {
  try {
    await connectDB();

    const user = req.user;
    if (!user) return res.status(401).json({ ok:false, error: 'Unauthorized' });

    const { propertyId: rawId } = req.params;
    const { agentName = '', agentPhone = '', agentEmail = '', fullAddress: bodyAddr = '' } = req.body || {};

    if (!agentEmail) {
      return res.status(400).json({ ok:false, error: 'agentEmail required' });
    }

    const propertyId = decodeURIComponent(String(rawId || ''));

    const propsCol = mongoose.connection.collection('properties');

    // Resolve property by _id OR by address
    let prop = null;
    if (mongoose.isValidObjectId(propertyId)) {
      prop = await propsCol.findOne(
        { _id: new mongoose.Types.ObjectId(propertyId) },
        { projection: { _id: 1, fullAddress: 1, state: 1, listingPrice: 1, price: 1, amv: 1, lp80: 1, amv40: 1, offerAmount: 1 } }
      );
    }
    if (!prop) {
      // Try exact fullAddress match, then plain address
      const addrCand = (bodyAddr || propertyId || '').trim();
      if (addrCand) {
        prop = await propsCol.findOne(
          { $or: [ { fullAddress: addrCand }, { address: addrCand } ] },
          { projection: { _id: 1, fullAddress: 1, state: 1, listingPrice: 1, price: 1, amv: 1, lp80: 1, amv40: 1, offerAmount: 1 } }
        );
      }
    }

    if (!prop) {
      return res.status(404).json({ ok:false, error: 'Property not found (tried id/address lookup)' });
    }

    // Subadmin state-scope enforcement
    const isSubadmin = /subadmin/i.test(String(user?.role || ''));
    if (isSubadmin) {
      const userStates = Array.isArray(user.states) ? user.states : [];
      if (!userStates.includes(prop.state)) {
        return res.status(403).json({ ok:false, error: 'Forbidden: outside your states' });
      }
    }

    // Save agent details on the property
    await propsCol.updateOne(
      { _id: prop._id },
      {
        $set: {
          agentName, agentPhone, agentEmail,
          agent_email: agentEmail,
          updatedAt: new Date(),
        },
      }
    );

    // Log send
    const record = await AgentSend.create({
      propertyId: prop._id,
      subadminId: user._id,
      agentEmail,
      status: 'queued',
      templateVersion: 'agent_offer_v1',
    });

    const { offer: offerPrice, lp, amv, lp80, amv40 } = computeOfferFrom(prop);

    console.log('[agent-offers] sendNow inputs', {
      id: String(prop._id),
      address: prop.fullAddress || '',
      listingPrice: lp, amv, lp80, amv40, offerPrice
    });

    const result = await sendOffer({
      to: agentEmail,
      from: `${user.name || user.email} <${user.email}>`,
      replyTo: user.email,
      subject: `Offer to Purchase — ${prop.fullAddress || ''}`,
      template: 'agent_offer_v1.html',
      variables: {
        date: new Date().toISOString().slice(0, 10),
        agent_name: agentName || '',
        property_address: prop.fullAddress || '',
        offer_price: (typeof offerPrice === 'number') ? new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 0 }).format(offerPrice) : '',
        emd: '$5,000',
        terms: 'As-is, cash, 7–10 day close',
        reply_to: user.email,
      },
      property: prop,
      subadmin: user,
    });

    await AgentSend.findByIdAndUpdate(record._id, {
      status: 'sent',
      messageId: result?.messageId || null,
    });

    await propsCol.updateOne(
      { _id: prop._id },
      {
        $set: {
          offerStatus: {
            lastSentAt: new Date(),
            subadminId: user._id,
            lastResult: 'sent',
            lastMessageId: result?.messageId || null,
          },
          agentEmailNormalized: agentEmail,
        },
      }
    );

    res.json({ ok: true, messageId: result?.messageId || null, propertyId: String(prop._id) });
  } catch (err) {
    res.status(500).json({ ok:false, error: err.message });
  }
}

export async function getSummary(req, res) {
  try {
    await connectDB();

    const since = parseDateOrNull(req.query.since);
    const match = {};
    if (since) match.createdAt = { $gte: since };

    const pipeline = [
      { $match: match },
      {
        $group: {
          _id: { subadminId: '$subadminId', status: '$status' },
          count: { $sum: 1 },
        },
      },
      {
        $group: {
          _id: '$_id.subadminId',
          byStatus: {
            $push: { status: '$_id.status', count: '$count' },
          },
          total: { $sum: '$count' },
        },
      },
      { $sort: { total: -1 } },
    ];

    const rows = await AgentSend.aggregate(pipeline);

    // Optionally expand ObjectIds to strings for the client
    const data = rows.map((r) => ({
      subadminId: String(r._id),
      total: r.total,
      byStatus: r.byStatus.reduce((acc, x) => {
        acc[x.status] = x.count;
        return acc;
      }, {}),
    }));

    res.json({ ok: true, since: since?.toISOString() || null, data });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
}

export async function getLogs(req, res) {
  try {
    await connectDB();

    const {
      subadminId,
      propertyId,
      status,
      page = '1',
      limit = '50',
      since,
    } = req.query;

    const p = Math.max(1, parseInt(page, 10) || 1);
    const l = Math.max(1, Math.min(500, parseInt(limit, 10) || 50));

    const q = {};
    if (subadminId && mongoose.isValidObjectId(subadminId)) {
      q.subadminId = new mongoose.Types.ObjectId(subadminId);
    }
    if (propertyId && mongoose.isValidObjectId(propertyId)) {
      q.propertyId = new mongoose.Types.ObjectId(propertyId);
    }
    if (status) q.status = String(status);
    const sinceDate = parseDateOrNull(since);
    if (sinceDate) q.createdAt = { $gte: sinceDate };

    const [items, total] = await Promise.all([
      AgentSend.find(q)
        .sort({ createdAt: -1 })
        .skip((p - 1) * l)
        .limit(l)
        .lean(),
      AgentSend.countDocuments(q),
    ]);

    res.json({
      ok: true,
      page: p,
      limit: l,
      total,
      items: items.map((x) => ({
        id: String(x._id),
        propertyId: String(x.propertyId),
        subadminId: String(x.subadminId),
        agentEmail: x.agentEmail,
        status: x.status,
        reason: x.reason || null,
        messageId: x.messageId || null,
        templateVersion: x.templateVersion || 'agent_offer_v1',
        createdAt: x.createdAt,
        updatedAt: x.updatedAt,
      })),
    });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
}

/**
 * Manually trigger the Agent Offers automation.
 * NOTE: The worker currently runs for ALL active subadmins (no single-subadmin filter here).
 */
export async function runNow(req, res) {
  try {
    await connectDB();
    // fire-and-forget; do not block the HTTP request on the full run
    runAgentOffers().catch((e) => {
      // Best-effort server-side log; client already got 202
      // eslint-disable-next-line no-console
      console.warn('[agent_offers] manual run error', e?.message || e);
    });
    res.status(202).json({ ok: true, message: 'Agent Offers job started.' });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
}