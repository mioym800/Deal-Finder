// src/screens/Dashboard.tsx
import React, { useEffect, useState } from 'react';
import { getDashboardSummary, getDeals } from '../api.tsx';
import { useSearchParams } from 'react-router-dom';

// Shape of the summary payload expected from /api/dashboard/summary
// Adjust if your backend returns a slightly different envelope

type Summary = {
  totals: {
    properties: number;
    deals: number;
    statesCovered: number;
    subadmins: number;
  };
  dealsPerMonth: { month: string; count: number }[]; // e.g. [{ month: "2025-09", count: 12 }]
};

function normalizeSummary(resp: any): Summary | null {
  const payload = resp?.data ?? resp;
  if (!payload) return null;

  const pTotals = payload.totals || payload.summary?.totals || payload.result?.totals || payload.metrics || {};
  const normTotals = {
    properties: Number(pTotals.properties ?? pTotals.totalProperties ?? pTotals.props ?? 0),
    deals: Number(pTotals.deals ?? pTotals.totalDeals ?? pTotals.dealCount ?? 0),
    statesCovered: Number(pTotals.statesCovered ?? pTotals.states ?? pTotals.stateCount ?? 0),
    subadmins: Number(pTotals.subadmins ?? pTotals.subAdmins ?? pTotals.users ?? 0),
  };

  const dpm = payload.dealsPerMonth || payload.summary?.dealsPerMonth || payload.metrics?.dealsPerMonth || [];
  return { totals: normTotals, dealsPerMonth: Array.isArray(dpm) ? dpm : [] };
}

const toNum = (v: any): number | null => {
  if (v == null) return null;
  if (typeof v === 'number') return Number.isFinite(v) ? v : null;
  if (typeof v === 'string') {
    const n = Number(v.replace(/[$,]/g, '').trim());
    return Number.isFinite(n) ? n : null;
  }
  if (typeof v === 'object') {
    if ('$numberInt' in v) return Number((v as any)['$numberInt']);
    if ('$numberLong' in v) return Number((v as any)['$numberLong']);
    if ('$numberDouble' in v) return Number((v as any)['$numberDouble']);
  }
  return null;
};

const normalizeAddress = (addr: string) => {
  if (!addr) return '';
  let a = String(addr).toLowerCase().trim();
  a = a.replace(/[.,]/g, ' ').replace(/\s+/g, ' ');
  a = a.replace(/-\d{4}\b/g, ''); // strip ZIP+4
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
    west: 'w', w: 'w'
  };
  for (const [long, short] of Object.entries(replacements)) {
    const re = new RegExp(`\\b${long}\\b`, 'g');
    a = a.replace(re, short);
  }
  return a.replace(/\s+/g, ' ').trim();
};
const rowKey = (r: any) =>
  r._id || r.prop_id || normalizeAddress(r.fullAddress || r.address || '');
const dedupe = <T,>(items: T[], keyFn: (x: T) => string) => {
  const map = new Map<string, T>();
  for (const it of items) {
    const k = keyFn(it);
    if (!map.has(k)) map.set(k, it);
  }
  return Array.from(map.values());
};

export default function Dashboard() {
  const [data, setData] = useState<Summary | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [raw, setRaw] = useState<any>(null);
  const [showRaw, setShowRaw] = useState(false);

  useEffect(() => {
    (async () => {
      try {
        setError(null);
        // Load summary and deals in parallel
        const [summaryResp, dealsResp] = await Promise.all([
          getDashboardSummary(),
          getDeals() // server requests onlyDeals=true
        ]);
        setRaw(summaryResp);
        const normalized = normalizeSummary(summaryResp);
        // Safeguard parse of deals
        const arr: any[] = Array.isArray((dealsResp as any)?.rows)
          ? (dealsResp as any).rows
          : Array.isArray(dealsResp) ? (dealsResp as any) : [];
        const uniqueDeals = dedupe(arr, rowKey);
        const deals3Plus = uniqueDeals.filter((r: any) => {
          const b = toNum(r?.beds ?? r?.details?.beds ?? r?.bedrooms);
          const a = toNum(r?.amv);
          return typeof b === 'number' && b >= 3 && typeof a === 'number' && a >= 150000;
        });
        const patched = normalized
          ? {
              ...normalized,
              totals: {
                ...normalized.totals,
                deals: deals3Plus.length
              }
            }
          : normalized;
        setData(patched);
      } catch (e: any) {
        console.error('Failed to load summary', e);
        setError(e?.message || 'Failed to load summary');
      } finally {
        setLoading(false);
      }
    })();
  }, []);

  if (loading) return <div style={{ padding: 24 }}>Loading…</div>;
  if (error) return <div style={{ padding: 24, color: '#f87171' }}>{error}</div>;
  if (!data) return <div style={{ padding: 24 }}>No data</div>;

  return (
    <div style={{ padding: 24 }}>
      <h2 style={{ marginBottom: 16 }}>Admin Dashboard</h2>

      <div style={{
        display: 'grid',
        gridTemplateColumns: 'repeat(auto-fit, minmax(180px, 1fr))',
        gap: 16,
        marginBottom: 24,
      }}>
        <Card title="Total Properties" value={data.totals?.properties ?? 0} />
        <Card title="Total Deals" value={data.totals?.deals ?? 0} />
        <Card title="States Covered" value={data.totals?.statesCovered ?? 0} />
        <Card title="Subadmins" value={data.totals?.subadmins ?? 0} />
      </div>

      {(!data.totals?.properties && !data.totals?.deals && !data.totals?.statesCovered && !data.totals?.subadmins) && (
        <div style={{ marginBottom: 12, background: '#fff3cd', border: '1px solid #ffeeba', padding: 12, borderRadius: 8, color: '#664d03' }}>
          Heads up: the dashboard payload seems empty or differently shaped. Showing zeros. You can inspect the raw response below.
          <button onClick={() => setShowRaw((s:boolean)=>!s)} style={{ marginLeft: 12, padding: '4px 10px', borderRadius: 6, border: '1px solid #d39e00', background: '#ffecb5', cursor: 'pointer' }}>Toggle raw</button>
        </div>
      )}
      {showRaw && (
        <pre style={{ maxHeight: 240, overflow: 'auto', background: '#0b1021', color: '#d4d4d4', padding: 12, borderRadius: 8, marginBottom: 16 }}>
{JSON.stringify(raw, null, 2)}
        </pre>
      )}

      <h3 style={{ marginBottom: 8 }}>Deals per Month</h3>
      <div style={{ overflowX: 'auto' }}>
        <table style={{ width: '100%', borderCollapse: 'collapse' }}>
          <thead>
            <tr>
              <th style={{ textAlign: 'left', borderBottom: '1px solid #eee', padding: 8 }}>Month</th>
              <th style={{ textAlign: 'left', borderBottom: '1px solid #eee', padding: 8 }}>Deals</th>
            </tr>
          </thead>
          <tbody>
            {(data.dealsPerMonth || []).map((m) => (
              <tr key={m.month} style={{ borderBottom: '1px solid #f5f5f5' }}>
                <td style={{ padding: 8 }}>{m.month}</td>
                <td style={{ padding: 8 }}>{m.count}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
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