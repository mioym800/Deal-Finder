
// src/screens/Deals.tsx
import React, { useEffect, useMemo, useState, useCallback } from 'react';
import { getDeals, getDashboardSummary, updatePropertyBasic, deletePropertyById, sendAgentOffer } from '../api.tsx';
import {
  Dialog, DialogTitle, DialogContent, DialogActions,
  Button, Stack, Chip, Snackbar, Alert, TextField, Tabs, Tab,
  FormControl, InputLabel, Select, MenuItem, Checkbox, ListItemText
} from '@mui/material';

import IconButton from '@mui/material/IconButton';
import SendIcon from '@mui/icons-material/Send';

const emailRe = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const onlyDigits = (s: string) => (s || '').replace(/\D+/g, '');
const formatPhone = (s: string) => {
  const d = onlyDigits(s).slice(0, 10);
  const p1 = d.slice(0,3), p2 = d.slice(3,6), p3 = d.slice(6,10);
  if (d.length <= 3) return d;
  if (d.length <= 6) return `(${p1}) ${p2}`;
  return `(${p1}) ${p2}-${p3}`;
};

// Toggle verbose console logs for debugging data shape
const DEBUG = true;

// Dashboard-style totals for cards
type Totals = { properties: number; deals: number; nonDeals: number };
const normalizeTotals = (resp: any): Totals => {
  const t = resp?.data?.totals ?? resp?.totals ?? {};
  const properties = Number(t.properties ?? 0);
  const deals = Number(t.deals ?? 0);
  const nonDeals = Number(t.nonDeals ?? (properties - deals));
  return { properties, deals, nonDeals };
};

const isValidPhone = (s?: string) => {
  if (!s) return true; // optional
  return onlyDigits(s).length === 10;
};

// Coerce money/number-like values to numbers (handles "420000", "$420,000", Mongo Extended JSON, etc.)
const toNum = (v: any): number | null => {
  if (v == null) return null;
  if (typeof v === 'number') return Number.isFinite(v) ? v : null;
  if (typeof v === 'string') {
    const s = v.replace(/\$/g, '').replace(/,/g, '').trim();
    const n = Number(s);
    return Number.isFinite(n) ? n : null;
  }
  // Handle Mongo Extended JSON numbers: {$numberInt:"..."}, {$numberLong:"..."}, {$numberDouble:"..."}
  if (typeof v === 'object') {
    if ('$numberInt' in (v as any)) {
      const n = Number((v as any)['$numberInt']);
      return Number.isFinite(n) ? n : null;
    }
    if ('$numberLong' in (v as any)) {
      const n = Number((v as any)['$numberLong']);
      return Number.isFinite(n) ? n : null;
    }
    if ('$numberDouble' in (v as any)) {
      const n = Number((v as any)['$numberDouble']);
      return Number.isFinite(n) ? n : null;
    }
  }
  return null;
};

const pickFirstNumber = (...vals: any[]) => {
  for (const v of vals) {
    const n = toNum(v);
    if (typeof n === 'number' && n > 0) return n;
  }
  return null;
};

// Loose row shape to tolerate backend changes
type Row = {
  _id?: string;
  address?: string;
  fullAddress?: string;
  city?: string;
  state?: string;
  zip?: string;
  listPrice?: number | null;
  list_price?: number | null;
  lp?: number | null;
  listingPrice?: number | null;
  price?: number | null;
  amv?: number | null;
  lp80?: number | null;
  amv40?: number | null;
  amv30?: number | null;
  beds?: number | null;
  baths?: number | null;
  sqft?: number | null;
  built?: number | null;
  bofa_value?: number | null;
  chase_value?: number | null;
  movoto_adjusted?: number | null;
  movoto_value?: number | null;
  // Redfin fields (optional)
  redfin_value?: number | null;
  redfin_adjusted?: number | null;
  redfin?: number | null;
  lat?: number | null;
  lng?: number | null;
  agentName?: string | null;
  agentPhone?: string | null;
  agentEmail?: string | null;
  agentEmailSent?: boolean | null; // if backend provides it
  deal?: boolean;
  prop_id?: string;
  updatedAt?: string;
  squareFeet?: number | null;
};

const getId = (r: any) => r?._id || r?.prop_id || (r?.fullAddress || r?.address || '');

// Heuristic: treat as SENT if backend indicates an automatic email went out (including offerStatus)
function isAutoEmailSent(r: any): boolean {
  const bools = [
    r.agentEmailSent, r.autoEmailSent, r.automaticEmailSent,
    r.offerEmailSent, r.emailSent, r.agent_email_sent, r.email_sent
  ].map((v: any) => v === true || v === 'true' || v === 1 || v === '1');

  // timestamp-style flags (include offerStatus)
  const timestamps = [
    r.agentEmailSentAt, r.emailSentAt, r.offerEmailSentAt, r.lastEmailSentAt,
    r?.offerStatus?.lastSentAt
  ].filter(Boolean);

  // status strings (include offerStatus.lastResult)
  const statusStr = String(r.emailStatus || r.agentEmailStatus || r?.offerStatus?.lastResult || '')
    .toLowerCase().trim();
  const statusLooksSent = ['sent', 'delivered', 'ok', 'success'].includes(statusStr);

  return bools.some(Boolean) || timestamps.length > 0 || statusLooksSent;
}

const normalizeAddress = (addr: string) => {
  if (!addr) return '';
  let a = addr.toLowerCase().trim();
  // remove punctuation and normalize spacing
  a = a.replace(/[.,]/g, ' ').replace(/\s+/g, ' ');
  // drop ZIP+4 suffix (e.g., 46902-5423 -> 46902)
  a = a.replace(/-\d{4}\b/g, '');
  // normalize common suffixes
  const replacements: Record<string, string> = {
    street: 'st', st: 'st',
    avenue: 'ave', ave: 'ave',
    road: 'rd', rd: 'rd',
    drive: 'dr', dr: 'dr',
    boulevard: 'blvd', blvd: 'blvd',
    lane: 'ln', ln: 'ln',
    court: 'ct', ct: 'ct',
    circle: 'cir', cir: 'cir',
    place: 'pl', pl: 'pl',
    parkway: 'pkwy', pkwy: 'pkwy',
    highway: 'hwy', hwy: 'hwy',
    terrace: 'ter', ter: 'ter',
    way: 'wy', wy: 'wy',
    north: 'n', n: 'n',
    south: 's', s: 's',
    east: 'e', e: 'e',
    west: 'w', w: 'w',
    drivecourt: 'dr ct' // guard weird merges after punctuation removal
  };
  for (const [long, short] of Object.entries(replacements)) {
    const regex = new RegExp(`\\b${long}\\b`, 'g');
    a = a.replace(regex, short);
  }
  // collapse multiple spaces again after replacements
  a = a.replace(/\s+/g, ' ').trim();
  return a;
};

const dealKey = (r: any) => {
  const base = String(r.fullAddress || r.address || '').trim();
  return r._id || r.prop_id || normalizeAddress(base);
};

const dedupeByKey = <T,>(items: T[], keyFn: (x: T) => string) => {
  const map = new Map<string, T>();
  for (const it of items) {
    const k = keyFn(it);
    const prev: any = map.get(k);
    const curr: any = it as any;
    if (!prev) { map.set(k, it); continue; }
    const prevTs = prev?.updatedAt ? Date.parse(prev.updatedAt) : 0;
    const currTs = curr?.updatedAt ? Date.parse(curr.updatedAt) : 0;
    if (currTs >= prevTs) map.set(k, it);
  }
  return Array.from(map.values());
};

export default function Deals() {
  const REFRESH_MS = 3 * 60 * 1000; // 3 minutes
  const MIN_BEDS = 3; // hide anything below this count
  const [rows, setRows] = useState<Row[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [selected, setSelected] = useState<Row | null>(null);
  const [viewMode, setViewMode] = useState<'map' | 'street'>('street');
  const [geo, setGeo] = useState<{ lat: number; lng: number } | null>(null);
  const [geoLoading, setGeoLoading] = useState(false);
  const [streetPano, setStreetPano] = useState<string | null>(null);
  // Minimal edit/toast state so handlers compile even if Edit UI isn't shown yet
  const [editDraft, setEditDraft] = useState<Row | null>(null);
  const closeEdit = () => setEditDraft(null);
  const openEdit = (r: Row) => setEditDraft(r);
  const [toast, setToast] = useState<{ open: boolean; msg: string; sev: 'success' | 'error' | 'info' }>({ open: false, msg: '', sev: 'success' });
  const [detailTab, setDetailTab] = useState<'details' | 'activity'>('details');

  // Manual filters & sorting
  const [filterStates, setFilterStates] = useState<string[]>([]);
  const [emailFilter, setEmailFilter] = useState<'all' | 'sent' | 'unsent'>('all');
  const [amvSort, setAmvSort] = useState<'none' | 'asc' | 'desc'>('none');

  // Summary totals for cards
  const [totals, setTotals] = useState<Totals>({ properties: 0, deals: 0, nonDeals: 0 });
  const loadSummary = useCallback(async () => {
    try {
      const s = await getDashboardSummary();
      setTotals(normalizeTotals(s));
    } catch (_) {
      // ignore errors; cards will show zeros
    }
  }, []);

  // local row-level edits
  type Edits = {
    [id: string]: { agentName?: string; agentPhone?: string; agentEmail?: string; busy?: boolean }
  };
  const [edits, setEdits] = useState<Edits>({});

  const setEdit = useCallback((id: string, patch: Partial<Edits[string]>) => {
    setEdits(prev => ({ ...prev, [id]: { ...prev[id], ...patch } }));
  }, []);

  const onSend = useCallback(async (row: Row) => {
    const id = String(getId(row));
    if (!id || id === 'undefined') {
      setToast({ open: true, msg: 'Cannot send: missing property id', sev: 'error' });
      return;
    }
    const e = edits[id] || {};
    const agentName  = (e.agentName  ?? row.agentName  ?? '').trim();
    const agentPhone = (e.agentPhone ?? row.agentPhone ?? '').trim();
    const agentEmail = (e.agentEmail ?? row.agentEmail ?? (row as any).agent_email ?? '').trim();
    console.debug('[Deals:onSend] using', { id, agentName, agentPhone, agentEmail });

    // Fallback to UI if merged values are blank
const elName  = document.getElementById(`agent-name-${id}`)  as HTMLInputElement | null;
const elPhone = document.getElementById(`agent-phone-${id}`) as HTMLInputElement | null;
const elEmail = document.getElementById(`agent-email-${id}`) as HTMLInputElement | null;

const agentNameUI  = (elName?.value  ?? '').trim();
const agentPhoneUI = (elPhone?.value ?? '').trim();
const agentEmailUI = (elEmail?.value ?? '').trim();

const finalName  = agentName  || agentNameUI;
const finalPhone = agentPhone || agentPhoneUI;
const finalEmail = agentEmail || agentEmailUI;

console.debug('[Deals:onSend] fallback UI values', { finalName, finalPhone, finalEmail });


if (!emailRe.test(finalEmail)) {
  setToast({ open: true, msg: `Please enter a valid agent email: "${finalEmail}"`, sev: 'error' });
  return;
}
if (!isValidPhone(finalPhone)) {
  setToast({ open: true, msg: 'Phone must be 10 digits (or leave blank)', sev: 'error' });
  return;
}

    try {
      setEdit(id, { busy: true });
      await sendAgentOffer(id, {
        agentName: finalName,
        agentPhone: finalPhone,
        agentEmail: finalEmail,
      });
      const sentAt = new Date().toISOString();
      // mark as sent in local state + selected row
      setRows(cur =>
        cur.map(x => (getId(x) === id
          ? { ...x, agentEmailSent: true, offerStatus: { ...(x as any).offerStatus, lastSentAt: sentAt, lastResult: 'ok' } }
          : x
        ))
      );
      setSelected(sel =>
        sel && getId(sel) === id
          ? ({ ...sel, agentEmailSent: true, offerStatus: { ...(sel as any).offerStatus, lastSentAt: sentAt, lastResult: 'ok' } } as any)
          : sel
      );
      setEdit(id, { busy: false });
      // optional: toast/snackbar
      setToast({ open: true, msg: 'Offer sent!', sev: 'success' });
    } catch (err: any) {
      setEdit(id, { busy: false });
      setToast({ open: true, msg: err?.message || 'Failed to send offer', sev: 'error' });
    }
  }, [edits, setEdit]);

  const onSaveAgentOnly = useCallback(async (row: Row) => {
    const id = String(getId(row));
    if (!id || id === 'undefined') {
      setToast({ open: true, msg: 'Cannot save: missing property id', sev: 'error' });
      return;
    }
    const e = edits[id] || {};
    const agentName = (e.agentName ?? row.agentName ?? '').trim();
    const agentPhone = (e.agentPhone ?? row.agentPhone ?? '').trim();
    const agentEmail = (e.agentEmail ?? row.agentEmail ?? (row as any).agent_email ?? '').trim();
    console.debug('[Deals:onSaveAgentOnly] using', { id, agentName, agentPhone, agentEmail });
    // Fallback to UI if merged values are blank
const elName  = document.getElementById(`agent-name-${id}`)  as HTMLInputElement | null;
const elPhone = document.getElementById(`agent-phone-${id}`) as HTMLInputElement | null;
const elEmail = document.getElementById(`agent-email-${id}`) as HTMLInputElement | null;

const agentNameUI  = (elName?.value  ?? '').trim();
const agentPhoneUI = (elPhone?.value ?? '').trim();
const agentEmailUI = (elEmail?.value ?? '').trim();

const finalName  = agentName  || agentNameUI;
const finalPhone = agentPhone || agentPhoneUI;
const finalEmail = agentEmail || agentEmailUI;

console.debug('[Deals:onSaveAgentOnly] fallback UI values', { finalName, finalPhone, finalEmail });
    if (finalEmail && !emailRe.test(finalEmail)) {
      setToast({ open: true, msg: `Invalid email: "${finalEmail}"`, sev: 'error' });
      return;
    }
    if (!isValidPhone(finalPhone)) {
      setToast({ open: true, msg: `Phone must be 10 digits (or leave blank). Got: "${finalPhone}"`, sev: 'error' });
      return;
    }
    try {
      setEdit(id, { busy: true });
      await updatePropertyBasic(id, { agentName: finalName, agentPhone: finalPhone, agentEmail: finalEmail });
      setRows(cur => cur.map(x => (getId(x) === id ? { ...x, agentName: finalName, agentPhone: finalPhone, agentEmail: finalEmail } : x)));
      setEdit(id, { busy: false });
      setToast({ open: true, msg: 'Agent saved', sev: 'success' });
    } catch (err: any) {
      setEdit(id, { busy: false });
      setToast({ open: true, msg: err?.message || 'Save failed', sev: 'error' });
    }
  }, [edits, setEdit]);
  const GMAPS_KEY =
    (process.env.REACT_APP_GOOGLE_MAPS_GOOGLE_MAPS_KEY as string) ||
    (process.env.REACT_APP_GOOGLE_MAPS_KEY as string) ||
    (process.env.NEXT_PUBLIC_GOOGLE_MAPS_KEY as string) ||
    '';

  const currency = useMemo(
    () => new Intl.NumberFormat(undefined, { style: 'currency', currency: 'USD', maximumFractionDigits: 0 }),
    []
  );

  const fmt = (n?: number | null) => (typeof n === 'number' && n > 0 ? currency.format(n) : '—');

  // Shared TextField styling so labels/inputs are visible against white dialog
  const tfSx = {
    '& .MuiOutlinedInput-root': {
      backgroundColor: '#ffffff',
    },
    '& .MuiInputBase-input': {
      color: '#111827', // slate-900
    },
    '& .MuiInputLabel-root': {
      color: '#374151', // slate-700
    },
    '& .MuiOutlinedInput-notchedOutline': {
      borderColor: '#d1d5db', // gray-300
    },
    '&:hover .MuiOutlinedInput-notchedOutline': {
      borderColor: '#9ca3af', // gray-400
    },
    '& .Mui-focused .MuiOutlinedInput-notchedOutline, &.Mui-focused .MuiOutlinedInput-notchedOutline': {
      borderColor: '#111827', // slate-900
    },
  } as const;
  const tfLabelProps = { shrink: true } as const;

  const parseMoney = (v: any): number | null => {
    return toNum(v);
  };

  const getLP = (r: any): number | null => {
    // Accept more backend aliases for listing price
    const direct = pickFirstNumber(
      r.listingPrice,
      r.price,
      r.listPrice,
      r.list_price,
      r.listing_price,     // snake_case variant
      r.lp,                // generic lp
      r.askingPrice,
      r.asking_price,
      r.askPrice,
      r.listprice,         // occasional lowercased merge
      r.currentListPrice,
      r.originalListPrice
    );
    if (direct) return direct;

    // Derive from 80% helper fields if present
    const lp80 = pickFirstNumber(r.lp80, r.listPrice80, r.listingPrice80);
    if (lp80) return Math.round(lp80 / 0.8);

    return null;
  };

  const loadDeals = useCallback(async () => {
    try {
      setLoading(true);
      setError(null);
      const res: any = await getDeals(); // already requests onlyDeals=true
      if (DEBUG) {
        try {
          console.log('[Deals:getDeals] raw response keys:', Object.keys(res || {}));
          const sample = Array.isArray(res?.rows) ? res.rows.slice(0, 3) : (Array.isArray(res) ? res.slice(0, 3) : []);
          console.log('[Deals:getDeals] sample rows (raw):', sample);
        } catch (e) {
          console.warn('[Deals:getDeals] debug log failed', e);
        }
      }
      const arr: Row[] = Array.isArray(res?.rows) ? res.rows : Array.isArray(res) ? res : [];

      // Hard-guard: only keep deals (server flag) OR LP ≤ 50% AMV
      const onlyDeals = arr.filter((r) => {
        const amv = Number(r.amv);
        const lp = getLP(r);
        const serverDeal = r.deal === true;
        const calcDeal = Number.isFinite(amv) && typeof lp === 'number' && Number.isFinite(lp) && lp <= Math.round(0.55 * amv);
        return serverDeal || calcDeal;
      });

      // 🔽 Normalize agent fields and coerce numeric strings → numbers so rendering/math works
      const normalized = onlyDeals.map((r: any) => {
        const agentName  = r.agentName  ?? r.agent ?? null;
        const agentPhone = r.agentPhone ?? r.agent_phone ?? null;
        const agentEmail = r.agentEmail ?? r.agent_email ?? null;

        // numeric normalization
        const listingPrice = pickFirstNumber(
          r.listingPrice,
          r.price,
          r.listPrice,
          r.list_price,
          r.listing_price,
          r.lp,
          r.askingPrice,
          r.asking_price,
          r.askPrice,
          r.listprice,
          r.currentListPrice,
          r.originalListPrice
        );
        const amv   = toNum(r.amv);
        const lp80  = toNum(r.lp80);
        const amv40 = toNum(r.amv40);
        const amv30 = toNum(r.amv30);

        // Additional numeric normalization for beds, baths, squareFeet
        const beds = toNum(r.beds ?? r.bedrooms ?? r.num_beds);
        const baths = toNum(r.baths ?? r.bathrooms ?? r.num_baths);
        const squareFeet = toNum(r.squareFeet ?? r.sqft);

        // derive fallbacks when API omits helper fields
        const lp80Final  = lp80  ?? (listingPrice != null ? Math.round(listingPrice * 0.8) : null);
        const amv40Final = amv40 ?? (amv != null ? Math.round(amv * 0.4) : null);
        const amv30Final = amv30 ?? (amv != null ? Math.round(amv * 0.3) : null);

        const _id = r._id ?? r.prop_id ?? undefined;

        // derive state from fullAddress if missing (e.g., "City, ST 12345")
        const stateFromAddr = (() => {
          const addr = String(r.fullAddress ?? r.address ?? '').toUpperCase();
          // Match last ", ST" with optional ZIP
          const m = addr.match(/,\s*([A-Z]{2})\b(?:\s*\d{5}(?:-\d{4})?)?\s*$/);
          return m ? m[1] : null;
        })();
        const stateNorm = (r.state ? String(r.state).toUpperCase() : null) ?? stateFromAddr;

        if (DEBUG) {
          try {
            console.debug('[Deals:normalize]', {
              _id: r._id ?? r.prop_id,
              raw_listingPrice: r.listingPrice ?? r.price ?? r.listPrice ?? r.list_price ?? r.lp,
              parsed_listingPrice: listingPrice,
              raw_amv: r.amv,
              parsed_amv: amv,
              raw_lp80: r.lp80,
              parsed_lp80: lp80,
              raw_amv40: r.amv40,
              parsed_amv40: amv40,
              raw_amv30: r.amv30,
              parsed_amv30: amv30,
            });
          } catch (e) {
            console.warn('[Deals:normalize] debug failed', e);
          }
        }

        return {
          ...r,
          _id,
          agentName,
          agentPhone,
          agentEmail,
          agentEmailSent: isAutoEmailSent(r),

          // overwrite with numeric versions so fmt(...) and offer math work
          listingPrice,
          amv,
          lp80: lp80Final,
          amv40: amv40Final,
          amv30: amv30Final,
          beds,
          baths,
          squareFeet,
          state: stateNorm,
        } as Row;
      });

      const unique = dedupeByKey(normalized, dealKey);
      const minBedRows = unique.filter(x => {
        const b = typeof x.beds === 'number' ? x.beds : toNum((x as any).beds);
        const a = toNum(x.amv);
        return typeof b === 'number' && b >= MIN_BEDS && typeof a === 'number' && a >= 150000;
      });
      setRows(minBedRows);
      // Filter for deals with AMV >= 150000 for totals
      const highAmvDeals = minBedRows.filter(r => {
        const a = toNum(r.amv);
        return typeof a === 'number' && a >= 150000;
      });
      setTotals(prev => ({
        ...prev,
        deals: highAmvDeals.length,
        nonDeals: Math.max(0, (prev.properties ?? 0) - highAmvDeals.length),
      }));
      if (DEBUG) {
        try {
          console.table(
            unique.slice(0, 5).map((x: any) => ({
              id: x._id || x.prop_id || (x.fullAddress || x.address),
              listingPrice: x.listingPrice,
              amv: x.amv,
              lp80: x.lp80,
              amv40: x.amv40,
              amv30: x.amv30,
              getLP: (typeof x.listingPrice === 'number' ? x.listingPrice : null),
              emailSent: isAutoEmailSent(x),
            }))
          );
        } catch (e) {
          console.warn('[Deals] post-normalize table failed', e);
        }
      }
      console.debug('[Deals] loaded', { total: normalized.length, unique: unique.length, sent: unique.filter(isAutoEmailSent).length });
    } catch (e: any) {
      console.error('Failed to load deals', e);
      setError(e?.message || 'Failed to load deals');
    } finally {
      setLoading(false);
    }
  }, []);
  // Unique state list based on currently loaded rows
  const uniqueStates = useMemo(() => {
    const s = new Set<string>();
    for (const r of rows) {
      let st = r.state ? String(r.state).toUpperCase() : '';
      if (!st) {
        const addr = String(r.fullAddress ?? r.address ?? '').toUpperCase();
        const m = addr.match(/,\s*([A-Z]{2})\b(?:\s*\d{5}(?:-\d{4})?)?\s*$/);
        st = m ? m[1] : '';
      }
      if (st) s.add(st);
    }
    return Array.from(s).sort();
  }, [rows]);

  // Apply manual filters and sorting on top of core thresholds (beds >= 3, amv >= 150k)
  const displayedRows = useMemo(() => {
    let out = [...rows];

    if (filterStates.length) {
      const allow = new Set(filterStates.map(s => s.toUpperCase()));
      out = out.filter(r => r.state && allow.has(String(r.state).toUpperCase()));
    }

    if (emailFilter !== 'all') {
      out = out.filter(r => {
        const sent = isAutoEmailSent(r);
        return emailFilter === 'sent' ? sent : !sent;
      });
    }

    if (amvSort !== 'none') {
      out.sort((a, b) => {
        const A = toNum(a.amv) ?? -Infinity;
        const B = toNum(b.amv) ?? -Infinity;
        return amvSort === 'asc' ? (A - B) : (B - A);
      });
    }

    return out;
  }, [rows, filterStates, emailFilter, amvSort]);

  useEffect(() => {
    if (!DEBUG) return;
    if (!selected) return;
    try {
      const lpSel = getLP(selected);
      const lp80Display  = typeof (selected as any).lp80 === 'number' ? (selected as any).lp80 : (typeof lpSel === 'number' ? Math.round(lpSel * 0.8) : null);
      const amv40Display = typeof (selected as any).amv40 === 'number' ? (selected as any).amv40 : (typeof (selected as any).amv === 'number' ? Math.round((selected as any).amv * 0.4) : null);
      const amv30Display = typeof (selected as any).amv30 === 'number' ? (selected as any).amv30 : (typeof (selected as any).amv === 'number' ? Math.round((selected as any).amv * 0.3) : null);
      console.group('[Deals:selected]');
      console.log('id', getId(selected));
      console.log('fullAddress', selected.fullAddress || selected.address);
      console.log('listingPrice(raw)', (selected as any).listingPrice, 'getLP()', lpSel);
      console.log('amv(raw)', (selected as any).amv);
      console.log('lp80 (display)', lp80Display);
      console.log('amv40 (display)', amv40Display);
      console.log('amv30 (display)', amv30Display);
      console.log('offer amount (min(lp80, amv40))', (Number.isFinite(Number(lp80Display)) && Number.isFinite(Number(amv40Display))) ? Math.min(Number(lp80Display), Number(amv40Display)) : null);
      console.groupEnd();
    } catch (e) {
      console.warn('[Deals:selected] debug failed', e);
    }
  }, [selected]);

  // initial load
  useEffect(() => {
    loadSummary();
    loadDeals();
  }, [loadDeals, loadSummary]);

  // auto-refresh every 3 minutes (only when tab is visible)
  useEffect(() => {
    const tick = () => {
      if (document.visibilityState === 'visible') {
        loadDeals();
        loadSummary();
      }
    };
    const id = window.setInterval(tick, REFRESH_MS);
    return () => window.clearInterval(id);
  }, [loadDeals, loadSummary]);

  // refresh once when window regains focus
  useEffect(() => {
    const onFocus = () => loadDeals();
    window.addEventListener('focus', onFocus);
    return () => window.removeEventListener('focus', onFocus);
  }, [loadDeals]);

  useEffect(() => {
    // Reset Street View as default when opening a property
    if (selected) setViewMode('street');
  }, [selected]);

  useEffect(() => {
    // Reset geocoded coords when selection changes
    setGeo(null);
    setStreetPano(null);

    if (!selected) return;
    // If backend already provided coords, use them
    if (typeof selected.lat === 'number' && typeof selected.lng === 'number') {
      setGeo({ lat: selected.lat, lng: selected.lng });
      return;
    }

    // If no API key, skip (iframe will fall back to non-key mode)
    if (!GMAPS_KEY) return;

    // Build an address string to geocode
    const addr =
      selected.fullAddress ||
      selected.address ||
      [selected.address, selected.city, selected.state, selected.zip].filter(Boolean).join(', ');
    if (!addr) return;

    const controller = new AbortController();
    const q = encodeURIComponent(addr);
    const url = `https://maps.googleapis.com/maps/api/geocode/json?address=${q}&key=${GMAPS_KEY}`;

    (async () => {
      try {
        setGeoLoading(true);
        const res = await fetch(url, { signal: controller.signal });
        const data = await res.json().catch(() => null);
        const loc = data?.results?.[0]?.geometry?.location;
        if (loc && typeof loc.lat === 'number' && typeof loc.lng === 'number') {
          setGeo({ lat: loc.lat, lng: loc.lng });
        }
      } catch (_) {
        // ignore network/abort errors
      } finally {
        setGeoLoading(false);
      }
    })();

    return () => controller.abort();
  }, [selected, GMAPS_KEY]);

  useEffect(() => {
    // Look up nearest Street View pano for better coverage
    // We prefer pano id over raw lat/lng to avoid map fallback when no imagery at the exact point.
    if (!selected || !GMAPS_KEY) return;

    // Prefer backend coords, else geocoded
    const lat = (typeof (selected as any)?.lat === 'number' ? (selected as any).lat : undefined) ?? (geo?.lat);
    const lng = (typeof (selected as any)?.lng === 'number' ? (selected as any).lng : undefined) ?? (geo?.lng);
    if (lat == null || lng == null) return;

    const controller = new AbortController();
    // radius in meters to search for a pano around the point
    const url = `https://maps.googleapis.com/maps/api/streetview/metadata?location=${lat},${lng}&radius=100&key=${GMAPS_KEY}`;

    (async () => {
      try {
        const res = await fetch(url, { signal: controller.signal });
        const data = await res.json().catch(() => null);
        // If imagery exists nearby, prefer its pano_id for embedding
        if (data?.status === 'OK') {
          const pano = data?.pano_id ?? data?.location?.pano_id ?? null;
          if (pano) setStreetPano(pano);
          // If no pano_id provided but a nearby pano location is returned, update geo to that
          if (!pano && data?.location && typeof data.location.lat === 'number' && typeof data.location.lng === 'number') {
            setGeo({ lat: data.location.lat, lng: data.location.lng });
          }
        } else {
          // No coverage: ensure we don't keep a stale pano id
          setStreetPano(null);
        }
      } catch {
        // ignore network/abort errors
      }
    })();

    return () => controller.abort();
  }, [selected, geo?.lat, geo?.lng, GMAPS_KEY]);

  const handleDelete = async (r: Row) => {
    const id = getId(r);
    if (!id) { setToast({ open: true, msg: 'Cannot delete: missing id', sev: 'error' }); return; }
    if (!window.confirm('Delete this deal? This cannot be undone.')) return;

    const prev = rows;
    setRows(cur => cur.filter(x => getId(x) !== id));
    try {
      const res = await deletePropertyById(String(id));
      if ((res as any)?.ok || res === undefined) {
        setToast({ open: true, msg: 'Deal deleted', sev: 'success' });
      } else {
        setToast({ open: true, msg: 'Deleted', sev: 'success' });
      }
    } catch (e: any) {
      setRows(prev);
      setToast({ open: true, msg: `Delete failed: ${e?.message || 'unknown error'}`, sev: 'error' });
    }
  };

  const handleSaveEdit = async () => {
    if (!editDraft) return;
    const id = getId(editDraft);
    if (!id) { setToast({ open: true, msg: 'Missing id; cannot save', sev: 'error' }); return; }

    const payload: Partial<Row> = {
          // address
          fullAddress: editDraft.fullAddress ?? null,
          address: editDraft.address ?? null,
          city: editDraft.city ?? null,
          state: editDraft.state ?? null,
          zip: editDraft.zip ?? null,
      
          // pricing / valuation
          listingPrice: editDraft.listingPrice ?? (editDraft.price ?? null),
          amv: editDraft.amv ?? null,
          bofa_value: editDraft.bofa_value ?? null,
          chase_value: editDraft.chase_value ?? null,
          movoto_adjusted: editDraft.movoto_adjusted ?? null,
          movoto_value: editDraft.movoto_value ?? null,
      
          // details
          beds: editDraft.beds ?? null,
          baths: editDraft.baths ?? null,
          squareFeet: (editDraft.squareFeet ?? editDraft.sqft) ?? null,
          built: (editDraft as any).built ?? null,
      
          // agent
          agentName: editDraft.agentName ?? null,
          agentPhone: editDraft.agentPhone ?? null,
          agentEmail: editDraft.agentEmail ?? null,
        };

    setRows(cur => cur.map(x => (getId(x) === id ? { ...x, ...payload } : x)));

    try {
      await updatePropertyBasic(String(id), payload);
      setToast({ open: true, msg: 'Changes saved', sev: 'success' });
      closeEdit();
    } catch (e: any) {
      setToast({ open: true, msg: `Save failed: ${e?.message || 'unknown error'}`, sev: 'error' });
    }
  };

  if (loading) return <div style={{ padding: 24 }}>Loading deals…</div>;
  if (error)   return <div style={{ padding: 24, color: '#ef4444' }}>{error}</div>;

  return (
    <div style={{ padding: 24 }}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 16 }}>
        <h2 style={{ margin: 0, fontSize: 22, fontWeight: 800, color: '#111827' }}>Deals</h2>
        <div style={{ fontSize: 14, color: '#6b7280' }}>Total: {displayedRows.length}</div>
      </div>

      {/* Summary cards */}
      <div
        style={{
          display: 'grid',
          gridTemplateColumns: 'repeat(auto-fit, minmax(180px, 1fr))',
          gap: 16,
          marginBottom: 16,
        }}
      >
        <Card title="Total Properties" value={totals.properties} />
        <Card title="Total Deals" value={totals.deals} />
        <Card title="Not Deals" value={totals.nonDeals} />
      </div>

      {/* Filters & sorting */}
      <div style={{
        display: 'flex',
        gap: 12,
        alignItems: 'center',
        flexWrap: 'wrap',
        marginBottom: 12,
      }}>
        {/* State filter (multi-select) */}
        <FormControl
          size="small"
          sx={{
            minWidth: 220,
            '& .MuiOutlinedInput-root': {
              color: '#000',
              '& fieldset': { borderColor: '#000' },
              '&:hover fieldset': { borderColor: '#000' },
              '&.Mui-focused fieldset': { borderColor: '#000' }
            },
            '& .MuiInputLabel-root': { color: '#000' },
            '& .MuiSelect-icon': { color: '#000' }
          }}
        >
          <InputLabel id="filter-states-label">States</InputLabel>
          <Select
            labelId="filter-states-label"
            multiple
            value={filterStates}
            onChange={(e) => setFilterStates(typeof e.target.value === 'string' ? e.target.value.split(',') : (e.target.value as string[]))}
            label="States"
            renderValue={(selected) => (selected as string[]).join(', ')}
            MenuProps={{ PaperProps: { sx: { color: '#000', border: '1px solid #000' } } }}
          >
            {uniqueStates.map((s) => (
              <MenuItem key={s} value={s}>
                <Checkbox checked={filterStates.indexOf(s) > -1} />
                <ListItemText primary={s} />
              </MenuItem>
            ))}
          </Select>
        </FormControl>

        {/* Email status filter */}
        <FormControl
          size="small"
          sx={{
            minWidth: 160,
            '& .MuiOutlinedInput-root': {
              color: '#000',
              '& fieldset': { borderColor: '#000' },
              '&:hover fieldset': { borderColor: '#000' },
              '&.Mui-focused fieldset': { borderColor: '#000' }
            },
            '& .MuiInputLabel-root': { color: '#000' },
            '& .MuiSelect-icon': { color: '#000' }
          }}
        >
          <InputLabel id="filter-email-label">Email Status</InputLabel>
          <Select
            labelId="filter-email-label"
            value={emailFilter}
            label="Email Status"
            onChange={(e) => setEmailFilter(e.target.value as any)}
            MenuProps={{ PaperProps: { sx: { color: '#000', border: '1px solid #000' } } }}
          >
            <MenuItem value="all">All</MenuItem>
            <MenuItem value="sent">Sent</MenuItem>
            <MenuItem value="unsent">Unsent</MenuItem>
          </Select>
        </FormControl>

        {/* AMV sort */}
        <FormControl
          size="small"
          sx={{
            minWidth: 160,
            '& .MuiOutlinedInput-root': {
              color: '#000',
              '& fieldset': { borderColor: '#000' },
              '&:hover fieldset': { borderColor: '#000' },
              '&.Mui-focused fieldset': { borderColor: '#000' }
            },
            '& .MuiInputLabel-root': { color: '#000' },
            '& .MuiSelect-icon': { color: '#000' }
          }}
        >
          <InputLabel id="sort-amv-label">Sort AMV</InputLabel>
          <Select
            labelId="sort-amv-label"
            value={amvSort}
            label="Sort AMV"
            onChange={(e) => setAmvSort(e.target.value as any)}
            MenuProps={{ PaperProps: { sx: { color: '#000', border: '1px solid #000' } } }}
          >
            <MenuItem value="none">None</MenuItem>
            <MenuItem value="asc">Low → High</MenuItem>
            <MenuItem value="desc">High → Low</MenuItem>
          </Select>
        </FormControl>

        {/* Quick clear */}
        <Button size="small" onClick={() => { setFilterStates([]); setEmailFilter('all'); setAmvSort('none'); }}>Clear</Button>
      </div>

      <div
        style={{
          overflowX: 'auto',
          borderRadius: 12,
          border: '1px solid #e5e7eb',
          background: '#fff',
          boxShadow: '0 1px 2px rgba(0,0,0,0.04)',
        }}
      >
        <table style={{ width: '100%', borderCollapse: 'separate', borderSpacing: 0 }}>
          <thead>
            <tr style={{ background: '#111827', color: '#fff' }}>
              {[
                'Full address',
                'L.P',
                'L.P 80%',
                'AMV',
                'AMV 40%',
                'AMV 30%',
                'Offer amount',
                'Email status',
                'Actions',
              ].map((h, i) => (
                <th
                  key={h}
                  style={{
                    textAlign: i === 0 ? 'left' : 'right',
                    padding: '12px 14px',
                    fontSize: 12,
                    letterSpacing: 0.4,
                    textTransform: 'uppercase',
                    borderBottom: '1px solid rgba(255,255,255,0.12)',
                    position: 'sticky',
                    top: 0,
                    zIndex: 1,
                    whiteSpace: 'nowrap',
                  }}
                >
                  {h}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {displayedRows.map((r, i) => {
              const addr = r.fullAddress || r.address || '';
              const lp = getLP(r);
              const lp80Display  = typeof r.lp80  === 'number' ? r.lp80  : (typeof lp === 'number' ? Math.round(lp * 0.8) : null);
              const amv40Display = typeof r.amv40 === 'number' ? r.amv40 : (typeof r.amv === 'number' ? Math.round(r.amv * 0.4) : null);
              const amv30Display = typeof r.amv30 === 'number' ? r.amv30 : (typeof r.amv === 'number' ? Math.round(r.amv * 0.3) : null);
              const zebra = i % 2 === 0 ? '#ffffff' : '#f9fafb';
              const emailStatus = isAutoEmailSent(r);
              const id = String(getId(r));
              const e = edits[id] || {};

              if (DEBUG && i < 3) {
                try {
                  console.debug('[Deals:rowRender]', {
                    id,
                    addr,
                    lp,
                    lp80Display,
                    amv: r.amv,
                    amv40Display,
                    amv30Display
                  });
                } catch (e) {
                  // ignore
                }
              }

              return (
                <tr
                  key={r._id || r.prop_id || (r.fullAddress || r.address)}
                  onClick={() => { setSelected(r); setDetailTab('details'); }}
                  style={{ background: zebra, cursor: 'pointer' }}
                >
                  <td style={tdLWide}>
                    <div style={{ fontWeight: 600 }}>{addr || '—'}</div>
                  </td>
                  <td style={tdR}>{fmt(lp)}</td>
                  <td style={tdR}>{fmt(lp80Display)}</td>
                  <td style={tdR}>{fmt(r.amv)}</td>
                  <td style={tdR}>{fmt(amv40Display)}</td>
                  <td style={tdR}>{fmt(amv30Display)}</td>
                  <td style={tdR}>{fmt(
                    (() => {
                      const a = typeof lp80Display === 'number' ? lp80Display : NaN;
                      const b = typeof amv40Display === 'number' ? amv40Display : NaN;
                      if (Number.isFinite(a) && Number.isFinite(b)) return Math.min(a, b);
                      if (Number.isFinite(a)) return a;
                      if (Number.isFinite(b)) return b;
                      return null;
                    })()
                  )}</td>
                  <td style={tdR}>
                    <Chip
                      size="small"
                      label={emailStatus ? 'SENT' : 'UNSENT'}
                      color={emailStatus ? 'success' : 'default'}
                      variant={emailStatus ? 'filled' : 'outlined'}
                      sx={
                        emailStatus
                          ? undefined
                          : { color: '#111827', borderColor: '#9ca3af', bgcolor: 'transparent' }
                      }
                    />
                  </td>
                  <td style={{ ...tdR, whiteSpace: 'nowrap' }}>
                    <Button size="small" variant="outlined" onClick={(e) => { e.stopPropagation(); openEdit(r); }} sx={{ mr: 1 }}>Edit</Button>
                    <Button size="small" color="error" variant="outlined" onClick={(e) => { e.stopPropagation(); handleDelete(r); }}>Delete</Button>
                  </td>
                </tr>
              );
            })}
            {!displayedRows.length && (
              <tr>
                <td colSpan={9} style={{ padding: 18, textAlign: 'center', color: '#6b7280' }}>
                  No deals found.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>

      {/* Edit modal */}
      <Dialog open={!!editDraft} onClose={() => setEditDraft(null)} maxWidth="sm" fullWidth>
        <DialogTitle>Edit deal</DialogTitle>
        <DialogContent dividers>
          {editDraft ? (
            <div style={{ display: 'grid', gap: 12, gridTemplateColumns: 'repeat(auto-fit, minmax(180px, 1fr))' }}>
  {/* Address block */}
  <TextField
    size="small"
    label="Full address"
    InputLabelProps={tfLabelProps}
    sx={tfSx}
    value={String(editDraft.fullAddress ?? editDraft.address ?? '')}
    onChange={(e) => setEditDraft(prev => prev ? { ...prev, fullAddress: e.target.value } : prev)}
  />
  <TextField
    size="small"
    label="Address (line 1)"
    InputLabelProps={tfLabelProps}
    sx={tfSx}
    value={String(editDraft.address ?? '')}
    onChange={(e) => setEditDraft(prev => prev ? { ...prev, address: e.target.value } : prev)}
  />
  <TextField
    size="small"
    label="City"
    InputLabelProps={tfLabelProps}
    sx={tfSx}
    value={String(editDraft.city ?? '')}
    onChange={(e) => setEditDraft(prev => prev ? { ...prev, city: e.target.value } : prev)}
  />
  <TextField
    size="small"
    label="State"
    InputLabelProps={tfLabelProps}
    sx={tfSx}
    value={String(editDraft.state ?? '')}
    onChange={(e) => setEditDraft(prev => prev ? { ...prev, state: e.target.value } : prev)}
  />
  <TextField
    size="small"
    label="ZIP"
    InputLabelProps={tfLabelProps}
    sx={tfSx}
    value={String(editDraft.zip ?? '')}
    onChange={(e) => setEditDraft(prev => prev ? { ...prev, zip: e.target.value } : prev)}
  />

  {/* Pricing / valuation */}
  <TextField
    size="small" type="number" label="Listing Price"
    InputLabelProps={tfLabelProps}
    sx={tfSx}
    value={(editDraft.listingPrice ?? editDraft.price ?? '') as any}
    onChange={(e) => setEditDraft(prev => prev ? { ...prev, listingPrice: e.target.value ? Number(e.target.value) : null } : prev)}
  />
  <TextField
    size="small" type="number" label="AMV"
    InputLabelProps={tfLabelProps}
    sx={tfSx}
    value={(editDraft.amv ?? '') as any}
    onChange={(e) => setEditDraft(prev => prev ? { ...prev, amv: e.target.value ? Number(e.target.value) : null } : prev)}
  />
  <TextField
    size="small" type="number" label="BofA valuation"
    InputLabelProps={tfLabelProps}
    sx={tfSx}
    value={(editDraft.bofa_value ?? '') as any}
    onChange={(e) => setEditDraft(prev => prev ? { ...prev, bofa_value: e.target.value ? Number(e.target.value) : null } : prev)}
  />
  <TextField
    size="small" type="number" label="Chase valuation"
    InputLabelProps={tfLabelProps}
    sx={tfSx}
    value={(editDraft.chase_value ?? '') as any}
    onChange={(e) => setEditDraft(prev => prev ? { ...prev, chase_value: e.target.value ? Number(e.target.value) : null } : prev)}
  />
  <TextField
    size="small" type="number" label="Movoto (adjusted)"
    InputLabelProps={tfLabelProps}
    sx={tfSx}
    value={(editDraft.movoto_adjusted ?? '') as any}
    onChange={(e) => setEditDraft(prev => prev ? { ...prev, movoto_adjusted: e.target.value ? Number(e.target.value) : null } : prev)}
  />
  <TextField
    size="small" type="number" label="Movoto (value/high)"
    InputLabelProps={tfLabelProps}
    sx={tfSx}
    value={(editDraft.movoto_value ?? '') as any}
    onChange={(e) => setEditDraft(prev => prev ? { ...prev, movoto_value: e.target.value ? Number(e.target.value) : null } : prev)}
  />

  {/* Details */}
  <TextField
    size="small" type="number" label="Beds"
    InputLabelProps={tfLabelProps}
    sx={tfSx}
    value={(editDraft.beds ?? '') as any}
    onChange={(e) => setEditDraft(prev => prev ? { ...prev, beds: e.target.value ? Number(e.target.value) : null } : prev)}
  />
  <TextField
    size="small" type="number" label="Baths"
    InputLabelProps={tfLabelProps}
    sx={tfSx}
    value={(editDraft.baths ?? '') as any}
    onChange={(e) => setEditDraft(prev => prev ? { ...prev, baths: e.target.value ? Number(e.target.value) : null } : prev)}
  />
  <TextField
    size="small" type="number" label="Square Feet"
    InputLabelProps={tfLabelProps}
    sx={tfSx}
    value={((editDraft.squareFeet ?? editDraft.sqft) ?? '') as any}
    onChange={(e) => setEditDraft(prev => prev ? { ...prev, squareFeet: e.target.value ? Number(e.target.value) : null } : prev)}
  />
  <TextField
    size="small" type="number" label="Year Built"
    InputLabelProps={tfLabelProps}
    sx={tfSx}
    value={((editDraft as any).built ?? '') as any}
    onChange={(e) => setEditDraft(prev => prev ? { ...prev, built: e.target.value ? Number(e.target.value) : null } : prev)}
  />

  {/* Agent */}
  <TextField
    size="small"
    label="Agent name"
    InputLabelProps={tfLabelProps}
    InputProps={{
      style: { color: '#000' }
    }}
    sx={{
      ...tfSx,
      minWidth: 160,
      '& .MuiInputBase-input::placeholder': { color: '#000', opacity: 1 }
    }}
    value={String(editDraft.agentName ?? '')}
    onChange={(e) => setEditDraft(prev => prev ? { ...prev, agentName: e.target.value } : prev)}
  />
  <TextField
    size="small"
    label="Agent phone"
    InputLabelProps={tfLabelProps}
    InputProps={{
      style: { color: '#000' }
    }}
    sx={{
      ...tfSx,
      minWidth: 160,
      '& .MuiInputBase-input::placeholder': { color: '#000', opacity: 1 }
    }}
    value={String(editDraft.agentPhone ?? '')}
    onChange={(e) => setEditDraft(prev => prev ? { ...prev, agentPhone: e.target.value } : prev)}
  />
  <TextField
    size="small"
    label="Agent email"
    InputLabelProps={tfLabelProps}
    InputProps={{
      style: { color: '#000' }
    }}
    sx={{
      ...tfSx,
      minWidth: 220,
      '& .MuiInputBase-input::placeholder': { color: '#000', opacity: 1 }
    }}
    value={String(editDraft.agentEmail ?? '')}
    onChange={(e) => setEditDraft(prev => prev ? { ...prev, agentEmail: e.target.value } : prev)}
  />
</div>
          ) : (
            <div style={{ padding: 8, color: '#6b7280' }}>No deal selected.</div>
          )}
        </DialogContent>
        <DialogActions>
          <Button onClick={() => setEditDraft(null)}>Cancel</Button>
          <Button variant="contained" onClick={handleSaveEdit} disabled={!editDraft}>Save</Button>
        </DialogActions>
      </Dialog>

      {/* Detail modal */}
      <Dialog open={!!selected} onClose={() => setSelected(null)} maxWidth="md" fullWidth>
        {selected && (
          <>
            <DialogTitle>Property details</DialogTitle>
            <DialogContent dividers>
              <Stack spacing={2}>
                {/* Map / Street View */}
                {(() => {
                  const addrForMap =
                    (selected?.fullAddress) ||
                    (selected?.address) ||
                    [selected?.address, selected?.city, selected?.state, selected?.zip].filter(Boolean).join(', ');

                  const addressQ = encodeURIComponent(addrForMap || '');

                  const hasKey = !!GMAPS_KEY;

                  // Prefer lat/lng if available (from backend or geocoding)
                  const lat = (typeof (selected as any)?.lat === 'number' ? (selected as any).lat : undefined) ?? (geo?.lat);
                  const lng = (typeof (selected as any)?.lng === 'number' ? (selected as any).lng : undefined) ?? (geo?.lng);

                  // --- Build true Street View endpoint ---
                  const streetSrc = (hasKey && (lat != null && lng != null))
                    ? (streetPano
                        ? `https://www.google.com/maps/embed/v1/streetview?key=${GMAPS_KEY}&pano=${streetPano}&heading=0&pitch=0&fov=80`
                        : `https://www.google.com/maps/embed/v1/streetview?key=${GMAPS_KEY}&location=${lat},${lng}&heading=0&pitch=0&fov=80`)
                    : (!hasKey && addrForMap)
                      ? `https://www.google.com/maps?q=${addressQ}&layer=c&output=svembed`
                      : '';

                  // Normal map for the Map tab
                  const mapSrc = hasKey
                    ? (lat != null && lng != null)
                      ? `https://www.google.com/maps/embed/v1/view?key=${GMAPS_KEY}&center=${lat},${lng}&zoom=16&maptype=roadmap`
                      : `https://www.google.com/maps/embed/v1/place?key=${GMAPS_KEY}&q=${addressQ}&zoom=16`
                    : `https://www.google.com/maps?hl=en&q=${addressQ}&z=16&output=embed`;

                  const streetExternal = (lat != null && lng != null)
                    ? `https://www.google.com/maps/@?api=1&map_action=pano&viewpoint=${lat},${lng}`
                    : `https://www.google.com/maps/search/?api=1&query=${addressQ}&layer=c`;

                  return (
                    <div style={{ width: '100%', borderRadius: 8, overflow: 'hidden', border: '1px solid #eee' }}>
                      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8, padding: 8, borderBottom: '1px solid #eee', background: '#fafafa' }}>
                        <div style={{ display: 'flex', gap: 8 }}>
                          <Button
                            size="small"
                            variant={viewMode === 'street' ? 'contained' : 'outlined'}
                            onClick={() => setViewMode('street')}
                          >
                            Street View
                          </Button>
                          <Button
                            size="small"
                            variant={viewMode === 'map' ? 'contained' : 'outlined'}
                            onClick={() => setViewMode('map')}
                          >
                            Map
                          </Button>
                        </div>
                        <a
                          href={streetExternal}
                          target="_blank"
                          rel="noopener noreferrer"
                          style={{ fontSize: 12, color: '#2563eb', textDecoration: 'none', padding: '4px 6px' }}
                          title="Open this address in Google Maps Street View"
                        >
                          Open in Google Maps →
                        </a>
                      </div>
                      <div style={{ width: '100%', height: 280 }}>
                        {viewMode === 'street' ? (
                          streetSrc ? (
                            <iframe
                              key={`street-${streetPano ?? lat ?? addressQ}`}
                              title={'street-view'}
                              width="100%"
                              height="100%"
                              style={{ border: 0 }}
                              loading="lazy"
                              src={streetSrc}
                              referrerPolicy="no-referrer-when-downgrade"
                            />
                          ) : (
                            <div style={{display:'flex',alignItems:'center',justifyContent:'center',height:'100%',fontSize:13,color:'#6b7280',padding:12}}>
                              {geoLoading ? 'Loading Street View…' : 'Street View not available for this address. Showing map instead.'}
                            </div>
                          )
                        ) : (
                          <iframe
                            key={`map-${lat ?? addressQ}`}
                            title={'map'}
                            width="100%"
                            height="100%"
                            style={{ border: 0 }}
                            loading="lazy"
                            src={mapSrc}
                            referrerPolicy="no-referrer-when-downgrade"
                          />
                        )}
                      </div>
                    </div>
                  );
                })()}

                <Tabs value={detailTab} onChange={(_, v) => setDetailTab(v)} sx={{ mt: 1 }}>
                  <Tab value="details" label="Details" />
                  <Tab value="activity" label="Activity" />
                </Tabs>

                {detailTab === 'details' && (
                  <>
                    {(() => {
                      const lpSel = getLP(selected);
                      var _lp80Display = (typeof (selected as any).lp80 === 'number') ? (selected as any).lp80 : (typeof lpSel === 'number' ? Math.round(lpSel * 0.8) : null);
                      var _amv40Display = (typeof (selected as any).amv40 === 'number') ? (selected as any).amv40 : (typeof (selected as any).amv === 'number' ? Math.round((selected as any).amv * 0.4) : null);
                      var _amv30Display = (typeof (selected as any).amv30 === 'number') ? (selected as any).amv30 : (typeof (selected as any).amv === 'number' ? Math.round((selected as any).amv * 0.3) : null);
                      (selected as any).__lp80Display = _lp80Display;
                      (selected as any).__amv40Display = _amv40Display;
                      (selected as any).__amv30Display = _amv30Display;
                      return null;
                    })()}
                    {/* Deal fields in requested order */}
                    <Stack direction={{ xs: 'column', sm: 'row' }} gap={2} flexWrap="wrap">
                      <Info label="Full address" value={selected.fullAddress || selected.address || '—'} />
                      <Info label="L.P" value={fmt(getLP(selected))} />
                      <Info label="L.P 80%" value={fmt((selected as any).__lp80Display)} />
                      <Info label="AMV" value={fmt(selected.amv)} />
                      <Info label="AMV 40%" value={fmt((selected as any).__amv40Display)} />
                      <Info label="AMV 30%" value={fmt((selected as any).__amv30Display)} />
                      <Info
                        label="Offer amount"
                        value={fmt((() => {
                          const a = typeof (selected as any).__lp80Display === 'number' ? (selected as any).__lp80Display : NaN;
                          const b = typeof (selected as any).__amv40Display === 'number' ? (selected as any).__amv40Display : NaN;
                          if (Number.isFinite(a) && Number.isFinite(b)) return Math.min(a, b);
                          if (Number.isFinite(a)) return a;
                          if (Number.isFinite(b)) return b;
                          return null;
                        })())}
                      />
                      <Info
                        label="Email status"
                        value={isAutoEmailSent(selected) ? 'SENT' : 'UNSENT'}
                      />
                    </Stack>

                    {/* Beds / Baths / Sq Ft */}
                    <Stack direction={{ xs: 'column', sm: 'row' }} gap={2}>
                      <Info label="Bed" value={Number.isFinite(Number(selected.beds)) ? String(selected.beds) : '—'} />
                      <Info label="Bath" value={Number.isFinite(Number(selected.baths)) ? String(selected.baths) : '—'} />
                      <Info label="Sq Ft" value={Number.isFinite(Number((selected as any).squareFeet ?? selected.sqft)) ? String((selected as any).squareFeet ?? selected.sqft) : '—'} />
                    </Stack>

                    {/* Vendor valuations */}
                    <Stack direction={{ xs: 'column', sm: 'row' }} gap={2}>
                      <Info label="BofA valuation" value={fmt(selected.bofa_value)} />
                      <Info label="Redfin valuation" value={fmt((selected as any).redfin_adjusted ?? (selected as any).redfin_value ?? (selected as any).redfin)} />
                    </Stack>

                    {/* Agent details */}
                    <Stack direction="row" gap={2} flexWrap="wrap">
                      <Info label="Agent" value={selected.agentName ?? (selected as any).agent ?? 'Not found'} />
                      <Info label="Phone" value={selected.agentPhone ?? (selected as any).agent_phone ?? 'Not found'} />
                      <Info label="Email" value={selected.agentEmail ?? (selected as any).agent_email ?? 'Not found'} />
                    </Stack>

                    {/* Send email to agent (moved from table to details dialog) */}
                    {(() => {
                      const sid = String(getId(selected));
                      const eSel = edits[sid] || {};
                      return (
                        <div style={{ width: '100%', marginTop: 8, paddingTop: 8, borderTop: '1px solid #eee' }}>
                          <div style={{ fontWeight: 600, marginBottom: 6, color: '#111827' }}>Send email to agent</div>
                          <Stack direction="row" spacing={1} alignItems="center" sx={{ mt: 1, flexWrap: 'wrap' }}>
                            <TextField
                              id={`agent-name-${sid}`}
                              size="small"
                              placeholder="Agent name"
                              value={eSel.agentName ?? selected.agentName ?? ''}
                              onChange={(ev) => setEdit(sid, { agentName: (ev.target as HTMLInputElement).value })}
                              InputProps={{ style: { color: '#000' } }}
                              sx={{ minWidth: 160, '& .MuiInputBase-input::placeholder': { color: '#000', opacity: 1 } }}
                            />
                            <TextField
                              id={`agent-phone-${sid}`}
                              size="small"
                              placeholder="Agent phone"
                              value={eSel.agentPhone ?? selected.agentPhone ?? ''}
                              onChange={(ev) => setEdit(sid, { agentPhone: formatPhone((ev.target as HTMLInputElement).value) })}
                              InputProps={{ style: { color: '#000' } }}
                              sx={{ minWidth: 160, '& .MuiInputBase-input::placeholder': { color: '#000', opacity: 1 } }}
                            />
                            <TextField
                              id={`agent-email-${sid}`}
                              size="small"
                              placeholder="Agent email"
                              value={eSel.agentEmail ?? selected.agentEmail ?? (selected as any).agent_email ?? ''}
                              onChange={(ev) => setEdit(sid, { agentEmail: (ev.target as HTMLInputElement).value })}
                              InputProps={{ style: { color: '#000' } }}
                              sx={{ minWidth: 220, '& .MuiInputBase-input::placeholder': { color: '#000', opacity: 1 } }}
                            />
                            <Button size="small" variant="outlined" onClick={() => onSaveAgentOnly(selected)} disabled={!!eSel.busy}>
                              Save agent
                            </Button>
                            <Button size="small" variant="contained" onClick={() => onSend(selected)} disabled={!!eSel.busy}>
                              Send offer
                            </Button>
                          </Stack>
                        </div>
                      );
                    })()}
                  </>
                )}

                {detailTab === 'activity' && (
                  <div style={{ marginTop: 8 }}>
                    {(() => {
                      const os: any = (selected as any).offerStatus || {};
                      const last = os?.lastSentAt ? new Date(os.lastSentAt) : null;
                      return (
                        <div style={{ display: 'grid', gap: 8 }}>
                          <Info label="Last sent at" value={last ? last.toLocaleString() : '—'} />
                          <Info label="Message ID" value={os?.lastMessageId || '—'} />
                          <Info label="Sent by (subadminId)" value={os?.subadminId || '—'} />
                          <Info label="Last result" value={os?.lastResult || '—'} />
                        </div>
                      );
                    })()}
                  </div>
                )}
              </Stack>
            </DialogContent>
            <DialogActions>
              <Button onClick={() => setSelected(null)}>Close</Button>
            </DialogActions>
          </>
        )}
      </Dialog>
      <Snackbar open={toast.open} autoHideDuration={3000} onClose={() => setToast(t => ({ ...t, open: false }))}
        anchorOrigin={{ vertical: 'bottom', horizontal: 'center' }}>
        <Alert onClose={() => setToast(t => ({ ...t, open: false }))} severity={toast.sev} variant="filled" sx={{ width: '100%' }}>
          {toast.msg}
        </Alert>
      </Snackbar>
    </div>
  );
}



function Card({ title, value }: { title: string; value: number | string }) {
  return (
    <div style={{ border: '1px solid #eee', borderRadius: 10, padding: 16 }}>
      <div style={{ fontSize: 12, color: '#666' }}>{title}</div>
      <div style={{ fontSize: 26, fontWeight: 800, marginTop: 6, color: '#111' }}>{value}</div>
    </div>
  );
}

function Info({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div
      style={{
        flex: 1,
        minWidth: 180,
        background: '#fafafa',
        border: '1px solid #eee',
        borderRadius: 10,
        padding: '10px 12px',
      }}
    >
      <div style={{ fontSize: 12, color: '#6b7280', marginBottom: 4 }}>{label}</div>
      <div style={{ fontWeight: 600, color: '#111827' }}>{value}</div>
    </div>
  );
}

const tdBase: React.CSSProperties = {
  padding: '14px',
  borderBottom: '1px solid #eef2f7',
  color: '#111827',
  verticalAlign: 'top',
};
const tdR: React.CSSProperties = { ...tdBase, textAlign: 'right', whiteSpace: 'nowrap' };
const tdL: React.CSSProperties = { ...tdBase, textAlign: 'left' };
const tdLWide: React.CSSProperties = { ...tdL, minWidth: 260 };