// backend/routes/email.js
import express from 'express';
import nodemailer from 'nodemailer';
import { composeOfferPayload } from '../services/emailService.js';

const router = express.Router();
const isDryRun = () => process.env.EMAIL_DRY_RUN === '1';

function buildTransporterFromEnv() {
  const host = process.env.SMTP_HOST;
  const port = Number(process.env.SMTP_PORT || 587);
  const secure = String(process.env.SMTP_SECURE || 'false') === 'true';
  const user = process.env.SMTP_USER;
  const pass = process.env.SMTP_PASS;
  if (!host || !user || !pass) return null;
  return nodemailer.createTransport({ host, port, secure, auth: { user, pass } });
}

router.post('/send-email', async (req, res) => {
  try {
    const body = req.body || {};

    // ---------- Branch 1: Generic payload ----------
    const { to, from, replyTo, subject, html, text, headers } = body;
    const looksGeneric = !!to || !!subject || !!html || !!text;

    const sendGeneric = async () => {
      if (!to || !subject || (!html && !text)) {
        return res.status(400).json({ ok: false, error: 'Missing required fields (to, subject, html|text)' });
      }
      if (isDryRun()) {
        console.log('[email:dry-run] generic', { to, subject, haveHtml: !!html, haveText: !!text });
        return res.json({ ok: true, dryRun: true, mode: 'generic' });
      }
      const transporter = buildTransporterFromEnv();
      if (!transporter) {
        return res.status(400).json({ ok: false, error: 'SMTP not configured (SMTP_HOST/SMTP_USER/SMTP_PASS)' });
      }
      const info = await transporter.sendMail({
        to,
        from: from || `Mioym Deal Finder <${process.env.SMTP_USER}>`,
        replyTo,
        subject,
        html,
        text,
        headers,
      });
      return res.json({ ok: true, mode: 'generic', messageId: info.messageId });
    };

    if (looksGeneric) return await sendGeneric();

    // ---------- Branch 2: Offer payload ----------
    const { property, subadmin, offerPrice } = body;
    if (!property || !subadmin) {
      return res.status(400).json({ ok: false, error: 'Agent email and property details are required.' });
    }
    if (!property.agent_email || !property.fullAddress) {
      return res.status(400).json({ ok: false, error: 'property.agent_email and property.fullAddress are required.' });
    }
    if (!subadmin.email) {
      return res.status(400).json({ ok: false, error: 'subadmin.email is required.' });
    }

    const payload = await composeOfferPayload({ property, subadmin, offerPrice });

    if (isDryRun()) {
      console.log('[email:dry-run] offer', { to: payload.to, subject: payload.subject });
      return res.json({ ok: true, dryRun: true, mode: 'offer' });
    }

    const transporter = buildTransporterFromEnv();
    if (!transporter) {
      return res.status(400).json({ ok: false, error: 'SMTP not configured (SMTP_HOST/SMTP_USER/SMTP_PASS)' });
    }

    const info = await transporter.sendMail(payload);
    return res.json({ ok: true, mode: 'offer', messageId: info.messageId });
  } catch (err) {
    console.error('[email] send failed', err);
    const detail = err?.response?.data || err?.message || 'Unknown email error';
    return res.status(400).json({ ok: false, error: detail });
  }
});

export default router;