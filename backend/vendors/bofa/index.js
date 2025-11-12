// vendors/bofa/index.js
const CANDIDATES = [
  ['./bofaAutomation.js', ['getHomeValue', 'scrapeBofa', 'fetchHomeValue', 'run']],
  ['./bofaJob.js',        ['getHomeValue', 'scrapeBofa', 'fetchHomeValue', 'run']],
];

async function resolveImpl() {
  for (const [path, names] of CANDIDATES) {
    try {
      const mod = await import(path);
      for (const name of names) if (typeof mod[name] === 'function') return mod[name];
    } catch {}
  }
  throw new Error('BofA scraper implementation not found in bofaAutomation.js or bofaJob.js');
}

function coerceNumber(maybe) {
  if (typeof maybe === 'number' && Number.isFinite(maybe)) return maybe;
  if (typeof maybe === 'string') {
    const m = maybe.replace(/[^0-9.]/g, '');
    const n = Number(m);
    if (Number.isFinite(n)) return n;
  }
  return null;
}

export async function getHomeValue(input) {
  const impl = await resolveImpl();

  // Accept either string (address) or object ctx
  const ctx = (typeof input === 'string') ? { address: input } : (input || {});

  // Try the implementation
  const result = await impl(ctx);

  // Accept common shapes: number | string | {value} | {estimate} | {price}
  const candidates = [
    result,
    result?.value,
    result?.estimate,
    result?.price,
    result?.data?.value,
    result?.data?.estimate,
  ];
  for (const c of candidates) {
    const num = coerceNumber(c);
    if (num !== null) return num;
  }

  // Nothing numeric → throw a clear error so caller can mark not_found properly
  throw new Error(`BofA returned no numeric value (got ${JSON.stringify(result)?.slice(0,120)}…)`);
}