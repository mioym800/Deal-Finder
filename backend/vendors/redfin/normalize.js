export function toNumberOrNull(s) {
    if (s == null) return null;
    if (typeof s === 'number') return isFinite(s) ? s : null;
    const cleaned = String(s).replace(/[^\d.]/g, '');
    if (!cleaned) return null;
    const n = Number(cleaned);
    return isFinite(n) ? n : null;
  }
  export function parseBeds(text) {
    if (!text) return null;
    const m = String(text).match(/(\d+(?:\.\d+)?)/);
    return m ? Number(m[1]) : null;
  }
  export function parseBaths(text) { return parseBeds(text); }
  export function propIdFromUrl(url) {
    const m = url.match(/\/home\/(\d+)/);
    return m ? m[1] : url;
  }
  export function cityFromAddress(addr) {
    if (!addr) return '';
    const parts = addr.split(',').map(s => s.trim());
    return parts.length >= 2 ? parts[1] : '';
  }
  export function lowerCI(s) { return (s || '').trim().toLowerCase(); }