import { DateTime } from 'luxon';
const DISABLE = process.env.REDFIN_DISABLE_FILTERS === '1';

export const FILTERS = {
  priceMin: 400000,
  priceMax: 75000000,
  sqftMin: 1000,
  sqftMax: 50000,
  hoaNoOnly: true,
  dateRange: 'all', // 'all'|'1d'|'7d'|'14d'|'30d'
};

function withinPrice(p, min, max) {
  if (p.price == null) return false;
  return p.price >= min && p.price <= max;
}
function withinSqft(p, min, max) {
  if (p.sqft == null) return false;
  return p.sqft >= min && p.sqft <= max;
}
function hoaNo(p, required) {
  if (!required) return true;
  if (p.hoa == null) return false;
  return String(p.hoa).toLowerCase() === 'no';
}
function withinDateRange(p, range) {
  if (range === 'all') return true;
  if (!p.listedAt) return false;
  const dt = DateTime.fromISO(p.listedAt, { zone: 'utc' });
  if (!dt.isValid) return false;
  const days = range === '1d' ? 1 : range === '7d' ? 7 : range === '14d' ? 14 : 30;
  return dt >= DateTime.utc().minus({ days });
}

export function passesAll(p, cfg = FILTERS) {
  if (DISABLE) return true;
  return withinPrice(p, cfg.priceMin, cfg.priceMax)
      && withinSqft(p, cfg.sqftMin, cfg.sqftMax)
      && hoaNo(p, cfg.hoaNoOnly)
      && withinDateRange(p, cfg.dateRange);
}