import 'dotenv/config';
import OpenAI from 'openai';
import { chromium } from 'playwright';

const OPENAI_MODEL = process.env.OPENAI_MODEL || 'gpt-4o';
const DEBUG = process.env.DEBUG === '1';
const AGENT_TIMEOUT_MS = Number(process.env.AGENT_TIMEOUT_MS || 90000); // 90s cap
const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

// --- helpers ---------------------------------------------------------------
function extractPriceHeuristic(text = '') {
  // ex: $1,234,567  |  $899,000  |  $2.1M / $950k (M/B/k letters)
  const m = text.match(/\$\s?([0-9]{1,3}(?:,[0-9]{3})+|[0-9]+(?:\.[0-9])?\s?[MBkK])/);
  return m ? m[0].trim() : null;
}

function stripFencesToJSON(text) {
  if (!text) return text;
  const fence = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const candidate = (fence ? fence[1] : text).trim();
  const start = candidate.indexOf('{');
  const end = candidate.lastIndexOf('}');
  if (start !== -1 && end !== -1 && end > start) {
    return candidate.slice(start, end + 1);
  }
  return candidate;
}

function newContextStealthOptions() {
  return {
    userAgent:
      'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
    locale: 'en-US',
    timezoneId: 'America/New_York',
    viewport: { width: 1280, height: 900 },
    deviceScaleFactor: 2,
    hasTouch: false,
    isMobile: false
  };
}

async function makeBrowser() {
  const browser = await chromium.launch({
    headless: !DEBUG,
    ...(DEBUG ? { slowMo: 200 } : {}),
    args: ['--disable-blink-features=AutomationControlled']
  });
  const context = await browser.newContext(newContextStealthOptions());
  await context.addInitScript(() => {
    Object.defineProperty(navigator, 'webdriver', { get: () => false });
  });
  const page = await context.newPage();
  if (DEBUG) page.on('console', msg => console.log('PAGE:', msg.text()));
  return { browser, context, page };
}

function toolbeltFor(page) {
  return {
    async navigate({ url }) {
      if (DEBUG) console.log('[navigate]', url);
      await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 45000 });
      return { ok: true };
    },
    async fill({ selector, text }) {
      if (DEBUG) console.log('[fill]', selector, '→', text);
      await page.fill(selector, text, { timeout: 20000 });
      return { ok: true };
    },
    async click({ selector }) {
      if (DEBUG) console.log('[click]', selector);
      await page.click(selector, { timeout: 20000 });
      return { ok: true };
    },
    async press({ selector, key }) {
      if (DEBUG) console.log('[press]', selector, key);
      await page.focus(selector);
      await page.keyboard.press(key);
      return { ok: true };
    },
    async wait_for_selector({ selector, timeoutMs }) {
      if (DEBUG) console.log('[wait_for_selector]', selector, timeoutMs ?? 20000);
      await page.waitForSelector(selector, { timeout: timeoutMs ?? 20000 });
      return { ok: true };
    },
    async content() {
      const text = await page.innerText('body');
      return { ok: true, text: text.slice(0, 20000), hint: extractPriceHeuristic(text) };
    }
  };
}

const toolDefinitions = [
  { type: 'function', name: 'navigate', description: 'Go to URL', parameters: { type:'object', properties:{ url:{type:'string'} }, required:['url'] } },
  { type: 'function', name: 'fill', description: 'Type into selector', parameters: { type:'object', properties:{ selector:{type:'string'}, text:{type:'string'} }, required:['selector','text'] } },
  { type: 'function', name: 'click', description: 'Click selector', parameters: { type:'object', properties:{ selector:{type:'string'} }, required:['selector'] } },
  { type: 'function', name: 'press', description: 'Press key on selector', parameters: { type:'object', properties:{ selector:{type:'string'}, key:{type:'string'} }, required:['selector','key'] } },
  { type: 'function', name: 'wait_for_selector', description: 'Wait for selector', parameters: { type:'object', properties:{ selector:{type:'string'}, timeoutMs:{type:'number'} }, required:['selector'] } },
  { type: 'function', name: 'content', description: 'Return page text', parameters: { type:'object', properties:{} } }
];

// --- shared agent loop ------------------------------------------------------
async function runAgent({ page, preseed, systemContent, userMessages }) {
  // Optional pre-seed action (helps reliability)
  if (preseed) {
    try {
      await preseed(page);
    } catch (e) {
      if (DEBUG) console.log('[preseed error]', e.message);
    }
  }

  const tools = toolbeltFor(page);

  async function agentWork(messages) {
    for (let step = 0; step < 12; step++) {
      if (DEBUG) console.log('[agent] step', step);
      const res = await openai.responses.create({
        model: OPENAI_MODEL,
        input: messages,
        tools: toolDefinitions,
        tool_choice: 'auto'
      });

      const msg = res.output?.[0];
      if (!msg) throw new Error('No model output.');

      if (msg.type === 'message') {
        const raw = msg.content?.[0]?.text || JSON.stringify(msg.content);
        return stripFencesToJSON(raw);
      }

      if (msg.type === 'tool_call') {
        const { name, arguments: args } = msg;
        if (!tools[name]) throw new Error(`Unknown tool ${name}`);
        if (DEBUG) console.log('[tool_call]', name, args || {});
        try {
          const result = await tools[name](args || {});
          messages.push({ role: 'tool', content: JSON.stringify({ name, result }) });
        } catch (e) {
          messages.push({ role: 'tool', content: JSON.stringify({ name, error: String(e) }) });
        }
        continue;
      }

      messages.push({ role: 'assistant', content: JSON.stringify(msg) });
    }
    throw new Error('Max steps reached without a final answer.');
  }

  const system = [{ role: 'system', content: systemContent }];
  const messages = [...system, ...userMessages];

  const out = await Promise.race([
    agentWork(messages),
    new Promise((_, rej) => setTimeout(() => rej(new Error('Timed out')), AGENT_TIMEOUT_MS))
  ]);

  return out;
}

// --- Movoto ---------------------------------------------------------------
async function runMovotoAgent(address) {
  console.warn('\nNote: verify movoto.com Terms of Use before scraping.');
  const { browser, page } = await makeBrowser();

  try {
    const out = await runAgent({
      page,
      preseed: async (p) => {
        await p.goto('https://www.movoto.com/', { waitUntil: 'domcontentloaded', timeout: 45000 });
        const selectors = [
          'input[placeholder*="Address" i]',
          'input[placeholder*="City" i]',
          'input[type="search"]',
          'input[type="text"]',
          '[data-testid="searchInput"]',
          'input[aria-label*="Search" i]',
          'input[name="search"]'
        ];
        for (const sel of selectors) {
          try {
            await p.waitForSelector(sel, { timeout: 7000 });
            await p.fill(sel, address);
            await p.keyboard.press('Enter');
            try { await p.waitForLoadState('networkidle', { timeout: 12000 }); } catch {}
            if (DEBUG) console.log('[movoto seed] used:', sel);
            break;
          } catch { /* try next */ }
        }
      },
      systemContent:
`You are a web-retrieval agent. Goal: get the property LISTING PRICE from movoto.com for a given address, then reply ONLY with valid JSON:
{"price":"$X","address":"...","confidence":0-1,"notes":"how you found it, selectors used"}
Rules:
- Use the provided tools only.
- Prefer the property detail page.
- If multiple prices, pick the primary listing price.
- No Markdown or code fences.`,
      userMessages: [
        { role: 'user', content: `Address: ${address}` },
        { role: 'user', content: 'Start at https://www.movoto.com/ and use the site search.' }
      ]
    });
    return out;
  } finally {
    try { if (DEBUG) await page.screenshot({ path: 'movoto_last.png', fullPage: true }); } catch {}
    await page.context().browser().close();
  }
}

// --- Zillow (Zestimate) ----------------------------------------------------
async function runZillowAgent(address) {
  console.warn('\nNote: verify zillow.com Terms of Use before scraping.');
  const { browser, page } = await makeBrowser();

  try {
    const out = await runAgent({
      page,
      preseed: async (p) => {
        await p.goto('https://www.zillow.com/', { waitUntil: 'domcontentloaded', timeout: 45000 });
        const selectors = [
          'input[aria-label*="Search" i]',
          'input[placeholder*="Address" i]',
          'input[type="search"]',
          'input[name="citystatezip"]',
          '[data-testid="searchbox-input"]',
          'input[name="searchQuery"]',
          'input[type="text"]'
        ];
        for (const sel of selectors) {
          try {
            await p.waitForSelector(sel, { timeout: 7000 });
            await p.fill(sel, address);
            await p.keyboard.press('Enter');
            try { await p.waitForLoadState('networkidle', { timeout: 15000 }); } catch {}
            if (DEBUG) console.log('[zillow seed] used:', sel);
            break;
          } catch { /* try next */ }
        }
      },
      systemContent:
`You are a web-retrieval agent. Goal: find the Zestimate on zillow.com for the given address and reply ONLY with valid JSON:
{"zestimate":"$X","address":"...","confidence":0-1,"notes":"where you saw it, selectors used"}
Rules:
- Use the provided tools only.
- Prefer the property detail page.
- If multiple prices appear, pick the specific "Zestimate" label.
- Return plain JSON only (no Markdown/code fences).`,
      userMessages: [
        { role: 'user', content: `Address: ${address}` },
        { role: 'user', content: 'Start at https://www.zillow.com/ and use the site search.' }
      ]
    });
    return out;
  } finally {
    try { if (DEBUG) await page.screenshot({ path: 'zillow_last.png', fullPage: true }); } catch {}
    await page.context().browser().close();
  }
}

// CLI usage
if (process.argv[1].endsWith('agent.js') && process.argv[2]) {
  const addr = process.argv.slice(2).join(' ');
  runMovotoAgent(addr)
    .then(out => {
      try {
        const parsed = JSON.parse(out);
        console.log(`\n✅ Price for ${parsed.address}: ${parsed.price} (confidence ${parsed.confidence})`);
        if (parsed.notes) console.log('notes:', parsed.notes);
      } catch {
        console.log(out);
      }
    })
    .catch(err => {
      console.error('Failed:', err.message);
      process.exit(1);
    });
}

export { runMovotoAgent, runZillowAgent, extractPriceHeuristic };
