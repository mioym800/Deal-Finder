// backend/utils/normalize.js
export function toNumber(value) {
    if (value === null || value === undefined) return null;
    const n = Number(String(value).replace(/[^\d.-]/g, '')); // strip $ , spaces etc.
    return Number.isFinite(n) ? n : null;
  }