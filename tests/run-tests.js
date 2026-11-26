/* سُعرة V8 — end-to-end checks (Playwright, Chromium).
 *
 *   node tests/run-tests.js                                # serves the repo locally and runs every check
 *   TW_CSS=/path/to/tailwind.css node tests/run-tests.js   # recommended: render with a locally built Tailwind (npx tailwindcss with the
 *                                                          # same colour config as index.html) so pixel layout /
 *                                                          # contrast checks run too (without it they are skipped)
 *   SHOTS=/some/dir node tests/run-tests.js                # optional: save screenshots
 *
 * Every external service is mocked at the network layer: Gemini (REST + SSE streaming), USDA FoodData Central,
 * Open Food Facts, DeepSeek (REST + SSE) and the ZXing CDN. Legacy data is seeded on an intercepted blank URL.
 */
const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { chromium } = require('playwright');

const ROOT = path.resolve(__dirname, '..');
const PORT = 8765 + Math.floor(Math.random() * 400);
const BASE = `http://localhost:${PORT}`;
const SHOTS = process.env.SHOTS || '';
const TW_CSS = process.env.TW_CSS && fs.existsSync(process.env.TW_CSS) ? fs.readFileSync(process.env.TW_CSS, 'utf8') : '';

const results = [];
const ok = (name, cond, extra = '') => { results.push({ name, pass: !!cond, extra }); console.log(`${cond ? 'PASS' : 'FAIL'} ${name}${extra ? '  — ' + extra : ''}`); };
const shot = async (page, name, opts = {}) => { if (SHOTS) { await page.waitForTimeout(400); await page.screenshot({ path: path.join(SHOTS, name + '.png'), ...opts }); } };

// ---------- static server ----------
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.json': 'application/json', '.png': 'image/png', '.css': 'text/css' };
const server = http.createServer((req, res) => {
  const p = decodeURIComponent(req.url.split('?')[0]);
  const file = path.join(ROOT, p === '/' ? 'index.html' : p);
  if (!file.startsWith(ROOT) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) { res.writeHead(404); return res.end('nf'); }
  res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream' });
  fs.createReadStream(file).pipe(res);
});

// ---------- fixtures (old V6/V12 format: no breakdown / confidence / sourceKind fields) ----------
const DAY = (offset) => { const d = new Date(); d.setDate(d.getDate() - offset); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; };
const TS = (offset, h) => { const d = new Date(); d.setDate(d.getDate() - offset); d.setHours(h, 15, 0, 0); return d.getTime(); };
const oldMeal = (i, offset, h, title, cal) => ({
  id: 'meal_' + TS(offset, h) + i, date: DAY(offset), time: new Date(TS(offset, h)).toLocaleTimeString('ar-EG', { hour: '2-digit', minute: '2-digit' }),
  title, calories: cal, protein: 30, carbs: 40, fats: 12, notes: 'old', source: 'Gemini (gemini-3.5-flash-lite)', image: null, images: []
});
const V12_MEALS = [
  oldMeal(1, 0, 8, 'شوفان بالحليب', 380), oldMeal(2, 0, 14, 'دجاج ورز', 650), oldMeal(3, 1, 9, 'بيض وتوست', 420),
  oldMeal(4, 1, 21, 'كنافة', 520), oldMeal(5, 2, 13, 'سمك مشوي', 480), oldMeal(6, 3, 20, 'شاورما', 700), oldMeal(7, 5, 12, 'سلطة تونة', 350)
];
const V12_CHATS = [
  { id: 'chat_1', title: 'خطة التنشيف', date: DAY(1), messages: [{ role: 'assistant', text: 'أهلاً' }, { role: 'user', text: 'كم بروتين أحتاج؟' }, { role: 'assistant', text: '160 غرام' }] },
  { id: 'chat_2', title: 'عشاء', date: DAY(0), messages: [{ role: 'assistant', text: 'أهلاً' }, { role: 'user', text: 'اقترح عشاء' }, { role: 'assistant', text: 'زبادي يوناني' }] }
];
const V13_EXTRA = [oldMeal(8, 4, 10, 'وجبة من v13 فقط', 555), oldMeal(9, 6, 19, 'برجر من v13', 800)];
const GOAL = { mode: 'custom', targetCalories: 2300, tdeeBase: 2400, proteinRatio: 30, carbsRatio: 45, fatsRatio: 25 };

async function seedLegacy(page, opts = {}) {
  await page.route(`${BASE}/__seed__`, (r) => r.fulfill({ contentType: 'text/html', body: '<!doctype html><title>seed</title>' }));
  await page.goto(`${BASE}/__seed__`);
  await page.evaluate(async ({ V12_MEALS, V12_CHATS, V13_EXTRA, GOAL, opts }) => {
    const openDb = (name, version, upgrade) => new Promise((res, rej) => { const r = indexedDB.open(name, version); r.onupgradeneeded = (e) => upgrade(e.target.result); r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error); });
    const put = (db, store, value, key) => new Promise((res, rej) => { const tx = db.transaction(store, 'readwrite'); key === undefined ? tx.objectStore(store).put(value) : tx.objectStore(store).put(value, key); tx.oncomplete = res; tx.onerror = () => rej(tx.error); });
    const v12 = await openDb('Su3rahNativeDB_v12', 1, (db) => db.createObjectStore('data_store'));
    const kv = { su3rah_meals_db: V12_MEALS, su3rah_goal_profile: GOAL, su3rah_gemini_api_key: opts.geminiKey || 'AIzaTEST-old-key', su3rah_chat_sessions_v2: V12_CHATS,
      su3rah_active_chat_id: 'chat_2', su3rah_selected_model: 'gemini-3.1-flash-lite', su3rah_username: 'سالم',
      // V6 settings that used to make DeepSeek the default — V7 must still default to Gemini
      su3rah_ai_providers: { chatProvider: 'deepseek', analysisProvider: 'deepseek', deepseekChatModel: 'deepseek-chat', autoFallback: true } };
    if (opts.dsKey) kv.su3rah_deepseek_api_key = opts.dsKey;
    if (opts.usdaKey) kv.su3rah_usda_api_key = opts.usdaKey;
    for (const [k, v] of Object.entries(kv)) { await put(v12, 'data_store', v, k); if (!opts.noLocalMirror) localStorage.setItem(k, JSON.stringify(v)); }
    v12.close();
    localStorage.setItem('su3rah_audio_muted', '1');
    localStorage.setItem('su3rah_v5_config', JSON.stringify({ liveModels: 'gemini-live-test', embedModel: 'gemini-embedding-001', voice: 'Kore' }));
    localStorage.setItem('su3rah_v5_insights', JSON.stringify({ at: Date.now(), list: [{ title: 'نمط قديم', body: 'تأكل حلويات ليلاً', confidence: 70 }] }));
    localStorage.setItem('su3rah-usage', JSON.stringify({ day: 'x', c: {} }));
    localStorage.setItem('su3rah-cooldown', '{}');
    localStorage.setItem('su3rah-model-map', JSON.stringify({ tag: 'x', t: 0, list: [] }));
    localStorage.setItem('last_11pm_reminder_day', '2020-01-01');
    localStorage.setItem('other_app_key', 'must-survive-wipe');
    if (opts.legacy) {
      const v13 = await openDb('Su3rahNativeDB_v13', 1, (db) => db.createObjectStore('data_store'));
      await put(v13, 'data_store', [...V12_MEALS.slice(0, 3), ...V13_EXTRA], 'su3rah_meals_db');
      await put(v13, 'data_store', [{ id: 'chat_v13', title: 'محادثة v13', date: '2026-10-20', messages: [{ role: 'user', text: 'سؤال قديم' }, { role: 'assistant', text: 'جواب قديم' }] }], 'su3rah_chat_sessions_v2');
      v13.close();
      const nl = await openDb('nutrilens-db', 1, (db) => { const s = db.createObjectStore('meals', { keyPath: 'id' }); s.createIndex('day', 'day'); db.createObjectStore('settings', { keyPath: 'key' }); db.createObjectStore('chats', { keyPath: 'id' }); });
      const d = new Date(); d.setDate(d.getDate() - 10); d.setHours(13, 5);
      const day = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
      await put(nl, 'meals', { id: 'nl_abc123', day, createdAt: d.getTime(), name: 'كبسة لحم (nutrilens)', cal: 900, p: 45.5, c: 95, f: 33, photo: null, notes: '' });
      await put(nl, 'chats', { id: 'nlchat1', title: 'محادثة nutrilens', updatedAt: d.getTime(), messages: [{ role: 'user', text: 'مرحبا' }, { role: 'model', text: 'أهلاً' }] });
      await put(nl, 'settings', { key: 'main', value: { name: 'قديم', apiKey: 'AIza-nutrilens' } });
      nl.close();
      localStorage.setItem('su3rah_chat_history', JSON.stringify([{ role: 'assistant', text: 'ترحيب' }, { role: 'user', text: 'رسالة من v1' }, { role: 'assistant', text: 'رد v1' }]));
    }
    if (opts.extraLs) for (const [k, v] of Object.entries(opts.extraLs)) localStorage.setItem(k, v);
  }, { V12_MEALS, V12_CHATS, V13_EXTRA, GOAL, opts });
  await page.unroute(`${BASE}/__seed__`);
}

const TW_BODY = `window.tailwind={};${TW_CSS ? `(function(){var s=document.createElement('style');s.textContent=${JSON.stringify(TW_CSS)};document.head.appendChild(s);})();` : ''}`;
async function newContext(browser, extra = {}) {
  const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 1, locale: 'ar', permissions: ['microphone', 'camera'], serviceWorkers: 'block', ...extra });
  await ctx.route(/cdn\.tailwindcss\.com/, (r) => r.fulfill({ contentType: 'text/javascript', body: TW_BODY }));
  await ctx.route(/fonts\.(googleapis|gstatic)\.com/, (r) => r.fulfill({ contentType: 'text/css', body: '' }));
  return ctx;
}
const booted = (page) => page.waitForFunction(() => typeof state !== 'undefined' && state.booted === true, null, { timeout: 20000 });
const openApp = async (page) => { await page.goto(`${BASE}/index.html`); await booted(page); };
const idbRead = (page, db, key) => page.evaluate(({ db, key }) => new Promise((res) => { const r = indexedDB.open(db); r.onsuccess = () => { const d = r.result; if (!d.objectStoreNames.contains('data_store')) { d.close(); return res(undefined); } const g = d.transaction('data_store').objectStore('data_store').get(key); g.onsuccess = () => { d.close(); res(g.result); }; }; }), { db, key });
const dbNames = (page) => page.evaluate(async () => (await indexedDB.databases()).map((d) => d.name).sort());
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const lastToast = (page) => page.evaluate(() => document.getElementById('toast-text').innerText);

// ---------- Mocks ----------
const SSE = (chunks) => chunks.map((c) => `data: ${JSON.stringify(c)}\r\n\r\n`).join('');
const LEAK_REPLY = `Captain Su'ra (Nutrition and Fitness Coach). Smart, friendly, encouraging.\n* User asks about the gym.\n* Option A: banana + whey.\n* Draft: short Saudi reply.\nيا بطل، بما إنك طالع للنادي كل موزة متوسطة (120 جم) مع سكوب واي.\nالموزة طاقة سريعة والبروتين يحمي عضلاتك 💪 ✅`;
function mockGemini(ctx, behaviour = {}) {
  const log = [];
  ctx.route(/generativelanguage\.googleapis\.com/, async (route) => {
    const req = route.request(); const url = req.url();
    const body = req.postData() ? JSON.parse(req.postData()) : null;
    log.push({ url, body });
    const h = { 'Access-Control-Allow-Origin': '*', 'Content-Type': 'application/json' };
    if (/\/models\?/.test(url)) return route.fulfill({ headers: h, body: JSON.stringify({ models: [] }) });
    if (behaviour.status) return route.fulfill({ status: behaviour.status, headers: h, body: JSON.stringify({ error: { code: behaviour.status, message: behaviour.status === 400 ? 'API key not valid' : 'quota' } }) });
    if (/batchEmbedContents/.test(url)) return route.fulfill({ headers: h, body: JSON.stringify({ embeddings: body.requests.map((_, i) => ({ values: Array.from({ length: 8 }, (_, j) => Math.sin(i + j)) })) }) });
    if (behaviour.thinking400 && body.generationConfig && body.generationConfig.thinkingConfig) return route.fulfill({ status: 400, headers: h, body: JSON.stringify({ error: { code: 400, message: 'thinkingConfig is not supported for this model' } }) });
    const sys = JSON.stringify(body.systemInstruction || '');
    const all = JSON.stringify(body.contents || []);
    let text, parts = null;
    if (/محلل وجبات/.test(sys)) {
      if (/كوب حليب/.test(all)) text = JSON.stringify({ title: 'كوب حليب', items: [{ name_ar: 'حليب', name_en: 'milk whole', grams: 240, unit: 'ml', state: 'n/a', confidence: 0.9 }] });
      else if (/شوفان بالموز/.test(all)) text = JSON.stringify({ title: 'شوفان بالموز', items: [{ name_ar: 'شوفان', name_en: 'oats', grams: 50, state: 'raw', confidence: 0.9 }, { name_ar: 'موز', name_en: 'bananas raw', grams: 100, state: 'raw', confidence: 0.9 }] });
      else if (/200 جرام رز مطبوخ/.test(all)) text = JSON.stringify({ title: 'رز ودجاج مشوي', items: [
        { name_ar: 'رز أبيض مطبوخ', name_en: 'rice white cooked', grams: 200, state: 'cooked', confidence: 0.95 },
        { name_ar: 'صدر دجاج مشوي', name_en: 'chicken breast roasted', grams: 150, state: 'cooked', confidence: 0.95 },
        { name_ar: 'زيت زيتون', name_en: 'olive oil', grams: 13.5, state: 'n/a', confidence: 0.9 }] });
      else if (/inlineData/.test(all)) text = JSON.stringify({ title: 'طبق مصوّر', items: [{ name_ar: 'رز', name_en: 'rice white', grams: 180, state: 'n/a', confidence: 0.6 }, { name_ar: 'دجاج مقلي', name_en: 'chicken breast fried', grams: 120, state: 'fried', confidence: 0.6 }] });
      else text = JSON.stringify({ title: 'وجبة', items: [{ name_ar: 'موز', name_en: 'bananas raw', grams: 118, state: 'raw', confidence: 0.8 }] });
    } else if (/قارئ ملصقات/.test(sys) && behaviour.label) text = JSON.stringify(behaviour.label);
    else if (/قارئ ملصقات/.test(sys)) text = JSON.stringify({ product_name: 'بار شوفان بالبروتين', basis: 'per_serving', serving_size_g: 40, kcal: 160, kj: null, protein_g: 10, carbs_g: 22, fat_g: 3, readable: true });
    else if (/تقدّر القيم الغذائية التقريبية/.test(sys)) text = JSON.stringify({ estimates: [{ name: 'x', kcal: 420, protein: 5, carbs: 55, fat: 20 }] });
    else if (/كابتن سُعرة/.test(sys)) {
      text = behaviour.leak ? LEAK_REPLY : 'هلا والله يا بطل! أموري تمام.\nوش ودك نشتغل عليه اليوم؟';
      parts = [{ thought: true, text: 'Planning: the user greets me. I should answer briefly in Saudi Arabic. Option A...' }, { text }];
    } else if (/insights/.test(all)) text = JSON.stringify({ insights: [{ title: 'نمط Gemini', body: 'بناءً على الأنماط...', tip: 'كل بروتين', confidence: 80 }] });
    else if (/ملاحظة واحدة من سطرين/.test(sys)) text = 'أسبوعك ممتاز في البروتين.\nزد الماء كوبين يومياً.';
    else text = 'متصل';
    parts = parts || [{ text }];
    if (/streamGenerateContent/.test(url)) {
      const chunks = [{ candidates: [{ content: { role: 'model', parts: [parts[0]] } }] }];
      const rest = parts.slice(1).map((p) => p.text).join('') || '';
      if (parts.length > 1) { const mid = Math.floor(rest.length / 2); chunks.push({ candidates: [{ content: { role: 'model', parts: [{ text: rest.slice(0, mid) }] } }] }); chunks.push({ candidates: [{ content: { role: 'model', parts: [{ text: rest.slice(mid) }] }, finishReason: 'STOP' }] }); }
      return route.fulfill({ headers: { 'Access-Control-Allow-Origin': '*', 'Content-Type': 'text/event-stream' }, body: SSE(chunks) });
    }
    return route.fulfill({ headers: h, body: JSON.stringify({ candidates: [{ content: { parts }, finishReason: 'STOP' }] }) });
  });
  return log;
}
// USDA FoodData Central — real SR Legacy values (per 100 g)
const NUT = (kcal, p, c, f, energyId = 1008) => [{ nutrientId: energyId, nutrientNumber: energyId === 1008 ? '208' : '957', nutrientName: 'Energy', unitName: 'KCAL', value: kcal },
  { nutrientId: 1003, nutrientNumber: '203', nutrientName: 'Protein', unitName: 'G', value: p }, { nutrientId: 1004, nutrientNumber: '204', nutrientName: 'Total lipid (fat)', unitName: 'G', value: f },
  { nutrientId: 1005, nutrientNumber: '205', nutrientName: 'Carbohydrate, by difference', unitName: 'G', value: c }];
const USDA_DB = [
  [/rice/, [{ fdcId: 168877, description: 'Rice, white, long-grain, regular, raw, enriched', dataType: 'SR Legacy', foodNutrients: NUT(365, 7.13, 79.95, 0.66) },
    { fdcId: 168878, description: 'Rice, white, long-grain, regular, enriched, cooked', dataType: 'SR Legacy', foodNutrients: NUT(130, 2.69, 28.17, 0.28) },
    { fdcId: 169704, description: 'Rice, brown, long-grain, cooked', dataType: 'SR Legacy', foodNutrients: NUT(123, 2.74, 25.58, 0.97) }]],
  [/chicken/, [{ fdcId: 171077, description: 'Chicken, broiler or fryers, breast, skinless, boneless, meat only, raw', dataType: 'SR Legacy', foodNutrients: NUT(120, 22.5, 0, 2.62) },
    { fdcId: 172386, description: 'Chicken, broilers or fryers, breast, meat and skin, cooked, fried, batter', dataType: 'SR Legacy', foodNutrients: NUT(260, 24.84, 8.99, 13.2) },
    { fdcId: 171477, description: 'Chicken, broilers or fryers, breast, meat only, cooked, roasted', dataType: 'SR Legacy', foodNutrients: NUT(165, 31.02, 0, 3.57) }]],
  [/olive oil/, [{ fdcId: 171413, description: 'Oil, olive, salad or cooking', dataType: 'SR Legacy', foodNutrients: NUT(884, 0, 0, 100) }]],
  [/oil/, [{ fdcId: 172336, description: 'Oil, canola', dataType: 'SR Legacy', foodNutrients: NUT(884, 0, 0, 100) }]],
  [/banana/, [{ fdcId: 1105314, description: 'Bananas, ripe and slightly ripe, raw', dataType: 'Foundation', foodNutrients: NUT(97, 0.74, 23, 0.29, 2047) }, { fdcId: 173944, description: 'Bananas, raw', dataType: 'SR Legacy', foodNutrients: NUT(89, 1.09, 22.84, 0.33) }]],
  [/dates/, [{ fdcId: 171726, description: 'Dates, deglet noor', dataType: 'SR Legacy', foodNutrients: NUT(282, 2.45, 75.03, 0.39) }]],
  [/whey/, [{ fdcId: 173180, description: 'Beverages, Whey protein powder isolate', dataType: 'SR Legacy', foodNutrients: NUT(359, 78.13, 6.25, 1.56) }]]
];
function mockUSDA(ctx, behaviour = {}) {
  const log = [];
  ctx.route(/api\.nal\.usda\.gov/, (route) => {
    const u = new URL(route.request().url()); log.push(u);
    const h = { 'Access-Control-Allow-Origin': '*', 'Content-Type': 'application/json' };
    if (behaviour.badKey || u.searchParams.get('api_key') === 'BAD') return route.fulfill({ status: 403, headers: h, body: JSON.stringify({ error: { code: 'API_KEY_INVALID', message: 'An invalid api_key was supplied.' } }) });
    if (behaviour.rate) return route.fulfill({ status: 429, headers: h, body: JSON.stringify({ error: { code: 'OVER_RATE_LIMIT' } }) });
    const q = (u.searchParams.get('query') || '').toLowerCase();
    const hit = USDA_DB.find(([re]) => re.test(q));
    return route.fulfill({ headers: h, body: JSON.stringify({ totalHits: hit ? hit[1].length : 0, foods: hit ? hit[1] : [] }) });
  });
  return log;
}
function mockOFF(ctx) {
  const log = [];
  ctx.route(/openfoodfacts\.org/, (route) => {
    const url = route.request().url(); log.push(url);
    const h = { 'Access-Control-Allow-Origin': '*', 'Content-Type': 'application/json' };
    if (/6281007012345/.test(url)) return route.fulfill({ headers: h, body: JSON.stringify({ status: 1, code: '6281007012345', product: { product_name: 'لبن زبادي كامل الدسم', brands: 'المراعي', serving_quantity: 170, nutriments: { 'energy-kcal_100g': 63, proteins_100g: 3.3, carbohydrates_100g: 4.7, fat_100g: 3.5 } } }) });
    return route.fulfill({ status: 404, headers: h, body: JSON.stringify({ status: 0, status_verbose: 'product not found' }) });
  });
  return log;
}
function mockDeepSeek(ctx, behaviour = {}) {
  const log = [];
  ctx.route('https://api.deepseek.com/**', async (route) => {
    const req = route.request(); const url = new URL(req.url());
    const entry = { path: url.pathname, auth: req.headers()['authorization'] || '', body: req.postData() ? JSON.parse(req.postData()) : null };
    log.push(entry);
    const cors = { 'Access-Control-Allow-Origin': BASE, 'Content-Type': 'application/json' };
    if (behaviour.status) return route.fulfill({ status: behaviour.status, headers: cors, body: JSON.stringify({ error: { message: 'mock error ' + behaviour.status } }) });
    if (url.pathname === '/models') return route.fulfill({ headers: cors, body: JSON.stringify({ object: 'list', data: [{ id: 'deepseek-chat' }, { id: 'deepseek-reasoner' }] }) });
    if (url.pathname === '/user/balance') return route.fulfill({ headers: cors, body: JSON.stringify({ is_available: true, balance_infos: [{ currency: 'USD', total_balance: '4.20' }] }) });
    const b = entry.body;
    if (b.stream) {
      const chunks = [{ model: b.model, choices: [{ delta: { reasoning_content: 'The user wants... Option A: suggest yogurt.' } }] },
        { model: b.model, choices: [{ delta: { content: '<think>internal plan</think>' } }] },
        { model: b.model, choices: [{ delta: { content: 'رد DeepSeek: كل 200 جم زبادي يوناني.' } }] },
        { model: b.model, choices: [], usage: { prompt_tokens: 300, completion_tokens: 40, total_tokens: 340 } }];
      return route.fulfill({ headers: { ...cors, 'Content-Type': 'text/event-stream' }, body: SSE(chunks) + 'data: [DONE]\r\n\r\n' });
    }
    return route.fulfill({ headers: cors, body: JSON.stringify({ id: 'x', model: b.model, choices: [{ index: 0, message: { role: 'assistant', content: 'رد DeepSeek' } }], usage: { prompt_tokens: 3, completion_tokens: 4 } }) });
  });
  return log;
}
const mockAll = (ctx, b = {}) => ({ gemini: mockGemini(ctx, b.gemini), usda: mockUSDA(ctx, b.usda), off: mockOFF(ctx), ds: mockDeepSeek(ctx, b.ds) });

// Pixel-ish colour helpers (run in page)
const SCAN_COLORS = () => {
  const parse = (s) => { const m = String(s).match(/rgba?\(([^)]+)\)/); if (!m) return null; const p = m[1].split(/[,\s/]+/).filter(Boolean).map(Number); return { r: p[0], g: p[1], b: p[2], a: p.length > 3 ? p[3] : 1 }; };
  const lum = (c) => { const f = (v) => { v /= 255; return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; }; return 0.2126 * f(c.r) + 0.7152 * f(c.g) + 0.0722 * f(c.b); };
  const cr = (a, b) => { const x = lum(a), y = lum(b); return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05); };
  const OLD_BROWN = [[12, 8, 6], [20, 13, 8], [28, 19, 13], [39, 28, 20], [58, 43, 32], [82, 61, 46], [200, 138, 88], [197, 163, 122]];
  const isOldBrownText = (c) => [[200, 138, 88], [197, 163, 122], [224, 176, 136], [171, 131, 87]].some(([r, g, b]) => Math.abs(c.r - r) + Math.abs(c.g - g) + Math.abs(c.b - b) < 9);
  const isOldBrown = (c) => OLD_BROWN.some(([r, g, b]) => Math.abs(c.r - r) + Math.abs(c.g - g) + Math.abs(c.b - b) < 9);
  const pageBg = parse(getComputedStyle(document.body).backgroundColor);
  const over = (c, base) => ({ r: c.r * c.a + base.r * (1 - c.a), g: c.g * c.a + base.g * (1 - c.a), b: c.b * c.a + base.b * (1 - c.a), a: 1 });
  const effBg = (el) => { let e = el; while (e && e !== document.documentElement) { const cs = getComputedStyle(e); const c = parse(cs.backgroundColor); if (c && c.a > 0.85) return c; if (cs.backgroundImage && cs.backgroundImage.includes('gradient')) { const g = parse(cs.backgroundImage); if (g && g.a > 0.5) return over(g, pageBg); } e = e.parentElement; } return pageBg; };
  const visible = (el) => { const r = el.getBoundingClientRect(); const cs = getComputedStyle(el); return r.width > 0 && r.height > 0 && cs.visibility !== 'hidden' && cs.display !== 'none' && +cs.opacity > 0.05 && !el.closest('.hidden'); };
  const brown = [], white = [], lowContrast = [];
  document.querySelectorAll('body *').forEach((el) => {
    if (!visible(el) || el.closest('svg') || el.tagName === 'IMG' || el.tagName === 'CANVAS' || el.closest('#splash') || el.closest('[data-theme-pick]')) return;
    const cs = getComputedStyle(el);
    const bg = parse(cs.backgroundColor);
    if (bg && bg.a > 0.3 && isOldBrown(bg)) brown.push(el.id || el.className.toString().slice(0, 40));
    if (bg && bg.a > 0.5 && bg.r > 225 && bg.g > 225 && bg.b > 225) white.push(el.id || el.tagName + '.' + el.className.toString().slice(0, 40));
    const own = [...el.childNodes].some((n) => n.nodeType === 3 && n.textContent.trim().length > 1);
    if (own) {
      const fg = parse(cs.color); if (!fg || fg.a < 0.3) return;
      if (isOldBrownText(fg)) brown.push('text:' + (el.id || el.className.toString().slice(0, 30)));
      const ratio = cr(fg, effBg(el)); const big = parseFloat(cs.fontSize) >= 18.6 || (parseFloat(cs.fontSize) >= 14 && +cs.fontWeight >= 700);
      if (ratio < (big ? 3 : 4.5) && fg.a > 0.75 && !/disabled/.test(el.className)) lowContrast.push(`${el.textContent.trim().slice(0, 18)}(${ratio.toFixed(2)})`);
    }
  });
  return { brown: [...new Set(brown)].slice(0, 10), white: [...new Set(white)].slice(0, 10), lowContrast: [...new Set(lowContrast)].slice(0, 12), pageBg };
};

(async () => {
  await new Promise((r) => server.listen(PORT, r));
  const browser = await chromium.launch({ args: ['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream'] });
  const errors = [];
  const watch = (page, label) => { page.on('pageerror', (e) => errors.push(`${label}: ${e.message}`)); page.on('dialog', (d) => d.accept(page.__answer !== undefined ? String(page.__answer) : undefined).catch(() => {})); };

  // =============== 1. MIGRATION: old storage format fully preserved, old days load ===============
  {
    const ctx = await newContext(browser); mockAll(ctx);
    const page = await ctx.newPage(); watch(page, 'migration');
    await seedLegacy(page);
    await openApp(page);
    const s = await page.evaluate(() => ({ meals: state.meals.map((m) => m.id), goal: state.goalConfig, key: state.apiKey, name: state.userName, chats: state.chatSessions.map((c) => c.id), active: state.activeChatId, model: state.selectedModel, muted: state.audioMuted, chatModel: state.chatModel }));
    ok('migration: all 7 old meals present', V12_MEALS.every((m) => s.meals.includes(m.id)) && s.meals.length === 7, `${s.meals.length} meals`);
    ok('migration: no sample meal injected', !s.meals.includes('meal-init-1'));
    ok('migration: goal / name / Gemini key / model / mute kept', s.goal.targetCalories === 2300 && s.name === 'سالم' && s.key === 'AIzaTEST-old-key' && s.model === 'gemini-3.1-flash-lite' && s.muted === true);
    ok('migration: chats + active chat kept', ['chat_1', 'chat_2'].every((c) => s.chats.includes(c)) && s.active === 'chat_2');
    ok('migration: coach defaults to Gemini 3.5 Flash Lite even though V6 settings said DeepSeek', s.chatModel.provider === 'gemini' && s.chatModel.model === 'gemini-3.5-flash-lite', JSON.stringify(s.chatModel));
    // every old day renders its old-format meals
    const perDay = await page.evaluate(async (days) => { const out = {}; for (const d of days) { state.selectedDate = d; renderApp(); out[d] = document.querySelectorAll('#meals-container [data-swipe]').length; } state.selectedDate = state.todayDate; renderApp(); return out; }, [...new Set(V12_MEALS.map((m) => m.date))]);
    const expected = {}; V12_MEALS.forEach((m) => { expected[m.date] = (expected[m.date] || 0) + 1; });
    ok('migration: every old day loads and renders its meals', Object.keys(expected).every((d) => perDay[d] === expected[d]), JSON.stringify(perDay));
    const oldCard = await page.evaluate(() => { const c = document.querySelector('#meals-container [data-swipe]'); return c ? c.innerText : ''; });
    ok('migration: old meal (no breakdown/confidence fields) displays with calories + macros', /650|380/.test(oldCard) && /P 30g/.test(oldCard), oldCard.slice(0, 80));
    const lsKeys = await page.evaluate(() => Object.keys(localStorage));
    const mustKeep = ['su3rah_meals_db', 'su3rah_goal_profile', 'su3rah_gemini_api_key', 'su3rah_chat_sessions_v2', 'su3rah_active_chat_id', 'su3rah_selected_model', 'su3rah_username', 'su3rah_audio_muted', 'su3rah_v5_config', 'su3rah_v5_insights', 'su3rah-cooldown', 'su3rah-model-map', 'last_11pm_reminder_day', 'su3rah_ai_providers'];
    ok('migration: every old localStorage key still exists', mustKeep.every((k) => lsKeys.includes(k)), mustKeep.filter((k) => !lsKeys.includes(k)).join(','));
    const idbMeals = await idbRead(page, 'Su3rahNativeDB_v12', 'su3rah_meals_db');
    ok('migration: Su3rahNativeDB_v12/data_store still holds the 7 meals, unchanged', Array.isArray(idbMeals) && idbMeals.length === 7 && idbMeals.every((m) => { const o = V12_MEALS.find((x) => x.id === m.id); return o && o.calories === m.calories && o.title === m.title && !m.breakdown; }));
    const names = await dbNames(page);
    ok('migration: main DB not renamed/re-versioned; new data uses a NEW database', names.includes('Su3rahNativeDB_v12') && !names.some((n) => /Su3rahNativeDB_v1[3-9]/.test(n)), names.join(','));
    const ver = await page.evaluate(() => new Promise((r) => { const q = indexedDB.open('Su3rahNativeDB_v12'); q.onsuccess = () => { const v = q.result.version; const st = [...q.result.objectStoreNames]; q.result.close(); r({ v, st }); }; }));
    ok('migration: Su3rahNativeDB_v12 still version 1 with only data_store', ver.v === 1 && ver.st.join() === 'data_store', JSON.stringify(ver));
    ok('migration: V5 config (voice) kept', await page.evaluate(() => V5Config.v.voice) === 'Kore');
    await page.reload(); await booted(page);
    ok('migration: reload is stable (no duplicates, no sample)', await page.evaluate(() => state.meals.length) === 7);
    const hours = await page.evaluate(() => [su3rahHourOf({ time: '08:30 ص' }), su3rahHourOf({ time: '٠٩:١٥ م' }), su3rahHourOf({ time: '12:05 ص' }), su3rahHourOf({ time: '7:45 PM' })]);
    ok('hourOf parses localized old time strings', hours.join() === '8,21,0,19', JSON.stringify(hours));
    await shot(page, '01-dashboard-royal-roast');
    await ctx.close();
  }

  // =============== 2. RESCUE from older DB names / schemas ===============
  {
    const ctx = await newContext(browser); mockAll(ctx);
    const page = await ctx.newPage(); watch(page, 'rescue');
    await seedLegacy(page, { legacy: true });
    await openApp(page);
    const s = await page.evaluate(() => ({ ids: state.meals.map((m) => m.id), nl: state.meals.find((m) => m.id === 'nl_abc123'), chats: state.chatSessions.map((c) => c.id) }));
    ok('rescue: meals only in Su3rahNativeDB_v13 merged', V13_EXTRA.every((m) => s.ids.includes(m.id)));
    ok('rescue: overlapping ids de-duplicated', s.ids.length === new Set(s.ids).size && s.ids.length === 10, `${s.ids.length}`);
    ok('rescue: nutrilens-db meal mapped', s.nl && s.nl.title.includes('كبسة') && s.nl.calories === 900 && s.nl.protein === 45.5);
    ok('rescue: chats from v13, nutrilens-db and su3rah_chat_history merged', ['chat_v13', 'nlchat1'].every((c) => s.chats.includes(c)) && s.chats.some((c) => c.startsWith('legacy_history')));
    const names = await dbNames(page);
    ok('rescue: legacy databases left untouched', ['Su3rahNativeDB_v13', 'nutrilens-db', 'Su3rahNativeDB_v12'].every((n) => names.includes(n)), names.join(','));
    await ctx.close();
  }

  // =============== 3. SLOW / FAILED IndexedDB never seeds over data ===============
  {
    const ctx = await newContext(browser); mockAll(ctx);
    const page = await ctx.newPage(); watch(page, 'slow-idb');
    await seedLegacy(page, { noLocalMirror: true });
    await page.addInitScript(() => {
      const realGet = IDBObjectStore.prototype.get; const until = Date.now() + 9000;
      IDBObjectStore.prototype.get = function (key) { if (Date.now() < until && this.name === 'data_store') return {}; return realGet.call(this, key); };
    });
    await openApp(page);
    const s1 = await page.evaluate(() => ({ n: state.meals.length, seed: state.meals.some((m) => m.id === 'meal-init-1'), verified: DataGuard.verified.meals }));
    ok('slow IDB: no sample meal while IndexedDB is unreadable', !s1.seed && s1.n === 0 && s1.verified === false, JSON.stringify(s1));
    await page.evaluate(() => { quickAddFood('موزة أثناء التعطل', 105, 1, 27, 0); });
    await page.waitForFunction(() => DataGuard.verified.meals === true, null, { timeout: 25000 });
    await page.waitForTimeout(600);
    const s2 = await page.evaluate(() => ({ n: state.meals.length, banana: state.meals.some((m) => m.title.includes('موزة أثناء')) }));
    ok('slow IDB: once readable, original data restored AND new meal merged', s2.n === 8 && s2.banana, JSON.stringify(s2));
    ok('slow IDB: IndexedDB now holds 7 originals + 1 new', (await idbRead(page, 'Su3rahNativeDB_v12', 'su3rah_meals_db')).length === 8);
    await ctx.close();
    const ctx2 = await newContext(browser); const p2 = await ctx2.newPage(); watch(p2, 'failed-open');
    await seedLegacy(p2, { noLocalMirror: true });
    await p2.addInitScript(() => { const realOpen = IDBFactory.prototype.open; IDBFactory.prototype.open = function (name) { if (name === 'Su3rahNativeDB_v12') { const req = {}; setTimeout(() => req.onerror && req.onerror(new Event('error')), 20); return req; } return realOpen.apply(this, arguments); }; });
    await openApp(p2);
    ok('failed IDB open + empty mirror: still no sample meal', await p2.evaluate(() => !state.meals.some((m) => m.id === 'meal-init-1') && state.meals.length === 0));
    await ctx2.close();
  }

  // =============== 4. FIRST RUN (truly empty) ===============
  {
    const ctx = await newContext(browser); mockAll(ctx);
    const page = await ctx.newPage(); watch(page, 'first-run');
    await openApp(page);
    ok('first run: sample meal seeded exactly once on a truly empty device', await page.evaluate(() => state.meals.length === 1 && state.meals[0].id === 'meal-init-1'));
    await page.evaluate(() => deleteMeal('meal-init-1'));
    await page.waitForTimeout(300);
    await page.reload(); await booted(page);
    ok('first run: sample not re-seeded after the user deleted it', await page.evaluate(() => state.meals.length === 0));
    await shot(page, '02-empty-state');
    await ctx.close();
  }

  // =============== 5. THEMES: 6 dark themes (Royal Roast default), animated background, nothing white, readable, pre-paint ===============
  {
    const ctx = await newContext(browser); mockAll(ctx);
    const page = await ctx.newPage(); watch(page, 'themes');
    await seedLegacy(page, { usdaKey: 'USDA-OK', extraLs: { su3rah_theme: 'midnight' } }); await openApp(page);
    const def = await page.evaluate(() => ({ attr: document.documentElement.dataset.theme, meta: document.querySelector('meta[name="theme-color"]').content, bg: getComputedStyle(document.body).backgroundColor, oldKey: localStorage.getItem('su3rah_theme') }));
    ok('themes: Royal Roast is the default (espresso #0E0907), old V7 theme key left untouched', def.attr === 'roast' && def.meta === '#0E0907' && def.bg === 'rgb(14, 9, 7)' && def.oldKey === 'midnight', JSON.stringify(def));
    const rr = await page.evaluate(() => ({ p: cssVar('--primary-rgb'), hi: cssVar('--primary-hi'), t: cssVar('--text-rgb'), s: [1, 2, 3].map((i) => cssVar(`--surface-${i}-rgb`)) }));
    ok('themes: Royal Roast = caramel-gold #D9A066 / gold #F0C27B / cream #F6EBDD on espresso surfaces', rr.p === '217 160 102' && rr.hi === '#F0C27B' && rr.t === '246 235 221' && rr.s.join('|') === '23 16 12|32 22 15|43 30 21', JSON.stringify(rr));
    const vars = await page.evaluate(() => ['--bg', '--surface-1', '--surface-2', '--surface-3', '--border', '--primary', '--primary-glow', '--accent', '--text', '--text-muted', '--protein', '--carbs', '--fats', '--success', '--warning', '--danger', '--ring-gradient', '--orb-1', '--orb-2', '--orb-3'].filter((v) => !cssVar(v)));
    ok('themes: full CSS variable set defined (incl. --warning, --ring-gradient, --orb-1/2/3)', !vars.length, vars.join(','));
    await page.evaluate(() => { quickAddSnack('banana'); toggleFavorite(safeId(state.meals[0].id)); });
    const THEMES = { roast: [14, 9, 7, '#0E0907'], midnight: [10, 11, 16, '#0A0B10'], emerald: [7, 16, 13, '#07100D'], plum: [14, 10, 20, '#0E0A14'], sapphire: [7, 11, 20, '#070B14'], copper: [12, 12, 13, '#0C0C0D'] };
    for (const [name, [r, g, b, meta]] of Object.entries(THEMES)) {
      await page.evaluate((n) => applyTheme(n), name);
      await page.waitForTimeout(150);
      const info = await page.evaluate(() => ({ attr: document.documentElement.getAttribute('data-theme'), meta: document.querySelector('meta[name="theme-color"]').content, ls: localStorage.getItem('su3rah_theme_v8'), bg: getComputedStyle(document.body).backgroundColor,
        orbs: [...document.querySelectorAll('#ambient-bg .orb')].map((o) => getComputedStyle(o).backgroundImage).filter((x) => /radial-gradient/.test(x)).length, dust: document.querySelectorAll('#ambient-bg .dust').length,
        anim: getComputedStyle(document.querySelector('#ambient-bg .orb')).animationName, dur: parseFloat(getComputedStyle(document.querySelector('#ambient-bg .orb')).animationDuration) }));
      ok(`theme ${name}: applied instantly (attr, saved under the new key, meta theme-color, body bg)`, info.attr === name && info.ls === name && info.meta === meta && info.bg === `rgb(${r}, ${g}, ${b})`, JSON.stringify(info).slice(0, 160));
      ok(`theme ${name}: animated background — 4 glowing orbs + gold dust, slow 20–40 s loops`, info.orbs === 4 && info.dust >= 6 && /orb/.test(info.anim) && info.dur >= 20 && info.dur <= 40, JSON.stringify({ o: info.orbs, d: info.dust, a: info.anim, s: info.dur }));
      const issues = { white: [], low: [] };
      for (const tab of ['dashboard', 'history', 'chat', 'command', 'settings']) {
        await page.evaluate((t) => switchTab(t), tab); await page.waitForTimeout(TW_CSS ? 250 : 60);
        const r2 = await page.evaluate(SCAN_COLORS);
        issues.white.push(...r2.white.map((x) => tab + ':' + x)); issues.low.push(...r2.lowContrast.map((x) => tab + ':' + x));
      }
      await page.evaluate(() => { switchTab('dashboard'); openMealModal(); }); await page.waitForTimeout(150);
      const rm = await page.evaluate(SCAN_COLORS); issues.white.push(...rm.white); issues.low.push(...rm.lowContrast.map((x) => 'modal:' + x));
      await page.evaluate(() => { closeMealModal(); openProductEditor(null, { name: 'حليب' }); }); await page.waitForTimeout(150);
      const rp = await page.evaluate(SCAN_COLORS); issues.white.push(...rp.white); issues.low.push(...rp.lowContrast.map((x) => 'product:' + x));
      await page.evaluate(() => closeProductEditor());
      ok(`theme ${name}: nothing white anywhere (tabs, meal sheet, product editor)`, !issues.white.length, issues.white.slice(0, 6).join(' | '));
      if (TW_CSS) ok(`theme ${name}: all visible text passes WCAG AA contrast on top of the animated background`, !issues.low.length, issues.low.slice(0, 6).join(' | '));
      await shot(page, `03-theme-${name}`);
    }
    const tokens = await page.evaluate((names) => {
      const out = {}; const lum = (rgb) => { const f = (v) => { v /= 255; return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; }; return 0.2126 * f(rgb[0]) + 0.7152 * f(rgb[1]) + 0.0722 * f(rgb[2]); };
      const cr = (a, b) => { const x = lum(a), y = lum(b); return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05); };
      for (const n of names) { applyTheme(n, false); const v = (k) => cssVar(`--${k}-rgb`).split(/\s+/).map(Number);
        out[n] = Math.min(...['bg', 'surface-1', 'surface-2', 'surface-3'].flatMap((s) => ['text', 'text-muted', 'primary', 'protein', 'carbs', 'fats'].map((k) => cr(v(k), v(s)))), cr(v('on-primary'), v('primary')));
        const m = ['protein', 'carbs', 'fats'].map(v); out[n + '_macros'] = Math.min(...[[0, 1], [0, 2], [1, 2]].map(([i, j]) => m[i].reduce((a, x, k) => a + Math.abs(x - m[j][k]), 0))) > 90; }
      applyTheme('roast', false); return out; }, Object.keys(THEMES));
    ok('themes: text / muted / primary / macro colours ≥ 4.5:1 on every surface in all 6 themes', Object.entries(tokens).filter(([k]) => !k.endsWith('_macros')).every(([, v]) => v >= 4.5), JSON.stringify(tokens));
    ok('themes: protein, carbs and fats colours stay clearly distinct in every theme', Object.entries(tokens).filter(([k]) => k.endsWith('_macros')).every(([, v]) => v));
    await page.evaluate(() => { switchTab('settings'); }); await page.waitForTimeout(200);
    ok('themes: Settings → المظهر shows 6 live preview swatches', await page.locator('[data-theme-pick]').count() === 6);
    await page.click('[data-theme-pick="sapphire"]');
    ok('themes: tapping a swatch switches theme', await page.evaluate(() => document.documentElement.dataset.theme) === 'sapphire');
    // animation pauses when the tab is hidden
    const paused = await page.evaluate(() => { Object.defineProperty(document, 'hidden', { configurable: true, get: () => true }); document.dispatchEvent(new Event('visibilitychange')); const st = getComputedStyle(document.querySelector('#ambient-bg .orb')).animationPlayState;
      Object.defineProperty(document, 'hidden', { configurable: true, get: () => false }); document.dispatchEvent(new Event('visibilitychange')); return [st, getComputedStyle(document.querySelector('#ambient-bg .orb')).animationPlayState]; });
    ok('background: paused while the tab is hidden, resumes when visible', paused[0] === 'paused' && paused[1] === 'running', paused.join());
    await page.reload(); await booted(page);
    ok('themes: chosen theme persists after reload', await page.evaluate(() => document.documentElement.dataset.theme === 'sapphire' && localStorage.getItem('su3rah_theme_v8') === 'sapphire'));
    await ctx.close();
    // pre-paint: no flash
    const ctx2 = await newContext(browser); mockAll(ctx2); const p2 = await ctx2.newPage(); watch(p2, 'prepaint');
    await seedLegacy(p2, { extraLs: { su3rah_theme_v8: 'plum' } });
    await p2.addInitScript(() => { document.addEventListener('readystatechange', () => { if (!window.__firstBg && document.body) window.__firstBg = { theme: document.documentElement.dataset.theme, bg: getComputedStyle(document.body).backgroundColor }; }); });
    await openApp(p2);
    const fp = await p2.evaluate(() => window.__firstBg);
    ok('themes: saved theme applied before first paint (no flash)', fp && fp.theme === 'plum' && fp.bg === 'rgb(14, 10, 20)', JSON.stringify(fp));
    await ctx2.close();
    // reduced motion → static background
    const ctx3 = await newContext(browser, { reducedMotion: 'reduce' }); mockAll(ctx3); const p3 = await ctx3.newPage(); watch(p3, 'reduced-motion');
    await openApp(p3);
    const rm = await p3.evaluate(() => ({ a: getComputedStyle(document.querySelector('#ambient-bg .orb')).animationName, d: getComputedStyle(document.querySelector('#ambient-bg .dust')).animationName, bg: getComputedStyle(document.querySelector('#ambient-bg .orb')).backgroundImage }));
    ok('background: static version with prefers-reduced-motion (orbs still glow, nothing moves)', rm.a === 'none' && rm.d === 'none' && /radial-gradient/.test(rm.bg), JSON.stringify(rm).slice(0, 120));
    await ctx3.close();
    // splash ≤ 1.2 s
    const ctx4 = await newContext(browser); mockAll(ctx4); const p4 = await ctx4.newPage(); watch(p4, 'splash');
    const t0 = Date.now(); await p4.goto(`${BASE}/index.html`);
    await p4.waitForFunction(() => document.getElementById('splash').classList.contains('hide'), null, { timeout: 5000 });
    const splashMs = Date.now() - t0;
    ok('splash: icon.png with soft glow, hidden within ~1.2 s', splashMs <= 1500 && await p4.evaluate(() => /icon\.png/.test(document.querySelector('#splash img').src) && /splashGlow/.test(getComputedStyle(document.querySelector('#splash .logo')).animationName)), `${splashMs} ms`);
    await ctx4.close();
  }

  // =============== 6. NUTRITION ENGINE: understanding → USDA numbers → confirmation card ===============
  {
    const ctx = await newContext(browser); const M = mockAll(ctx);
    const page = await ctx.newPage(); watch(page, 'nutrition');
    await seedLegacy(page, { usdaKey: 'USDA-OK' }); await openApp(page);
    await page.evaluate(() => openMealModal());
    await page.fill('#ai-description', '200 جرام رز مطبوخ و150 جرام صدر دجاج مشوي وملعقة زيت زيتون');
    await page.click('#btn-submit-ai');
    await page.waitForSelector('#modal-confirm:not(.hidden)', { timeout: 10000 });
    await shot(page, '04-confirm-card', { fullPage: false });
    const und = M.gemini.find((l) => l.body && /محلل وجبات/.test(JSON.stringify(l.body.systemInstruction || '')));
    ok('engine: Gemini receives an understanding-only systemInstruction (no calories asked)', und && /ممنوع منعاً باتاً كتابة أي سعرات/.test(JSON.stringify(und.body.systemInstruction)) && und.body.generationConfig.responseMimeType === 'application/json');
    const usdaUrls = M.usda.map((u) => u.toString());
    ok('engine: USDA called with api_key, dataType=Foundation,SR Legacy, pageSize=5', usdaUrls.length >= 3 && usdaUrls.every((u) => /api_key=USDA-OK/.test(u) && /dataType=Foundation%2CSR%20Legacy|dataType=Foundation,SR%20Legacy/.test(u) && /pageSize=5/.test(u)), usdaUrls[0]);
    const C = await page.evaluate(() => ({ items: Confirm.items.map((i) => ({ n: i.name_ar, g: i.grams, s: i.source, d: i.sourceName, kcal: i.per100.kcal })), T: confirmTotals(), pills: [...document.querySelectorAll('#confirm-items .pill')].map((p) => p.textContent.trim()), q: document.getElementById('confirm-questions').innerText.trim(), totalTxt: document.getElementById('confirm-kcal').textContent }));
    ok('engine: 3 ingredients, each sourced from USDA', C.items.length === 3 && C.items.every((i) => i.s === 'usda') && C.pills.filter((p) => p === 'USDA').length === 3, JSON.stringify(C.items.map((i) => i.s)));
    ok('engine: correct raw/cooked USDA match picked (cooked rice, roasted breast)', /enriched, cooked/.test(C.items[0].d) && /meat only, cooked, roasted/.test(C.items[1].d) && /olive/i.test(C.items[2].d), C.items.map((i) => i.d).join(' | '));
    const exp = { kcal: 200 * 1.30 + 150 * 1.65 + 13.5 * 8.84, p: 200 * 0.0269 + 150 * 0.3102, c: 200 * 0.2817, f: 200 * 0.0028 + 150 * 0.0357 + 13.5 };
    ok('engine: math is correct (626.8 kcal · P 51.9 · C 56.3 · F 19.4)', Math.abs(C.T.kcal - exp.kcal) < 0.5 && Math.abs(C.T.p - exp.p) < 0.1 && Math.abs(C.T.c - exp.c) < 0.1 && Math.abs(C.T.f - exp.f) < 0.1 && C.totalTxt === '627', JSON.stringify(C.T));
    ok('engine: no smart question when state + oil are already known', C.q === '', C.q);
    // live slider update
    await page.locator('#confirm-items [data-ci="0"] input[type="number"]').fill('300');
    ok('engine: editing grams updates totals live', await page.evaluate(() => document.getElementById('confirm-kcal').textContent) === String(Math.round(exp.kcal + 130)));
    await page.locator('#confirm-items [data-ci="0"] input[type="number"]').fill('200');
    // raw/cooked toggle
    await page.evaluate(() => setConfirmState(0, 'raw')); await page.waitForTimeout(200);
    ok('engine: raw/cooked toggle re-matches USDA (raw rice 365 kcal/100g)', await page.evaluate(() => Confirm.items[0].per100.kcal === 365 && /raw/.test(Confirm.items[0].sourceName)));
    await page.evaluate(() => setConfirmState(0, 'cooked')); await page.waitForTimeout(200);
    // swap to another match
    await page.evaluate(() => swapConfirmItem(1)); await page.waitForTimeout(100);
    ok('engine: "swap" lists other USDA matches', await page.locator('#confirm-items [data-ci="1"] .swap-box button').count() >= 2);
    await page.evaluate(() => swapConfirmItem(1));
    await page.click('#btn-confirm-save');
    await page.waitForTimeout(300);
    const meal = await page.evaluate(() => state.meals[0]);
    ok('engine: saved meal stores breakdown + sources + confidence', meal.calories === 627 && meal.breakdown.length === 3 && meal.breakdown.every((b) => b.source === 'usda' && b.fdcId) && meal.confidence === 'high', JSON.stringify({ cal: meal.calories, conf: meal.confidence }));
    ok('engine: meal card shows a confidence badge', /دقة عالية/.test(await page.locator('#meals-container [data-swipe]').first().innerText()));
    const before = M.usda.length;
    await page.evaluate(async () => { const r = await resolveItem({ name_ar: 'رز', name_en: 'rice white cooked', grams: 100, state: 'cooked' }); window.__r = r.per100.kcal; });
    ok('engine: USDA results cached in IndexedDB (no second network call)', M.usda.length === before && await page.evaluate(() => window.__r) === 130);
    ok('engine: USDA cache lives in a NEW database Su3rahFoodCache_v1', (await dbNames(page)).includes('Su3rahFoodCache_v1'));
    // smart questions
    const q = await page.evaluate(async () => { const items = []; for (const it of parseItemsLocally('200 جرام رز و150 جرام صدر دجاج مقلي').items) items.push(await resolveItem(it)); await openConfirm({ title: 't', items, origin: 'ai' }); return document.getElementById('confirm-questions').innerText; });
    ok('engine: asks "raw or cooked?" for rice and "how many spoons of oil?" for fried food', /نيء أم مطبوخ/.test(q) && /كم ملعقة زيت/.test(q), q.replace(/\n/g, ' ').slice(0, 120));
    await page.evaluate(() => answerOil(2)); await page.waitForTimeout(150);
    ok('engine: answering the oil question adds 27 g oil', await page.evaluate(() => Confirm.items.some((i) => /oil/.test(i.name_en) && i.grams === 27)));
    await page.evaluate(() => closeConfirm());
    // sanity checks
    const w = await page.evaluate(() => [sanityWarnings({ kcal: 500, p: 10, c: 10, f: 10 }, []).length, sanityWarnings({ kcal: 2100, p: 100, c: 250, f: 78 }, []).length, sanityWarnings({ kcal: 170, p: 10, c: 20, f: 6 }, [{ name_ar: 'x', grams: 900 }]).length, sanityWarnings({ kcal: 170, p: 10, c: 20, f: 6 }, []).length]);
    ok('engine: sanity check warns on kcal ≠ P×4+C×4+F×9 (>15%) and on unusually large meals', w[0] === 1 && w[1] === 1 && w[2] === 1 && w[3] === 0, JSON.stringify(w));
    // Arabic table + estimate
    const t = await page.evaluate(async () => { const a = await resolveItem({ name_ar: 'كبسة دجاج', name_en: 'chicken kabsa', grams: 300, state: 'cooked' }); const b = await resolveItem({ name_ar: 'جبنة حلوم', name_en: 'halloumi', grams: 50, state: 'n/a' }); const c = await resolveItem({ name_ar: 'حلوى المشمش الغريبة', name_en: 'xyzzy sweet', grams: 80, state: 'n/a' }); await estimateMissing([c]); return [a.source, a.verify, b.source, b.verify, /ملصقات/.test(b.sourceName), c.source, c.per100.kcal]; });
    ok('engine: Arabic table entries (recipe & label-average) carry source + "needs verification"', t[0] === 'table' && t[1] === true && t[2] === 'table' && t[3] === true && t[4], JSON.stringify(t));
    ok('engine: unknown food → AI estimate labelled تقديري', t[5] === 'estimate' && t[6] === 420, JSON.stringify(t));
    const pillEst = await page.evaluate(() => getComputedStyle(Object.assign(document.body.appendChild(document.createElement('span')), { className: 'pill pill-estimate' })).color);
    const pillOk = await page.evaluate(() => getComputedStyle(Object.assign(document.body.appendChild(document.createElement('span')), { className: 'pill pill-trusted' })).color);
    const want = await page.evaluate(() => [`rgb(${cssVar('--warn-rgb').split(' ').join(', ')})`, `rgb(${cssVar('--success-rgb').split(' ').join(', ')})`]);
    ok('engine: source pills use the warning colour for estimates and the success colour for trusted', pillEst === want[0] && pillOk === want[1], pillEst + ' / ' + pillOk);
    await ctx.close();

    // bad USDA key → Arabic error; offline / no key → local parser + embedded USDA reference gives the same numbers
    const ctx2 = await newContext(browser); mockAll(ctx2, { usda: { badKey: true } });
    const p2 = await ctx2.newPage(); watch(p2, 'usda-errors');
    await seedLegacy(p2, { usdaKey: 'BAD' }); await openApp(p2);
    await p2.evaluate(() => testUsdaConnection()); await p2.waitForTimeout(300);
    ok('engine: bad USDA key → clear Arabic error', /مفتاح USDA غير صالح/.test(await p2.locator('#usda-key-status').innerText()));
    const off = await p2.evaluate(async () => { state.usdaKey = ''; state.apiKey = ''; const u = parseItemsLocally('200 جرام رز مطبوخ و150 جرام صدر دجاج مشوي وملعقة زيت زيتون'); const items = []; for (const it of u.items) items.push(await resolveItem(it)); const T = items.reduce((a, it) => { const t = itemTotals(it); a.kcal += t.kcal; a.p += t.p; return a; }, { kcal: 0, p: 0 }); return { n: items.length, g: items.map((i) => i.grams), st: items.map((i) => i.state), src: items.map((i) => i.source), kcal: Math.round(T.kcal), p: r1(T.p) }; });
    ok('engine: offline local parser understands the sentence (200 g / 150 g / 13.5 g)', off.n === 3 && off.g.join() === '200,150,13.5' && off.st.join() === 'cooked,cooked,n/a', JSON.stringify(off));
    ok('engine: offline numbers come from the embedded USDA reference (627 kcal)', off.src.every((s) => s === 'usda') && off.kcal === 627 && off.p === 51.9, JSON.stringify(off));
    await ctx2.close();
  }

  // =============== 7. BARCODE + LABEL PHOTO + RECIPES ===============
  {
    const ctx = await newContext(browser); const M = mockAll(ctx);
    await ctx.route(/cdn\.jsdelivr\.net\/npm\/@zxing/, (r) => r.fulfill({ contentType: 'text/javascript', body: 'window.ZXingBrowser={BrowserMultiFormatReader:function(){this.decodeFromConstraints=function(c,v,cb){window.__zxingUsed=true;setTimeout(function(){cb({getText:function(){return "6281007012345"}})},300);return Promise.resolve({stop:function(){}})}}};' }));
    const page = await ctx.newPage(); watch(page, 'barcode');
    await page.addInitScript(() => { try { delete window.BarcodeDetector; } catch (_) {} window.BarcodeDetector = undefined; delete window.BarcodeDetector; });
    await seedLegacy(page, { usdaKey: 'USDA-OK' }); await openApp(page);
    page.__answer = '170';
    await page.evaluate(() => { openMealModal(); setEntryMode('barcode'); });
    await page.evaluate(() => startBarcodeScan());
    await page.waitForSelector('#modal-confirm:not(.hidden)', { timeout: 8000 });
    ok('barcode: iPhone path (no BarcodeDetector) loads ZXing from CDN and decodes', await page.evaluate(() => window.__zxingUsed === true));
    const b = await page.evaluate(() => ({ it: Confirm.items[0], T: confirmTotals(), pill: document.querySelector('#confirm-items .pill').textContent }));
    ok('barcode: Open Food Facts per-100 g nutriments × grams eaten → confirmation card', b.it.source === 'barcode' && b.it.grams === 170 && Math.round(b.T.kcal) === 107 && b.pill === 'باركود', JSON.stringify(b.T));
    await page.click('#btn-confirm-save-product');
    await page.waitForSelector('#modal-product:not(.hidden)');
    const pf = await page.evaluate(() => ({ name: document.getElementById('product-name').value, kcal: document.getElementById('product-kcal').value, bc: document.getElementById('product-barcode').value, src: document.getElementById('product-source').value, kw: document.getElementById('product-keywords').value }));
    ok('barcode result: «احفظ كمنتج من منتجاتي» opens the product editor prefilled (name, per-100, barcode, source)', /لبن زبادي/.test(pf.name) && pf.kcal === '63' && pf.bc === '6281007012345' && pf.src === 'barcode' && /لبن/.test(pf.kw), JSON.stringify(pf));
    await page.click('#btn-product-save'); await page.waitForTimeout(250);
    ok('barcode result: confirmation item now uses the saved product (منتجاتي badge)', await page.evaluate(() => Confirm.items[0].source === 'product' && document.querySelector('#confirm-items .pill').textContent === 'منتجاتي'));
    await page.click('#btn-confirm-save'); await page.waitForTimeout(300);
    ok('barcode: product stored under the NEW key su3rah_my_products', await page.evaluate(() => JSON.parse(localStorage.getItem('su3rah_my_products')).some((f) => f.barcode === '6281007012345' && f.per100.kcal === 63)));
    const offCalls = M.off.length;
    await page.evaluate(() => { openMealModal(); setEntryMode('barcode'); lookupBarcode('6281007012345'); }); await page.waitForTimeout(300);
    ok('barcode: second scan served from My Products (no network)', M.off.length === offCalls && await page.evaluate(() => Confirm.items[0].source === 'product'));
    await page.evaluate(() => { closeConfirm(); lookupBarcode('0000000000017'); }); await page.waitForTimeout(400);
    ok('barcode: not found → offers "صوّر جدول القيمة الغذائية"', /صوّر جدول القيمة الغذائية/.test(await page.locator('#barcode-status').innerText()));
    // label photo
    page.__answer = '40';
    await page.evaluate(() => setEntryMode('label'));
    await page.setInputFiles('#label-gallery-input', path.join(ROOT, 'icon-512.png'));
    await page.waitForSelector('#modal-confirm:not(.hidden)', { timeout: 8000 });
    const L = await page.evaluate(() => ({ it: Confirm.items[0], sys: '' }));
    ok('label: printed per-serving numbers converted to per 100 g (160 kcal/40 g → 400)', L.it.source === 'label' && L.it.per100.kcal === 400 && L.it.per100.p === 25 && L.it.grams === 40, JSON.stringify(L.it.per100));
    const labelReq = M.gemini.find((l) => l.body && /قارئ ملصقات/.test(JSON.stringify(l.body.systemInstruction || '')));
    ok('label: Gemini is told to read ONLY printed numbers', labelReq && /لا تقدّر ولا تخمّن/.test(JSON.stringify(labelReq.body.systemInstruction)));
    await page.click('#btn-confirm-save'); await page.waitForTimeout(300);
    ok('label: meal logged with the label source', await page.evaluate(() => state.meals[0].breakdown[0].source === 'label' && state.meals[0].title === 'بار شوفان بالبروتين'));
    // recipe (no Gemini key → local parser; USDA live)
    page.__answer = undefined;
    const R = await page.evaluate(async () => {
      state.apiKey = '';
      openRecipeEditor(); document.getElementById('recipe-name').value = 'كبستي';
      document.getElementById('recipe-ingredients-text').value = '500 جرام رز نيء و1 كيلو صدر دجاج نيء و3 ملاعق زيت';
      await recipeParseIngredients(); document.getElementById('recipe-cooked-weight').value = '2400'; saveRecipe();
      const r = state.x.recipes[0]; return { name: r.name, n: r.items.length, g: r.items.map((i) => i.grams), per100: r.per100, cw: r.cookedWeight };
    });
    const rk = (500 * 3.65 + 1000 * 1.2 + 40.5 * 8.84) / 24;
    ok('recipe: created from ingredients + total cooked weight', R.name === 'كبستي' && R.n === 3 && R.g.join() === '500,1000,40.5' && R.cw === 2400 && Math.abs(R.per100.kcal - rk) < 0.2, JSON.stringify(R));
    await page.evaluate(() => { openMealModal(); setEntryMode('recipe'); }); await page.fill('#recipe-pick-list input', '300'); await page.click('#recipe-pick-list button');
    await page.waitForSelector('#modal-confirm:not(.hidden)');
    await page.click('#btn-confirm-save'); await page.waitForTimeout(300);
    ok('recipe: "300 g of my kabsa" logged with correct macros', await page.evaluate((rk) => Math.abs(state.meals[0].calories - Math.round(rk * 3)) <= 1 && state.meals[0].title === 'كبستي', rk));
    const viaText = await page.evaluate(async () => (await resolveItem({ name_ar: 'كبستي', name_en: 'kabsa', grams: 200 })).source);
    ok('recipe: typing the recipe name in the AI box matches My Recipes first', viaText === 'recipe');
    await page.waitForTimeout(500);
    ok('badges: first barcode, first label, first product and first recipe unlocked', await page.evaluate(() => ['first_barcode', 'first_label', 'first_recipe', 'first_product'].every((k) => state.x.badges[k])));
    await ctx.close();
  }

  // =============== 8. COACH: no leaked reasoning, short replies, streaming, systemInstruction ===============
  {
    const ctx = await newContext(browser); const M = mockAll(ctx, { gemini: { leak: true } });
    const page = await ctx.newPage(); watch(page, 'coach');
    await seedLegacy(page); await openApp(page);
    ok('coach: sanitizeCoachReply fixture → only the Arabic answer', await page.evaluate(() => selfTestSanitizer()));
    const san = await page.evaluate(() => [sanitizeCoachReply('<think>plan in English</think>\nهلا يا بطل'), sanitizeCoachReply('## الخلاصة: كل بروتين\n**مهم**: اشرب ماء 😀 😀')]);
    ok('coach: strips <think>, headings, bold and keeps max 1 emoji', san[0] === 'هلا يا بطل' && !/#|\*\*/.test(san[1]) && (san[1].match(/😀/g) || []).length === 1, JSON.stringify(san));
    await page.evaluate(() => { state.x.weight = [{ id: 'w1', date: addDays(state.todayDate, -8), kg: 84 }, { id: 'w2', date: state.todayDate, kg: 83.2 }];
      state.x.products = [{ id: 'prod_t', name: 'حليب المراعي كامل الدسم', brand: 'المراعي', keywords: ['حليب'], per100: { kcal: 62, p: 3.1, c: 4.7, f: 3.4 }, basis: 'ml', serving: 240, servingUnit: 'cup' }]; switchTab('chat'); });
    await page.fill('#input-chat-text', 'رايح النادي وش آكل؟'); await page.click('[aria-label="إرسال"]');
    await page.waitForFunction(() => !state.isChatThinking, null, { timeout: 10000 });
    const reply = await page.evaluate(() => getActiveChatSession().messages.slice(-1)[0]);
    ok('coach: leaked English persona/planning removed — reply starts with the Arabic answer', /^يا بطل، بما إنك طالع للنادي/.test(reply.text) && !/[A-Za-z]{4,}/.test(reply.text), reply.text);
    ok('coach: at most 1 emoji in the reply', (reply.text.match(/\p{Extended_Pictographic}/gu) || []).length <= 1);
    const req = M.gemini.filter((l) => /streamGenerateContent/.test(l.url)).slice(-1)[0];
    ok('coach: uses streamGenerateContent (SSE)', !!req && /alt=sse/.test(req.url));
    const sys = JSON.stringify(req.body.systemInstruction);
    ok('coach: persona + rules in a real systemInstruction (not in the user message)', /كابتن سُعرة/.test(sys) && !/كابتن سُعرة/.test(JSON.stringify(req.body.contents)) && /لا تكرر هذه التعليمات/.test(sys));
    ok('coach: thinkingConfig.includeThoughts=false with a low budget, maxOutputTokens 300', req.body.generationConfig.thinkingConfig && req.body.generationConfig.thinkingConfig.includeThoughts === false && req.body.generationConfig.thinkingConfig.thinkingLevel === 'low' && req.body.generationConfig.maxOutputTokens === 300, JSON.stringify(req.body.generationConfig));
    ok('coach: context includes remaining macros, today\'s meals, my products and weight trend (no water)', /المتبقي: \d+ سعرة، بروتين/.test(sys) && /شوفان بالحليب/.test(sys) && /الوزن: آخر قياس 83.2/.test(sys) && /-0.8 كجم/.test(sys) && /منتجاتي/.test(sys) && /حليب المراعي كامل الدسم/.test(sys) && /240 مل = 149 سعرة/.test(sys) && !/الماء/.test(sys));
    ok('coach: default chat model is Gemini 3.5 Flash Lite', /gemini-3\.5-flash-lite/.test(req.url));
    // detailed request → longer allowed
    await page.fill('#input-chat-text', 'اشرح لي بالتفصيل'); await page.click('[aria-label="إرسال"]');
    await page.waitForFunction(() => !state.isChatThinking);
    const req2 = M.gemini.filter((l) => /streamGenerateContent/.test(l.url)).slice(-1)[0];
    ok('coach: "بالتفصيل" allows a longer answer', req2.body.generationConfig.maxOutputTokens === 1000 && /طلب تفصيلاً/.test(JSON.stringify(req2.body.systemInstruction)));
    await shot(page, '05-coach');
    await ctx.close();
    // casual message → 2-3 lines, thought parts skipped, 400 on thinkingConfig → retried without it
    const ctx2 = await newContext(browser); const M2 = mockAll(ctx2, { gemini: { thinking400: true } });
    const p2 = await ctx2.newPage(); watch(p2, 'coach-casual');
    await seedLegacy(p2); await openApp(p2);
    await p2.evaluate(() => switchTab('chat'));
    await p2.fill('#input-chat-text', 'هلا كابتن، كيفك؟'); await p2.click('[aria-label="إرسال"]');
    await p2.waitForFunction(() => !state.isChatThinking);
    const r2 = await p2.evaluate(() => getActiveChatSession().messages.slice(-1)[0].text);
    ok('coach: casual question → 2-3 short lines, thought parts never shown', r2.split('\n').filter(Boolean).length <= 3 && !/Planning|Option/.test(r2), r2);
    const streams = M2.gemini.filter((l) => /streamGenerateContent/.test(l.url));
    ok('coach: 400 on thinkingConfig → retried without the field', streams.length >= 2 && streams[0].body.generationConfig.thinkingConfig && !streams[streams.length - 1].body.generationConfig.thinkingConfig);
    // live call (legacy voice path) asks for 1-2 sentences
    const voiceSys = await p2.evaluate(() => coachSystemInstruction(coachContext(), 'voice'));
    const liveSys = await p2.evaluate(() => GeminiLive.buildInstruction());
    ok('coach: live voice call replies are limited to 1-2 sentences', /جملة أو جملتين/.test(voiceSys) && /جملة أو جملتين قصيرتين فقط/.test(liveSys));
    await ctx2.close();
  }

  // =============== 9. DEEPSEEK: hidden without a key, appears after save + test, remembered ===============
  {
    const ctx = await newContext(browser); const M = mockAll(ctx);
    const page = await ctx.newPage(); watch(page, 'deepseek');
    await seedLegacy(page); await openApp(page);
    const opts0 = await page.evaluate(() => [...document.querySelectorAll('#chat-model-select option')].map((o) => o.value));
    ok('deepseek: hidden from the model switcher without a key', !opts0.some((v) => v.startsWith('deepseek')) && opts0[0] === 'gemini:gemini-3.5-flash-lite', opts0.join(','));
    ok('deepseek: Gemma is fallback only (not offered as a chat model)', !opts0.some((v) => /gemma/.test(v)));
    await page.evaluate(() => switchTab('settings'));
    ok('deepseek: Settings shows 3 key cards (Gemini, USDA, DeepSeek)', await page.locator('#settings-api-key-input').isVisible() && await page.locator('#settings-usda-key-input').isVisible() && await page.locator('#settings-deepseek-key-input').isVisible());
    await page.fill('#settings-deepseek-key-input', 'sk-test-123456');
    await page.click('button:has-text("حفظ") >> nth=2');
    await page.waitForFunction(() => DeepSeek.isVerified(), null, { timeout: 8000 });
    const opts1 = await page.evaluate(() => [...document.querySelectorAll('#chat-model-select option')].map((o) => o.value));
    ok('deepseek: appears after saving + successful test', opts1.includes('deepseek:deepseek-chat') && await page.evaluate(() => state.chatModel.provider) === 'gemini', opts1.join(','));
    await page.evaluate(() => { switchTab('chat'); setChatModel('deepseek:deepseek-chat'); });
    await page.fill('#input-chat-text', 'وش أتعشى؟'); await page.click('[aria-label="إرسال"]');
    await page.waitForFunction(() => !state.isChatThinking);
    const last = await page.evaluate(() => getActiveChatSession().messages.slice(-1)[0]);
    const dsReq = M.ds.filter((l) => l.path === '/chat/completions').slice(-1)[0];
    ok('deepseek: OpenAI-compatible POST /chat/completions with streaming', dsReq && dsReq.body.stream === true && dsReq.auth === 'Bearer sk-test-123456' && dsReq.body.messages[0].role === 'system');
    ok('deepseek: reasoning_content never shown and <think> stripped', last.provider === 'deepseek' && last.text === 'رد DeepSeek: كل 200 جم زبادي يوناني.', last.text);
    await page.reload(); await booted(page);
    ok('deepseek: last chosen chat model remembered after reload', await page.evaluate(() => state.chatModel.provider === 'deepseek' && document.getElementById('chat-model-select').value === 'deepseek:deepseek-chat'));
    await page.evaluate(() => switchTab('settings'));
    await page.fill('#settings-deepseek-key-input', '');
    await page.click('button:has-text("حفظ") >> nth=2'); await page.waitForTimeout(400);
    const opts2 = await page.evaluate(() => ({ o: [...document.querySelectorAll('#chat-model-select option')].map((o) => o.value), cm: state.chatModel }));
    ok('deepseek: removing the key hides it and falls back to Gemini', !opts2.o.some((v) => v.startsWith('deepseek')) && opts2.cm.provider === 'gemini', JSON.stringify(opts2.cm));
    await page.evaluate(() => setChatModel('gemini:gemini-3.6-flash')); await page.reload(); await booted(page);
    ok('chat model: last chosen Gemini model remembered too', await page.evaluate(() => state.chatModel.model) === 'gemini-3.6-flash');
    await ctx.close();
  }

  // =============== 10. DASHBOARD: snacks, no smart-reco, no water, favourites, swipe, celebrations ===============
  {
    const ctx = await newContext(browser); mockAll(ctx);
    const page = await ctx.newPage(); watch(page, 'dashboard');
    await page.addInitScript(() => { window.__vib = []; navigator.vibrate = (p) => { window.__vib.push(p); return true; }; });
    await seedLegacy(page, { usdaKey: 'USDA-OK' }); await openApp(page);
    await page.waitForFunction(() => state.x.snacks && state.x.snacks.usda && state.x.snacks.usda.banana && /105 سعرة/.test(document.getElementById('quick-snacks').innerText), null, { timeout: 8000 }).catch(() => {});
    const snacks = await page.evaluate(() => [...document.querySelectorAll('[data-snack]')].map((b) => b.dataset.snack + ':' + b.innerText.replace(/\s+/g, ' ')));
    ok('snacks: exactly 3 quick snacks — تمر سكري، سكوب بروتين، موزة', snacks.length === 3 && /date:.*تمر سكري/.test(snacks[0]) && /scoop:.*سكوب بروتين/.test(snacks[1]) && /banana:.*موزة/.test(snacks[2]), snacks.join(' | '));
    ok('snacks: Sukkari date 10 g = 28 kcal (USDA Medjool, source shown), scoop = 24 g protein, banana 118 g = 105 kcal (USDA "Bananas, raw")', /28 سعرة/.test(snacks[0]) && /USDA/.test(snacks[0]) && /24g بروتين/.test(snacks[1]) && /105 سعرة/.test(snacks[2]) && /USDA/.test(snacks[2]), snacks.join(' | '));
    const dsrc = await page.evaluate(() => Snacks.values('date'));
    ok('snacks: date source stored and marked "needs verification"', /Dates, medjool/.test(dsrc.sourceName) && dsrc.verify === true && /السكري/.test(dsrc.sourceName));
    await page.evaluate(() => { switchTab('settings'); });
    ok('snacks: Settings shows editable date values + source', await page.evaluate(() => document.getElementById('date-kcal').value === '277' && document.getElementById('snack-date-g').value === '10' && /medjool/.test(document.getElementById('snack-date-src').textContent)));
    await page.evaluate(() => { document.getElementById('scoop-kcal').value = '130'; document.getElementById('scoop-c').value = '2'; saveSnackConfig(); document.getElementById('date-kcal').value = '300'; saveSnackConfig(); switchTab('dashboard'); quickAddSnack('scoop'); });
    const sc = await page.evaluate(() => state.meals[0]);
    ok('snacks: protein scoop calories/carbs editable in Settings, protein stays 24 g', sc.calories === 130 && sc.protein === 24 && sc.carbs === 2 && sc.breakdown[0].source === 'product', JSON.stringify({ c: sc.calories, p: sc.protein, s: sc.breakdown[0].source }));
    ok('snacks: edited date values used (10 g × 300/100 = 30 kcal)', /30 سعرة/.test(await page.locator('[data-snack="date"]').innerText()));
    await page.evaluate(() => { switchTab('settings'); resetDateSnack(); switchTab('dashboard'); });
    ok('dashboard: NO water tracker anywhere (UI + code)', await page.evaluate(() => !document.getElementById('water-card') && typeof addWater === 'undefined' && typeof renderWater === 'undefined' && !/الماء|أكواب ماء/.test(document.body.innerText)));
    ok('dashboard: smart next-meal recommendation removed (UI + code)', await page.evaluate(() => !document.getElementById('reco-container') && typeof renderSmartRecommendations === 'undefined' && typeof RECO_FOODS === 'undefined' && !/اقتراح ذكي للوجبة القادمة/.test(document.body.innerText)));
    ok('dashboard: light vibration when a meal is added', await page.evaluate(() => window.__vib.some((p) => p === 15)));
    // favourites
    await page.evaluate(() => toggleFavorite(safeId(state.meals.find((m) => m.title === 'دجاج ورز').id)));
    ok('favourites: star → appears in the strip', /دجاج ورز/.test(await page.locator('#favorites-strip').innerText()));
    const n0 = await page.evaluate(() => state.meals.length);
    await page.locator('#favorites-strip button').first().click();
    ok('favourites: one tap re-logs today', await page.evaluate((n0) => state.meals.length === n0 + 1 && state.meals[0].title === 'دجاج ورز' && state.meals[0].date === state.todayDate, n0));
    // swipe right = log again today, swipe left = delete + undo
    const swipe = async (dx) => { const card = page.locator('#meals-container [data-swipe]').nth(1); await card.scrollIntoViewIfNeeded(); const bb = await card.boundingBox(); const y = bb.y + 50; await page.mouse.move(bb.x + bb.width / 2, y); await page.mouse.down(); for (let i = 1; i <= 10; i++) await page.mouse.move(bb.x + bb.width / 2 + dx * i / 10, y + 2); await page.mouse.up(); await page.waitForTimeout(500); };
    const n1 = await page.evaluate(() => state.meals.length);
        await swipe(170);
    ok('swipe: right = log again today', await page.evaluate(() => state.meals.length) === n1 + 1);
    const victim = await page.evaluate(() => document.querySelectorAll('#meals-container [data-swipe]')[1].dataset.swipe);
    await swipe(-170);
    ok('swipe: left = delete with an undo toast', await page.evaluate((v) => !state.meals.some((m) => safeId(m.id) === v), victim) && await page.locator('#toast-action').isVisible() && /حُذفت/.test(await lastToast(page)));
    await page.click('#toast-action'); await page.waitForTimeout(300);
    ok('swipe: undo restores the deleted meal', await page.evaluate((v) => state.meals.some((m) => safeId(m.id) === v) && !DataGuard.tomb.meals.has(state.meals.find((m) => safeId(m.id) === v).id), victim));
    // celebrations: protein goal hit once per day → confetti + vibration
    await page.evaluate(() => { window.__vib = []; quickAddFood('بروتين كبير', 400, 200, 0, 0); });
    await page.waitForTimeout(700);
    const cel = await page.evaluate(() => ({ c: state.x.celebrations[state.todayDate], v: window.__vib.length }));
    ok('celebration: protein goal hit → confetti + vibration, recorded for today', cel.c && cel.c.p === 1 && cel.v >= 1, JSON.stringify(cel));
    await page.evaluate(() => { window.__vib = []; quickAddFood('بروتين ثاني', 100, 50, 0, 0); }); await page.waitForTimeout(600);
    ok('celebration: only once per day', await page.evaluate(() => window.__vib.filter((p) => Array.isArray(p)).length) === 0);
    const g = await page.evaluate(() => [greetingFor(8).text, greetingFor(15).text, greetingFor(23).text, greetingFor(2).text]);
    ok('greeting: صباح الخير / مساء الخير / تصبح على خير by time', g.join('|') === 'صباح الخير|مساء الخير|تصبح على خير|تصبح على خير');
    await page.reload(); await booted(page);
    ok('favourites persist after reload', await page.evaluate(() => state.x.favorites.length === 1));
    await shot(page, '06-dashboard-full', { fullPage: true });
    await ctx.close();
  }

  // =============== 11. WEIGHT, TDEE, HEATMAP, WEEKLY, BADGES, RAMADAN ===============
  {
    const ctx = await newContext(browser); mockAll(ctx);
    const page = await ctx.newPage(); watch(page, 'progress');
    await seedLegacy(page); await openApp(page);
    await page.evaluate(() => switchTab('history'));
    await page.fill('#weight-input', '84.6'); await page.click('button:has-text("سجّل اليوم")');
    ok('weight: one tap logs today\'s weight under a new key', await page.evaluate(() => JSON.parse(localStorage.getItem('su3rah_weight_log')).some((w) => w.date === state.todayDate && w.kg === 84.6)));
    await page.evaluate(() => {
      // 21 days: eating ~2300 kcal while losing 0.5 kg/week → TDEE ≈ 2300 + 0.5*7700/7 ≈ 2850
      state.x.weight = []; for (let i = 20; i >= 0; i--) { const d = addDays(state.todayDate, -i); state.x.weight.push({ id: 'w_' + d, date: d, kg: Math.round((86 - (20 - i) * (0.5 / 7)) * 10) / 10, at: Date.now() }); }
      for (let i = 20; i >= 0; i--) { const d = addDays(state.todayDate, -i); if (!state.meals.some((m) => m.date === d)) state.meals.push({ id: 'tdee_' + i, date: d, title: 'يوم', calories: 2300, protein: 150, carbs: 250, fats: 70, time: '' }); else state.meals.filter((m) => m.date === d).forEach((m, k) => { m.calories = k === 0 ? 2300 : 0; }); }
      saveX('weight'); renderProgressTab();
    });
    const td = await page.evaluate(() => computeTDEE());
    ok('TDEE: estimated from ≥2 weeks of weight + intake with a confidence level', td.ok && Math.abs(td.tdee - 2850) <= 60 && ['high', 'medium', 'low'].includes(td.conf), JSON.stringify(td));
    ok('TDEE: offered, never auto-applied', await page.evaluate(() => state.goalConfig.targetCalories === 2300 && /اقتراح: اجعل هدفي/.test(document.getElementById('tdee-box').innerText)));
    ok('weight: SVG chart with 7-day moving average + weekly change', await page.evaluate(() => !!document.querySelector('#weight-chart svg path[stroke="var(--primary)"]') && /هذا الأسبوع -0.5 كجم/.test(document.getElementById('weight-week-change').textContent)), await page.locator('#weight-week-change').innerText());
    ok('heatmap: last 12 weeks, intensity by closeness to target', await page.locator('#heatmap button').count() >= 78 && await page.locator('#heatmap button[style*="background"]').count() >= 15);
    await page.locator('#heatmap button.today').click();
    ok('heatmap: tapping a day opens it', await page.evaluate(() => state.currentTab === 'dashboard' && state.selectedDate === state.todayDate));
    await page.evaluate(() => switchTab('history'));
    await page.evaluate(() => generateWeeklyInsight()); await page.waitForTimeout(400);
    ok('weekly: averages, best day, mini chart and a 2-line AI insight', /متوسط السعرات/.test(await page.locator('#weekly-card').innerText()) && await page.locator('#weekly-card .rounded-t-lg').count() === 7 && await page.evaluate(() => state.x.weekly.text.split('\n').length === 2 && document.getElementById('weekly-insight').textContent.includes('أسبوعك ممتاز')));
    await page.evaluate(() => openWeeklyShare()); await page.waitForTimeout(600);
    ok('weekly: shareable 600×900 image renders', await page.evaluate(() => { const c = document.getElementById('story-canvas'); const d = c.getContext('2d').getImageData(300, 450, 1, 1).data; return c.width === 600 && c.height === 900 && d[3] === 255; }));
    await shot(page, '07-weekly-card');
    await page.evaluate(() => closeShareStoryModal());
    await page.evaluate(() => checkAchievements());
    ok('badges: streak + first weight unlocked', await page.evaluate(() => state.x.badges.first_weight && state.x.badges.first_meal && state.x.badges.streak7));
    await shot(page, '08-progress', { fullPage: true });
    // Ramadan
    await page.evaluate(() => { switchTab('settings'); document.getElementById('ramadan-toggle').checked = true; document.getElementById('ramadan-iftar').value = '18:10'; document.getElementById('ramadan-suhoor').value = '03:40'; saveRamadan(); switchTab('dashboard'); });
    ok('ramadan: split targets between iftar and suhoor shown on the dashboard', await page.evaluate(() => !document.getElementById('ramadan-card').classList.contains('hidden') && /الإفطار/.test(document.getElementById('ramadan-card').innerText) && /1380/.test(document.getElementById('ramadan-card').innerText)));
    await page.evaluate(() => { const d = new Date(); d.setHours(18, 12, 0, 0); checkRamadanReminders(d); });
    ok('ramadan: reminder fires at the set iftar time (once)', /تقبل الله صيامك/.test(await lastToast(page)) && await page.evaluate(() => JSON.parse(localStorage.getItem('su3rah_ramadan_fired')).iftar === 1));
    // story card uses the theme
    await page.evaluate(() => { applyTheme('emerald'); openShareStoryModal(); }); await page.waitForTimeout(600);
    const px = await page.evaluate(() => { const d = document.getElementById('story-canvas').getContext('2d').getImageData(300, 112 + 44, 1, 1).data; return [...d]; });
    await shot(page, '09-story-emerald');
    ok('story card: 600×900 redrawn with the active theme', px[3] === 255);
    await ctx.close();
  }

  // =============== 12. BACKUP: export (keys optional), import merge + snapshot undo, wipe ===============
  {
    const ctx = await newContext(browser, { acceptDownloads: true }); mockAll(ctx);
    const page = await ctx.newPage(); watch(page, 'backup');
    await seedLegacy(page, { usdaKey: 'USDA-OK', dsKey: 'sk-abc' }); await openApp(page);
    await page.evaluate(() => { state.x.products = [{ id: 'prod_b', name: 'حليب المراعي', brand: 'المراعي', keywords: ['حليب'], per100: { kcal: 62, p: 3.1, c: 4.7, f: 3.4 }, basis: 'ml', serving: 240, servingUnit: 'cup', at: 1, updatedAt: 1 }]; saveX('products'); state.x.weight = [{ id: 'w_x', date: state.todayDate, kg: 80, at: Date.now() }]; saveX('weight'); toggleFavorite(safeId(state.meals[0].id)); state.x.recipes = [{ id: 'recipe_1', name: 'مكرونتي', items: [], cookedWeight: 1000, per100: { kcal: 150, p: 6, c: 25, f: 3 }, at: 1 }]; saveX('recipes'); switchTab('settings'); });
    let [dl] = await Promise.all([page.waitForEvent('download'), page.click('text=تصدير كل البيانات')]);
    const f1 = path.join(os.tmpdir(), 'su3rah-v8-export-1.json'); await dl.saveAs(f1); const j1 = JSON.parse(fs.readFileSync(f1, 'utf8'));
    ok('export: meals, chats, goal, weight, favourites, recipes AND My Products included', j1.appVersion === 'v8' && j1.data.meals.length === 7 && j1.data.chatSessions.length === 2 && j1.data.goal.targetCalories === 2300 && j1.data.extras.weight.length === 1 && j1.data.extras.favorites.length === 1 && j1.data.extras.recipes.length === 1 && j1.data.extras.products.length === 1 && j1.data.extras.products[0].name === 'حليب المراعي');
    ok('export: NO API keys by default (Gemini, USDA, DeepSeek)', !j1.keys && !/AIzaTEST-old-key|USDA-OK|sk-abc/.test(JSON.stringify(j1)));
    await page.check('#backup-include-keys');
    [dl] = await Promise.all([page.waitForEvent('download'), page.click('text=تصدير كل البيانات')]);
    const f2 = path.join(os.tmpdir(), 'su3rah-v8-export-2.json'); await dl.saveAs(f2); const j2 = JSON.parse(fs.readFileSync(f2, 'utf8'));
    ok('export: keys included only when ticked', j2.keys && j2.keys.gemini === 'AIzaTEST-old-key' && j2.keys.usda === 'USDA-OK' && j2.keys.deepseek === 'sk-abc');
    await ctx.close();

    const ctx2 = await newContext(browser); mockAll(ctx2); const p2 = await ctx2.newPage(); watch(p2, 'import');
    await openApp(p2);
    await p2.evaluate(() => { quickAddFood('وجبة الجهاز الثاني', 200, 10, 20, 5); state.x.products = [{ id: 'prod_local', name: 'لبن نادك', keywords: ['لبن'], per100: { kcal: 45, p: 3, c: 4, f: 1.5 }, basis: 'ml', at: 1, updatedAt: 1 }]; saveX('products'); switchTab('settings'); });
    await p2.setInputFiles('#import-file-input', f1);
    await p2.waitForFunction(() => state.meals.length >= 9, null, { timeout: 8000 });
    const s = await p2.evaluate(() => ({ n: state.meals.length, own: state.meals.some((m) => m.title === 'وجبة الجهاز الثاني'), w: state.x.weight.length, fav: state.x.favorites.length, rec: state.x.recipes.length, prods: state.x.products.map((p) => p.id).sort().join(), goal: state.goalConfig.targetCalories }));
    ok('import: merged by id; local data kept; extras + My Products merged', s.n === 9 && s.own && s.w === 1 && s.fav === 1 && s.rec === 1 && s.prods === 'prod_b,prod_local' && s.goal === 2300, JSON.stringify(s));
    await p2.setInputFiles('#import-file-input', f1); await p2.waitForTimeout(600);
    ok('import twice: no duplicates', await p2.evaluate(() => state.meals.length) === 9);
    await ctx2.close();
    const ctx3 = await newContext(browser); mockAll(ctx3); const p3 = await ctx3.newPage(); watch(p3, 'undo');
    await openApp(p3); await p3.evaluate(() => { quickAddFood('محلي', 100, 1, 1, 1); });
    await p3.setInputFiles('#import-file-input', f1); await p3.waitForFunction(() => /دُمجت/.test(document.getElementById('toast-text').innerText));
    ok('import: automatic snapshot taken first', await p3.evaluate(async () => (await Snapshot.get()).reason === 'import'));
    await p3.evaluate(() => undoLastSnapshot()); await p3.waitForTimeout(400);
    const u = await p3.evaluate(() => ({ n: state.meals.length, local: state.meals.some((m) => m.title === 'محلي'), w: state.x.weight.length, rec: state.x.recipes.length, prods: (state.x.products || []).length, goal: state.goalConfig.targetCalories }));
    ok('import undo: imported meals + extras + products removed, local meal kept, goal restored', u.n === 2 && u.local && u.w === 0 && u.rec === 0 && u.prods === 0 && u.goal !== 2300, JSON.stringify(u));
    await ctx3.close();
    const ctx4 = await newContext(browser); mockAll(ctx4); const p4 = await ctx4.newPage(); watch(p4, 'wipe');
    await seedLegacy(p4); await openApp(p4);
    p4.__answer = 'لا'; await p4.evaluate(() => wipeAllData()); await p4.waitForTimeout(200);
    ok('wipe: wrong confirmation word does nothing', await p4.evaluate(() => state.meals.length) === 7);
    p4.__answer = 'امسح'; await p4.evaluate(() => wipeAllData()); await p4.waitForTimeout(500);
    const w = await p4.evaluate(() => ({ n: state.meals.length, other: localStorage.getItem('other_app_key') }));
    ok('wipe: clears su3rah data only (other keys survive)', w.n === 0 && w.other === 'must-survive-wipe', JSON.stringify(w));
    await ctx4.close();
  }

  // =============== 13. ICONS & POLISH: no emojis in the UI, source pills ===============
  {
    const ctx = await newContext(browser); mockAll(ctx);
    const page = await ctx.newPage(); watch(page, 'icons');
    await seedLegacy(page, { usdaKey: 'USDA-OK' }); await openApp(page);
    await page.evaluate(() => { quickAddSnack('date'); toggleFavorite(safeId(state.meals[0].id)); });
    const found = [];
    for (const tab of ['dashboard', 'history', 'chat', 'command', 'settings']) {
      await page.evaluate((t) => switchTab(t), tab);
      const e = await page.evaluate(() => { const re = /\p{Extended_Pictographic}/u; const out = []; const w = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT); let n; while ((n = w.nextNode())) { if (n.parentElement.closest('#chat-messages-container, script, style, [data-t]')) continue; const r = n.parentElement.getBoundingClientRect(); if (!r.width) continue; if (re.test(n.textContent)) out.push(n.textContent.trim().slice(0, 30)); } return out; });
      found.push(...e.map((x) => tab + ':' + x));
    }
    await page.evaluate(() => { switchTab('dashboard'); openMealModal(); });
    found.push(...await page.evaluate(() => [...document.querySelectorAll('#modal-add-meal *')].filter((e) => e.children.length === 0 && /\p{Extended_Pictographic}/u.test(e.textContent)).map((e) => 'modal:' + e.textContent.trim())));
    ok('icons: no emojis anywhere in the UI (nav, buttons, cards, snacks, headers, badges)', !found.length, found.slice(0, 8).join(' | '));
    ok('icons: thin-line SVG icon set used throughout', await page.evaluate(() => document.querySelectorAll('svg.ico use').length) > 60);
    await page.evaluate(() => showToast('اختبار ✅ 🔥 toast'));
    ok('icons: toasts never show emojis', !/\p{Extended_Pictographic}/u.test(await lastToast(page)));
    ok('pills: source badges are a dot + short label', await page.evaluate(() => { const p = document.querySelector('#meals-container .pill'); return !!p && getComputedStyle(p, '::before').width === '6px'; }));
    await ctx.close();
  }

  // =============== 14. MOBILE RTL LAYOUT: no overlap with the dock or safe areas ===============
  {
    const ctx = await newContext(browser, { viewport: { width: 375, height: 667 } }); mockAll(ctx);
    const page = await ctx.newPage(); watch(page, 'layout');
    await seedLegacy(page); await openApp(page);
    for (const tab of ['dashboard', 'history', 'command', 'settings']) {
      await page.evaluate((t) => switchTab(t), tab); await page.waitForTimeout(150);
      const r = await page.evaluate(() => {
        window.scrollTo(0, document.documentElement.scrollHeight); const dock = document.querySelector('.dock').getBoundingClientRect();
        const content = [...document.querySelectorAll('.tab-content.active > div > *')].filter((e) => { const b = e.getBoundingClientRect(); return b.height > 0 && b.width > 0; });
        const lastBottom = Math.max(...content.map((e) => e.getBoundingClientRect().bottom));
        return { overflowX: document.documentElement.scrollWidth - window.innerWidth, lastBottom, dockTop: dock.top, dir: getComputedStyle(document.body).direction, dockInside: dock.left >= 0 && dock.right <= window.innerWidth };
      });
      ok(`layout ${tab}: RTL, no horizontal overflow, last content above the dock`, r.dir === 'rtl' && (!TW_CSS || (r.overflowX <= 0 && r.lastBottom <= r.dockTop + 1 && r.dockInside)), JSON.stringify(r));
    }
    const css = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
    ok('layout: safe-area insets used for header, dock, sheets and body padding', /viewport-fit=cover/.test(css) && /safe-area-inset-bottom/.test(css) && /safe-area-inset-top/.test(css) && /bottom: calc\(12px \+ var\(--safe-b\)\)/.test(css));
    ok('motion: prefers-reduced-motion respected', /@media \(prefers-reduced-motion: reduce\)/.test(css));
    // animated background stays smooth on mobile: compositor-only keyframes + measured frame rate
    await page.evaluate(() => switchTab('dashboard'));
    const perf = await page.evaluate(() => new Promise((res) => {
      const props = new Set(); for (const sh of document.styleSheets) { let rules; try { rules = sh.cssRules; } catch (_) { continue; } for (const r of rules) if (r.type === CSSRule.KEYFRAMES_RULE && /^(orb[A-D]|dustUp)$/.test(r.name)) for (const k of r.cssRules) for (let i = 0; i < k.style.length; i++) props.add(k.style[i]); }
      const filterBlur = [...document.querySelectorAll('#ambient-bg .orb')].some((o) => getComputedStyle(o).filter !== 'none');
      let n = 0; const t0 = performance.now(); const tick = (t) => { n++; if (t - t0 < 2000) requestAnimationFrame(tick); else res({ fps: Math.round(n / ((t - t0) / 1000)), props: [...props], filterBlur }); }; requestAnimationFrame(tick);
    }));
    ok('background: GPU-friendly (keyframes animate only transform/opacity, no filter blur) and smooth on mobile (≥ 50 fps)', perf.props.every((p) => /^(transform|opacity)$/.test(p)) && !perf.filterBlur && perf.fps >= 50, JSON.stringify(perf));
    await page.evaluate(() => { switchTab('dashboard'); openMealModal(); });
    ok('layout: dock hides while a bottom sheet is open', await page.evaluate(() => document.body.classList.contains('modal-open')));
    await ctx.close();
  }

  // =============== 15. PWA: manifest + service worker + OFFLINE mode ===============
  {
    const man = JSON.parse(fs.readFileSync(path.join(ROOT, 'manifest.json'), 'utf8'));
    ok('manifest: name, start_url, id, scope, lang, dir, description, colours', man.name === 'سُعرة' && man.start_url === './index.html' && man.id && man.scope === './' && man.lang === 'ar' && man.dir === 'rtl' && man.description && man.theme_color === '#0E0907' && man.background_color === '#0E0907');
    ok('manifest: separate maskable icon entry', man.icons.some((i) => i.purpose === 'maskable' && fs.existsSync(path.join(ROOT, i.src))) && man.icons.every((i) => fs.existsSync(path.join(ROOT, i.src))));
    const sw = fs.readFileSync(path.join(ROOT, 'sw.js'), 'utf8');
    ok('sw: versioned cache, skipWaiting + clients.claim, network-first index.html', /VERSION = 'v8/.test(sw) && /skipWaiting\(\)/.test(sw) && /clients\.claim\(\)/.test(sw) && /networkFirst/.test(sw));
    ok('sw: never caches API calls (googleapis, USDA, Open Food Facts, DeepSeek) and never touches storage', /api\.nal\.usda\.gov/.test(sw) && /openfoodfacts/.test(sw) && /deepseek/.test(sw) && /googleapis/.test(sw) && !/indexedDB|localStorage\./.test(sw.replace(/\/\*[\s\S]*?\*\//, '')));
    const ctx = await newContext(browser, { serviceWorkers: 'allow' }); mockAll(ctx);
    const page = await ctx.newPage(); watch(page, 'offline');
    await seedLegacy(page); await openApp(page);
    await page.evaluate(() => navigator.serviceWorker.ready.then(() => 1));
    await page.reload(); await booted(page);
    await page.waitForFunction(() => !!navigator.serviceWorker.controller, null, { timeout: 10000 });
    await page.waitForTimeout(600);
    await ctx.setOffline(true);
    await page.reload(); await booted(page);
    const s = await page.evaluate(async () => ({ n: state.meals.length, pill: !document.getElementById('offline-pill').classList.contains('hidden'), caches: await caches.keys() }));
    ok('offline: app shell loads from cache and all meals are there', s.n === 7, JSON.stringify(s));
    ok('offline: offline indicator shown', s.pill);
    const cachedUrls = await page.evaluate(async () => { const out = []; for (const k of await caches.keys()) { const c = await caches.open(k); (await c.keys()).forEach((r) => out.push(r.url)); } return out; });
    ok('offline: only shell / static assets cached (no API responses)', cachedUrls.length && !cachedUrls.some((u) => /googleapis\.com\/v1beta|nal\.usda|openfoodfacts|deepseek/.test(u)), cachedUrls.join(' '));
    const offl = await page.evaluate(async () => { const u = parseItemsLocally('150 جرام صدر دجاج مشوي'); const r = await resolveItem(u.items[0]); return [r.source, Math.round(itemTotals(r).kcal)]; });
    ok('offline: meal understanding falls back to local parser + embedded USDA values', offl[0] === 'usda' && offl[1] === 248, JSON.stringify(offl));
    await page.evaluate(() => quickAddFood('وجبة بدون نت', 300, 20, 30, 10));
    ok('offline: logging works offline', await page.evaluate(() => state.meals.length) === 8);
    await ctx.setOffline(false);
    await ctx.close();
  }

  // =============== 17. MY PRODUCTS: label photo → product → «كوب حليب» uses MY product ===============
  {
    const MILK_LABEL = { product_name: 'حليب المراعي كامل الدسم', brand: 'المراعي', basis: 'per100ml', serving_size_g: null, serving_size_ml: 200, kcal: 62, kj: null, protein_g: 3.1, carbs_g: 4.7, fat_g: 3.4, sugar_g: 4.7, fiber_g: 0, readable: true };
    const ctx = await newContext(browser); const M = mockAll(ctx, { gemini: { label: MILK_LABEL } });
    const page = await ctx.newPage(); watch(page, 'products');
    await seedLegacy(page, { usdaKey: 'USDA-OK' }); await openApp(page);
    await page.evaluate(() => switchTab('settings'));
    ok('products: Settings → منتجاتي section with search + add by label / barcode / manual', await page.locator('#products-section').isVisible() && await page.locator('#products-search').isVisible() && await page.locator('#products-section >> text=من صورة الملصق').count() === 1 && await page.locator('#products-section >> text=من الباركود').count() === 1);
    await page.setInputFiles('#product-label-quick', path.join(ROOT, 'icon-512.png'));
    await page.waitForFunction(() => document.getElementById('product-kcal').value === '62', null, { timeout: 8000 });
    const f = await page.evaluate(() => ({ name: document.getElementById('product-name').value, brand: document.getElementById('product-brand').value, kw: document.getElementById('product-keywords').value, ml: document.getElementById('product-basis-ml').classList.contains('is-active'), src: document.getElementById('product-source').value, p: document.getElementById('product-p').value, sugar: document.getElementById('product-sugar').value, serving: document.getElementById('product-serving').value, thumb: !!document.querySelector('#product-thumb img') }));
    ok('products: label photo → Gemini reads ONLY printed numbers → editor filled for me to confirm', f.name === 'حليب المراعي كامل الدسم' && f.brand === 'المراعي' && f.p === '3.1' && f.sugar === '4.7' && f.ml && f.src === 'label' && f.serving === '200' && f.thumb, JSON.stringify(f));
    ok('products: keywords suggested (حليب، milk…)', /حليب/.test(f.kw) && /milk/.test(f.kw), f.kw);
    await page.fill('#product-kcal', '63'); await page.fill('#product-kcal', '62');
    await page.click('#btn-product-save'); await page.waitForTimeout(250);
    const stored = await page.evaluate(() => JSON.parse(localStorage.getItem('su3rah_my_products')));
    ok('products: saved under the NEW key su3rah_my_products with per-100 ml values + source', stored.length === 1 && stored[0].basis === 'ml' && stored[0].per100.kcal === 62 && stored[0].source === 'label' && stored[0].keywords.includes('حليب'), JSON.stringify(stored[0]).slice(0, 160));
    ok('products: listed in Settings with منتجاتي + ملصق pills', /حليب المراعي كامل الدسم/.test(await page.locator('#products-list').innerText()) && await page.locator('#products-list .pill').count() >= 2);
    await shot(page, '13-my-products');
    // «كوب حليب» via Gemini → my product, not USDA
    const usdaBefore = M.usda.length;
    await page.evaluate(() => { switchTab('dashboard'); openMealModal(); });
    await page.fill('#ai-description', 'كوب حليب'); await page.click('#btn-submit-ai');
    await page.waitForSelector('#modal-confirm:not(.hidden)', { timeout: 10000 });
    const c = await page.evaluate(() => ({ it: Confirm.items[0], pill: document.querySelector('#confirm-items .pill').textContent, unit: document.querySelector('#confirm-items [data-unit]').textContent, T: confirmTotals() }));
    ok('products: «كوب حليب» uses MY product first (not USDA) with the منتجاتي badge', c.it.source === 'product' && c.pill === 'منتجاتي' && /حليب المراعي/.test(c.it.sourceName) && M.usda.length === usdaBefore, JSON.stringify({ s: c.it.source, n: c.it.sourceName, usda: M.usda.length - usdaBefore }));
    ok('products: كوب = 240 ml, shown in ml, macros from my label (149 kcal)', c.it.grams === 240 && c.it.unit === 'ml' && c.unit === 'مل' && Math.round(c.T.kcal) === 149 && Math.abs(c.T.p - 7.44) < 0.01, JSON.stringify({ g: c.it.grams, u: c.unit, T: c.T }));
    await shot(page, '14-confirm-my-product');
    await page.click('#btn-confirm-save'); await page.waitForTimeout(300);
    ok('products: meal saved with product breakdown (unit ml) and high confidence', await page.evaluate(() => { const m = state.meals[0]; return m.calories === 149 && m.breakdown[0].source === 'product' && m.breakdown[0].unit === 'ml' && m.breakdown[0].productId && m.confidence === 'high'; }));
    ok('products: meal card shows the ml amount', /240 مل/.test(await page.locator('#meals-container [data-swipe]').first().textContent()));
    // offline/local parser path + units
    const loc = await page.evaluate(async () => {
      const r = async (t) => { const u = parseItemsLocally(t); const x = await resolveItem(u.items[0]); return { s: x.source, g: x.grams, u: x.unit, n: x.sourceName }; };
      const a = await r('كوب حليب'); const b = await r('علبة حليب'); const c2 = await r('2 كوب حليب');
      state.x.units.cupMl = 250; const d = await r('كوب حليب'); state.x.units.cupMl = 240;
      const e = await r('شاي بالحليب'); state.x.products.push({ id: 'tmp_laban', name: 'لبن المراعي', brand: 'المراعي', keywords: ['لبن'], per100: { kcal: 45, p: 3, c: 4.5, f: 1.5 }, basis: 'ml' }); const lab = await r('100 جرام لبنة'); state.x.products = state.x.products.filter((p) => p.id !== 'tmp_laban');
      return { a, b, c2, d, e, lab };
    });
    ok('products: local parser — كوب = 240 ml, علبة = serving (200 ml), 2 أكواب = 480 ml', loc.a.s === 'product' && loc.a.g === 240 && loc.a.u === 'ml' && loc.b.g === 200 && loc.c2.g === 480, JSON.stringify([loc.a, loc.b, loc.c2]));
    ok('products: «كوب» size editable (250 ml)', loc.d.g === 250, JSON.stringify(loc.d));
    ok('products: «بالحليب» prefix still matches; «لبنة» does NOT match a «لبن»-type keyword', loc.e.s === 'product' && loc.lab.s === 'table', JSON.stringify([loc.e.s, loc.lab]));
    // several products for one keyword → default wins, switchable on the confirmation card
    const multi = await page.evaluate(async () => {
      state.x.products.push({ id: 'prod_nadec', name: 'حليب نادك قليل الدسم', brand: 'نادك', keywords: ['حليب', 'milk'], per100: { kcal: 46, p: 3.2, c: 4.8, f: 1.5 }, basis: 'ml', serving: 200, servingUnit: 'ml', isDefault: true, at: 2, updatedAt: 2 });
      const a = await resolveItem({ name_ar: 'حليب', name_en: 'milk whole', grams: 240, unit: 'ml', state: 'n/a' });
      const b = await resolveItem({ name_ar: 'حليب المراعي', name_en: 'milk', grams: 240, unit: 'ml', state: 'n/a' });
      await openConfirm({ title: 't', items: [a], origin: 'ai' });
      return { a: a.sourceName, alts: a.productAlts.length, b: b.sourceName };
    });
    ok('products: several matches → the one marked default is used (and the brand name still wins when typed)', /نادك/.test(multi.a) && multi.alts === 1 && /المراعي/.test(multi.b), JSON.stringify(multi));
    await page.evaluate(() => swapConfirmItem(0)); await page.waitForTimeout(100);
    ok('products: confirmation card lists my other matching products to switch', /حليب المراعي كامل الدسم/.test(await page.locator('#confirm-items [data-ci="0"] .swap-box').innerText()));
    await page.locator('#confirm-items [data-ci="0"] .swap-box button:has-text("حليب المراعي")').click();
    ok('products: switching on the confirmation card recalculates (240 ml → 149 kcal)', await page.evaluate(() => /المراعي/.test(Confirm.items[0].sourceName) && Math.round(confirmTotals().kcal) === 149));
    await page.evaluate(() => closeConfirm());
    // density: product per 100 g, amount given in ml
    const dens = await page.evaluate(() => { const p = { id: 'x', name: 'زبادي', basis: 'g', density: 1.05, per100: { kcal: 60, p: 3.5, c: 4.7, f: 3 } }; return productAmount({ grams: 200, unit: 'ml' }, p); });
    ok('products: ml ↔ g uses the label density when given (200 ml × 1.05 = 210 g)', dens.amount === 210 && dens.unit === 'g', JSON.stringify(dens));
    // manage: search, set default, delete with undo
    await page.evaluate(() => { saveX('products'); switchTab('settings'); });
    await page.fill('#products-search', 'نادك');
    ok('products: search filters the list', await page.locator('#products-list [data-product]').count() === 1);
    await page.fill('#products-search', ''); await page.evaluate(() => renderProductsList());
    await page.evaluate(() => toggleDefaultProduct(state.x.products[0].id));
    ok('products: «set default» moves the default (only one default per keyword)', await page.evaluate(() => state.x.products.filter((p) => p.isDefault).length === 1 && state.x.products[0].isDefault));
    await page.evaluate(() => deleteProduct('prod_nadec')); await page.waitForTimeout(150);
    ok('products: delete with undo toast', await page.evaluate(() => state.x.products.length === 1) && await page.locator('#toast-action').isVisible());
    await page.click('#toast-action'); await page.waitForTimeout(200);
    ok('products: undo restores the product', await page.evaluate(() => state.x.products.length === 2));
    // edit
    await page.evaluate(() => openProductEditor(state.x.products[0].id)); await page.fill('#product-kcal', '64'); await page.click('#btn-product-save'); await page.waitForTimeout(200);
    ok('products: edit updates values', await page.evaluate(() => state.x.products[0].per100.kcal === 64));
    // barcode → product (Settings → من الباركود)
    await page.evaluate(() => scanBarcodeForProduct()); await page.evaluate(() => { stopBarcodeScan(); lookupBarcode('6281007012345'); });
    await page.waitForSelector('#modal-product:not(.hidden)', { timeout: 6000 });
    const bp = await page.evaluate(() => ({ n: document.getElementById('product-name').value, bc: document.getElementById('product-barcode').value, k: document.getElementById('product-kcal').value, src: document.getElementById('product-source').value }));
    ok('products: add by barcode (Open Food Facts) → editor filled to confirm', /لبن زبادي/.test(bp.n) && bp.bc === '6281007012345' && bp.k === '63' && bp.src === 'barcode', JSON.stringify(bp));
    await page.click('#btn-product-save'); await page.waitForTimeout(200);
    // manual + migration of V7 «أطعمتي» (non-destructive)
    ok('products: 3 products now (label, manual-default, barcode)', await page.evaluate(() => state.x.products.length === 3));
    await page.reload(); await booted(page);
    ok('products: persist after reload', await page.evaluate(() => state.x.products.length === 3));
    await ctx.close();
    const ctx2 = await newContext(browser); mockAll(ctx2); const p2 = await ctx2.newPage(); watch(p2, 'myfoods-migration');
    await seedLegacy(p2, { extraLs: { su3rah_my_foods: JSON.stringify([{ id: 'food_1', name_ar: 'لبن المراعي', per100: { kcal: 45, p: 3, c: 4.5, f: 1.5 }, barcode: '628100', origin: 'باركود', at: 1 }]) } });
    await openApp(p2);
    const mig = await p2.evaluate(() => ({ prods: state.x.products.map((p) => p.name), old: JSON.parse(localStorage.getItem('su3rah_my_foods')).length }));
    ok('products: V7 «أطعمتي» copied into My Products once; the old key is left untouched', mig.prods.includes('لبن المراعي') && mig.old === 1, JSON.stringify(mig));
    await p2.reload(); await booted(p2);
    ok('products: migration not repeated', await p2.evaluate(() => state.x.products.length === 1));
    await ctx2.close();
  }

  // =============== 18. SMART AUTO-SAVE SUGGESTION ===============
  {
    const ctx = await newContext(browser); mockAll(ctx);
    const page = await ctx.newPage(); watch(page, 'autosave');
    await seedLegacy(page, { usdaKey: 'USDA-OK' }); await openApp(page);
    const logAI = async () => { await page.evaluate(() => openMealModal()); await page.fill('#ai-description', 'شوفان بالموز'); await page.click('#btn-submit-ai'); await page.waitForSelector('#modal-confirm:not(.hidden)', { timeout: 8000 }); await page.click('#btn-confirm-save'); await page.waitForTimeout(250); };
    await logAI(); await logAI();
    ok('autosave: no suggestion after 2 logs', await page.evaluate(() => document.getElementById('autosave-suggest').classList.contains('hidden')));
    await logAI();
    const card = await page.evaluate(() => ({ vis: !document.getElementById('autosave-suggest').classList.contains('hidden'), n: document.querySelectorAll('#autosave-suggest [data-suggest]').length, t: document.getElementById('autosave-suggest').innerText }));
    ok('autosave: same food 3× within 10 days → ONE suggestion card with the 3 options', card.vis && card.n === 1 && /تضيفها دائماً — تبغى تحفظها؟/.test(card.t) && /شوفان بالموز/.test(card.t) && /حفظ في المفضلة/.test(card.t) && /حفظ كمنتج من منتجاتي/.test(card.t) && /لا، شكراً/.test(card.t), card.t.replace(/\s+/g, ' ').slice(0, 140));
    await shot(page, '15-autosave-suggestion');
    await page.click('#autosave-suggest >> text=لا، شكراً'); await page.waitForTimeout(150);
    await logAI();
    const sn = await page.evaluate(() => { const e = Object.values(state.x.logStats).find((x) => x.name === 'شوفان بالموز'); return { hidden: document.getElementById('autosave-suggest').classList.contains('hidden'), days: Math.round((e.snoozeUntil - Date.now()) / 864e5) }; });
    ok('autosave: «لا، شكراً» → not asked again for that item for 30 days', sn.hidden && sn.days === 30, JSON.stringify(sn));
    ok('autosave: stats stored under a NEW key', await page.evaluate(() => !!localStorage.getItem('su3rah_food_log_stats')));
    await page.evaluate(() => { for (let i = 0; i < 3; i++) quickAddFood('سلطة دجاج', 320, 30, 12, 15); });
    await page.click('#autosave-suggest >> text=حفظ في المفضلة'); await page.waitForTimeout(150);
    ok('autosave: «حفظ في المفضلة» stars it and the card disappears', await page.evaluate(() => state.x.favorites.some((f) => f.title === 'سلطة دجاج') && document.getElementById('autosave-suggest').classList.contains('hidden')));
    await page.evaluate(() => { for (let i = 0; i < 3; i++) quickAddFood('زبادي بالعسل', 180, 9, 25, 4); });
    await page.click('#autosave-suggest >> text=حفظ كمنتج من منتجاتي');
    await page.waitForSelector('#modal-product:not(.hidden)');
    ok('autosave: «حفظ كمنتج» opens the product editor prefilled', await page.evaluate(() => document.getElementById('product-name').value === 'زبادي بالعسل' && document.getElementById('product-kcal').value === '180'));
    await page.click('#btn-product-save'); await page.waitForTimeout(200);
    ok('autosave: saving the product closes the suggestion', await page.evaluate(() => state.x.products.some((p) => p.name === 'زبادي بالعسل') && document.getElementById('autosave-suggest').classList.contains('hidden')));
    const r = await page.evaluate(async () => { const x = await resolveItem(parseItemsLocally('زبادي بالعسل').items[0]); return [x.source, Math.round(itemTotals(x).kcal)]; });
    ok('autosave: the new product is then used with its full serving (180 kcal)', r[0] === 'product' && r[1] === 180, JSON.stringify(r));
    await page.evaluate(() => { for (let i = 0; i < 4; i++) quickAddSnack('date'); });
    ok('autosave: quick snacks never trigger a suggestion', await page.evaluate(() => document.getElementById('autosave-suggest').classList.contains('hidden')));
    await ctx.close();
  }

  // =============== 16. Desktop screenshots ===============
  if (SHOTS) {
    const ctx = await newContext(browser, { viewport: { width: 1360, height: 900 } }); mockAll(ctx);
    const page = await ctx.newPage();
    await seedLegacy(page, { usdaKey: 'USDA-OK' }); await openApp(page); await page.waitForTimeout(1200);
    await page.screenshot({ path: path.join(SHOTS, '10-dashboard-desktop.png') });
    await page.evaluate(() => switchTab('settings')); await page.waitForTimeout(600);
    await page.screenshot({ path: path.join(SHOTS, '11-settings-desktop.png'), fullPage: true });
    await page.goto(`${BASE}/index.html`); await page.waitForTimeout(350);
    await page.screenshot({ path: path.join(SHOTS, '12-splash.png') });
    await ctx.close();
  }

  ok('No uncaught page errors', errors.length === 0, errors.slice(0, 5).join(' | '));
  await browser.close(); server.close();
  const failed = results.filter((r) => !r.pass);
  console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
  if (failed.length) console.log('FAILED:\n- ' + failed.map((f) => f.name + (f.extra ? ' — ' + f.extra : '')).join('\n- '));
  process.exit(failed.length ? 1 : 0);
})().catch((e) => { console.error(e); server.close(); process.exit(2); });
