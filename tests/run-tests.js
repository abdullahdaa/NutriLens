/* سُعرة — end-to-end checks (Playwright, Chromium).
 *
 *   node tests/run-tests.js            # serves the repo on a local port and runs every check
 *   TW_CSS=/path/to/tailwind.css node tests/run-tests.js   # optional: render with a locally built Tailwind
 *   SHOTS=/some/dir node tests/run-tests.js                # optional: save screenshots
 *
 * Everything external is mocked at the network layer (DeepSeek, Gemini REST + Live WebSocket).
 * Legacy data is seeded on an intercepted blank URL, so no seeding page is ever deployed.
 */
const http = require('http');
const fs = require('fs');
const path = require('path');
const { chromium } = require('playwright');

const ROOT = path.resolve(__dirname, '..');
const PORT = 8765 + Math.floor(Math.random() * 400);
const BASE = `http://localhost:${PORT}`;
const SHOTS = process.env.SHOTS || '';
const TW_CSS = process.env.TW_CSS && fs.existsSync(process.env.TW_CSS) ? fs.readFileSync(process.env.TW_CSS, 'utf8') : '';

const results = [];
const ok = (name, cond, extra = '') => { results.push({ name, pass: !!cond, extra }); console.log(`${cond ? '✅' : '❌'} ${name}${extra ? '  — ' + extra : ''}`); };

// ---------- static server ----------
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.json': 'application/json', '.png': 'image/png', '.css': 'text/css' };
const server = http.createServer((req, res) => {
  const p = decodeURIComponent(req.url.split('?')[0]);
  const file = path.join(ROOT, p === '/' ? 'index.html' : p);
  if (!file.startsWith(ROOT) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) { res.writeHead(404); return res.end('nf'); }
  res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream' });
  fs.createReadStream(file).pipe(res);
});

// ---------- fixtures ----------
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
    // Current-format DB (exactly how the previous version stored data)
    const v12 = await openDb('Su3rahNativeDB_v12', 1, (db) => db.createObjectStore('data_store'));
    const kv = { su3rah_meals_db: V12_MEALS, su3rah_goal_profile: GOAL, su3rah_gemini_api_key: opts.geminiKey || 'AIzaTEST-old-key', su3rah_chat_sessions_v2: V12_CHATS,
      su3rah_active_chat_id: 'chat_2', su3rah_selected_model: 'gemini-3.1-flash-lite', su3rah_username: 'سالم' };
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
      // Older release DB name (Su3rahNativeDB_v13) — same store layout
      const v13 = await openDb('Su3rahNativeDB_v13', 1, (db) => db.createObjectStore('data_store'));
      await put(v13, 'data_store', [...V12_MEALS.slice(0, 3), ...V13_EXTRA], 'su3rah_meals_db');
      await put(v13, 'data_store', [{ id: 'chat_v13', title: 'محادثة v13', date: '2026-10-20', messages: [{ role: 'user', text: 'سؤال قديم' }, { role: 'assistant', text: 'جواب قديم' }] }], 'su3rah_chat_sessions_v2');
      v13.close();
      // Very old "nutrilens-db" schema (meals keyPath id with day/name/cal/p/c/f/photo)
      const nl = await openDb('nutrilens-db', 1, (db) => { const s = db.createObjectStore('meals', { keyPath: 'id' }); s.createIndex('day', 'day'); db.createObjectStore('settings', { keyPath: 'key' }); db.createObjectStore('chats', { keyPath: 'id' }); });
      const d = new Date(); d.setDate(d.getDate() - 10); d.setHours(13, 5);
      const day = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
      await put(nl, 'meals', { id: 'nl_abc123', day, createdAt: d.getTime(), name: 'كبسة لحم (nutrilens)', cal: 900, p: 45.5, c: 95, f: 33, photo: null, notes: '' });
      await put(nl, 'chats', { id: 'nlchat1', title: 'محادثة nutrilens', updatedAt: d.getTime(), messages: [{ role: 'user', text: 'مرحبا' }, { role: 'model', text: 'أهلاً' }] });
      await put(nl, 'settings', { key: 'main', value: { name: 'قديم', apiKey: 'AIza-nutrilens' } });
      nl.close();
      localStorage.setItem('su3rah_chat_history', JSON.stringify([{ role: 'assistant', text: 'ترحيب' }, { role: 'user', text: 'رسالة من v1' }, { role: 'assistant', text: 'رد v1' }]));
    }
  }, { V12_MEALS, V12_CHATS, V13_EXTRA, GOAL, opts });
  await page.unroute(`${BASE}/__seed__`);
}

async function newContext(browser, extra = {}) {
  const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 1, locale: 'ar', permissions: ['microphone'], serviceWorkers: 'block', ...extra });
  await ctx.route('https://cdn.tailwindcss.com/**', (r) => r.fulfill({ contentType: 'text/javascript',
    body: `window.tailwind={};${TW_CSS ? `(function(){var s=document.createElement('style');s.textContent=${JSON.stringify(TW_CSS)};document.head.appendChild(s);})();` : ''}` }));
  await ctx.route('https://cdn.tailwindcss.com', (r) => r.fulfill({ contentType: 'text/javascript',
    body: `window.tailwind={};${TW_CSS ? `(function(){var s=document.createElement('style');s.textContent=${JSON.stringify(TW_CSS)};document.head.appendChild(s);})();` : ''}` }));
  return ctx;
}

const booted = (page) => page.waitForFunction(() => typeof state !== 'undefined' && state.booted === true, null, { timeout: 20000 });
const openApp = async (page) => { await page.goto(`${BASE}/index.html`); await booted(page); };
const idbRead = (page, db, key) => page.evaluate(({ db, key }) => new Promise((res) => { const r = indexedDB.open(db); r.onsuccess = () => { const d = r.result; if (!d.objectStoreNames.contains('data_store')) { d.close(); return res(undefined); } const g = d.transaction('data_store').objectStore('data_store').get(key); g.onsuccess = () => { d.close(); res(g.result); }; }; }), { db, key });
const dbNames = (page) => page.evaluate(async () => (await indexedDB.databases()).map((d) => d.name).sort());

// ---------- AI mocks ----------
function mockDeepSeek(ctx, behaviour = {}) {
  const log = [];
  ctx.route('https://api.deepseek.com/**', async (route) => {
    const req = route.request(); const url = new URL(req.url());
    const auth = req.headers()['authorization'] || '';
    const entry = { path: url.pathname, method: req.method(), auth, body: req.postData() ? JSON.parse(req.postData()) : null, url: req.url() };
    log.push(entry);
    const cors = { 'Access-Control-Allow-Origin': BASE, 'Content-Type': 'application/json' };
    if (behaviour.abort) return route.abort('failed');
    if (behaviour.status) return route.fulfill({ status: behaviour.status, headers: cors, body: JSON.stringify({ error: { message: 'mock error ' + behaviour.status } }) });
    if (url.pathname === '/models') return route.fulfill({ headers: cors, body: JSON.stringify({ object: 'list', data: [{ id: 'deepseek-chat' }, { id: 'deepseek-reasoner' }, { id: 'deepseek-v9-mock' }] }) });
    if (url.pathname === '/user/balance') return route.fulfill({ headers: cors, body: JSON.stringify({ is_available: behaviour.noBalance ? false : true, balance_infos: [{ currency: 'USD', total_balance: behaviour.noBalance ? '0.00' : '4.20' }] }) });
    const b = entry.body;
    if (/reason/.test(b.model) && b.response_format) return route.fulfill({ status: 400, headers: cors, body: JSON.stringify({ error: { message: 'response_format not supported for this model' } }) });
    const isJson = b.response_format || /JSON/.test(JSON.stringify(b.messages));
    const content = isJson ? JSON.stringify({ title: 'صدر دجاج مع أرز (DeepSeek)', calories: 612, protein_g: 48, carbohydrates_g: 66, fats_g: 14, notes: 'تقدير DeepSeek' })
      : 'رد المدرب من DeepSeek: ركّز على البروتين.';
    return route.fulfill({ headers: cors, body: JSON.stringify({ id: 'x', model: b.model, choices: [{ index: 0, message: { role: 'assistant', content, reasoning_content: /reason/.test(b.model) ? 'thinking...' : undefined } }],
      usage: { prompt_tokens: 321, completion_tokens: 54, total_tokens: 375, prompt_cache_hit_tokens: 100, prompt_cache_miss_tokens: 221 } }) });
  });
  return log;
}
function mockGemini(ctx, behaviour = {}) {
  const log = [];
  ctx.route(/generativelanguage\.googleapis\.com/, async (route) => {
    const req = route.request(); const url = req.url();
    log.push({ url, body: req.postData() ? JSON.parse(req.postData()) : null });
    const h = { 'Access-Control-Allow-Origin': '*', 'Content-Type': 'application/json' };
    if (/\/models\?/.test(url)) return route.fulfill({ headers: h, body: JSON.stringify({ models: [] }) });
    if (behaviour.status) return route.fulfill({ status: behaviour.status, headers: h, body: JSON.stringify({ error: { code: behaviour.status, message: behaviour.status === 400 ? 'API key not valid' : 'quota' } }) });
    if (/batchEmbedContents/.test(url)) { const b = JSON.parse(req.postData()); return route.fulfill({ headers: h, body: JSON.stringify({ embeddings: b.requests.map((_, i) => ({ values: Array.from({ length: 8 }, (_, j) => Math.sin(i + j)) })) }) }); }
    const body = JSON.parse(req.postData() || '{}');
    const all = JSON.stringify(body);
    const text = /insights/.test(all) ? JSON.stringify({ insights: [{ title: 'نمط Gemini', body: 'بناءً على الأنماط...', tip: 'كل بروتين', confidence: 80 }] })
      : /JSON/.test(all) ? JSON.stringify({ title: 'طبق مصوّر (Gemini)', calories: 733, protein_g: 40, carbohydrates_g: 70, fats_g: 30, notes: 'من الصورة' })
      : 'رد Gemini التجريبي';
    return route.fulfill({ headers: h, body: JSON.stringify({ candidates: [{ content: { parts: [{ text }] } }] }) });
  });
  return log;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const lastToast = (page) => page.evaluate(() => document.getElementById('toast-text').innerText);

(async () => {
  await new Promise((r) => server.listen(PORT, r));
  const browser = await chromium.launch({ args: ['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream'] });
  const errors = [];
  const watch = (page, label) => page.on('pageerror', (e) => errors.push(`${label}: ${e.message}`));

  // =============== 1. MIGRATION: old storage format is fully preserved ===============
  {
    const ctx = await newContext(browser); mockDeepSeek(ctx); mockGemini(ctx);
    const page = await ctx.newPage(); watch(page, 'migration');
    await seedLegacy(page, { legacy: false });
    await openApp(page);
    const s = await page.evaluate(() => ({ meals: state.meals.map((m) => m.id), goal: state.goalConfig, key: state.apiKey, name: state.userName, chats: state.chatSessions.map((c) => c.id), active: state.activeChatId, model: state.selectedModel, muted: state.audioMuted }));
    ok('migration: all 7 old meals present', V12_MEALS.every((m) => s.meals.includes(m.id)) && s.meals.length === 7, `${s.meals.length} meals`);
    ok('migration: no sample meal injected', !s.meals.includes('meal-init-1'));
    ok('migration: goal / name / Gemini key / model / mute kept', s.goal.targetCalories === 2300 && s.name === 'سالم' && s.key === 'AIzaTEST-old-key' && s.model === 'gemini-3.1-flash-lite' && s.muted === true);
    ok('migration: chats + active chat kept', ['chat_1', 'chat_2'].every((c) => s.chats.includes(c)) && s.active === 'chat_2');
    const lsKeys = await page.evaluate(() => Object.keys(localStorage));
    const mustKeep = ['su3rah_meals_db', 'su3rah_goal_profile', 'su3rah_gemini_api_key', 'su3rah_chat_sessions_v2', 'su3rah_active_chat_id', 'su3rah_selected_model', 'su3rah_username', 'su3rah_audio_muted', 'su3rah_v5_config', 'su3rah_v5_insights', 'su3rah-cooldown', 'su3rah-model-map', 'last_11pm_reminder_day'];
    ok('migration: every old localStorage key still exists', mustKeep.every((k) => lsKeys.includes(k)), mustKeep.filter((k) => !lsKeys.includes(k)).join(','));
    const idbMeals = await idbRead(page, 'Su3rahNativeDB_v12', 'su3rah_meals_db');
    ok('migration: IndexedDB Su3rahNativeDB_v12/data_store still holds the 7 meals', Array.isArray(idbMeals) && idbMeals.length === 7);
    const v5 = await page.evaluate(() => V5Config.v.voice);
    ok('migration: V5 config (voice) kept', v5 === 'Kore');
    await page.reload(); await booted(page);
    const n2 = await page.evaluate(() => state.meals.length);
    ok('migration: reload is stable (no duplicates)', n2 === 7, `${n2}`);
    // hourOf can parse the old localized strings
    const hours = await page.evaluate(() => [su3rahHourOf({ time: '08:30 ص' }), su3rahHourOf({ time: '٠٩:١٥ م' }), su3rahHourOf({ time: '12:05 ص' }), su3rahHourOf({ time: '7:45 PM' }), su3rahHourOf({ id: 'meal_1764147600000' }), su3rahHourOf({ createdAt: new Date(2026, 0, 1, 17, 0).getTime(), time: '١١:٠٠ ص' })]);
    ok('hourOf parses "08:30 ص", "٠٩:١٥ م", "12:05 ص", "7:45 PM", id timestamp, createdAt', hours[0] === 8 && hours[1] === 21 && hours[2] === 0 && hours[3] === 19 && typeof hours[4] === 'number' && hours[5] === 17, JSON.stringify(hours));
    const oldMealsHours = await page.evaluate(() => state.meals.map((m) => su3rahHourOf(m)));
    ok('hourOf works on all seeded old meals', oldMealsHours.every((h) => typeof h === 'number'), JSON.stringify(oldMealsHours));
    if (SHOTS) { await page.waitForTimeout(1200); await page.screenshot({ path: path.join(SHOTS, 'dashboard-mobile.png'), fullPage: false }); }
    await ctx.close();
  }

  // =============== 2. RESCUE from older DB names / schemas ===============
  {
    const ctx = await newContext(browser); mockDeepSeek(ctx); mockGemini(ctx);
    const page = await ctx.newPage(); watch(page, 'rescue');
    await seedLegacy(page, { legacy: true });
    await openApp(page);
    const s = await page.evaluate(() => ({ ids: state.meals.map((m) => m.id), nl: state.meals.find((m) => m.id === 'nl_abc123'), chats: state.chatSessions.map((c) => c.id) }));
    ok('rescue: meals only in Su3rahNativeDB_v13 merged', V13_EXTRA.every((m) => s.ids.includes(m.id)));
    ok('rescue: overlapping ids de-duplicated', s.ids.length === new Set(s.ids).size && s.ids.length === 7 + 2 + 1, `${s.ids.length} meals`);
    ok('rescue: nutrilens-db meal mapped (name/cal/p → title/calories/protein)', s.nl && s.nl.title.includes('كبسة') && s.nl.calories === 900 && s.nl.protein === 45.5 && s.nl.date);
    ok('rescue: chats from v13, nutrilens-db and su3rah_chat_history merged', ['chat_v13', 'nlchat1'].every((c) => s.chats.includes(c)) && s.chats.some((c) => c.startsWith('legacy_history')));
    const names = await dbNames(page);
    ok('rescue: legacy databases left untouched (not deleted)', ['Su3rahNativeDB_v13', 'nutrilens-db', 'Su3rahNativeDB_v12'].every((n) => names.includes(n)), names.join(','));
    ok('rescue: no phantom databases created by probing', !names.some((n) => /_v(1|8|9|11|14|15)$/.test(n)), names.join(','));
    // Delete a rescued meal → must NOT come back on reload (tombstone)
    page.on('dialog', (d) => d.accept());
    await page.evaluate(() => deleteMeal(safeId(state.meals.find((m) => m.title.includes('برجر من v13')).id)));
    await page.reload(); await booted(page);
    const back = await page.evaluate(() => state.meals.some((m) => m.title.includes('برجر من v13')));
    ok('rescue: deleted rescued meal stays deleted after reload', !back);
    // Undo the rescue via snapshot
    const before = await page.evaluate(() => state.meals.length);
    await page.evaluate(() => undoLastSnapshot());
    await page.waitForTimeout(400);
    const after = await page.evaluate(() => ({ n: state.meals.length, hasV13: state.meals.some((m) => m.title.includes('v13')) }));
    ok('rescue: undo snapshot removes exactly the rescued items', !after.hasV13 && after.n === 7, `${before} → ${after.n}`);
    await page.reload(); await booted(page);
    ok('rescue: undone items do not return on reload', await page.evaluate(() => state.meals.length) === 7);
    await ctx.close();
  }

  // =============== 2b. RESCUE without indexedDB.databases() (Firefox < 126 / old Safari) ===============
  {
    const ctx = await newContext(browser);
    const page = await ctx.newPage(); watch(page, 'rescue-probe');
    await seedLegacy(page, { legacy: true });
    await page.addInitScript(() => { try { window.__realDatabases = IDBFactory.prototype.databases; Object.defineProperty(IDBFactory.prototype, 'databases', { value: undefined, configurable: true }); } catch (_) {} });
    await openApp(page);
    const s = await page.evaluate(() => ({ hasApi: !!indexedDB.databases, n: state.meals.length, nl: state.meals.some((m) => m.id === 'nl_abc123'), v13: state.meals.some((m) => /v13/.test(m.title)) }));
    ok('rescue (probe mode): legacy DBs found by known names', !s.hasApi && s.n === 10 && s.nl && s.v13, JSON.stringify(s));
    const names = await page.evaluate(async () => (await window.__realDatabases.call(indexedDB)).map((d) => d.name).sort());
    ok('rescue (probe mode): probing ~20 names created no empty databases', names.join(',') === 'Su3rahNativeDB_v12,Su3rahNativeDB_v13,Su3rahVectorDB_v5,nutrilens-db' || names.join(',') === 'Su3rahNativeDB_v12,Su3rahNativeDB_v13,nutrilens-db', names.join(','));
    await ctx.close();
  }

  // =============== 3. SLOW / FAILED IndexedDB read never seeds over data ===============
  {
    const ctx = await newContext(browser); mockDeepSeek(ctx); mockGemini(ctx);
    const page = await ctx.newPage(); watch(page, 'slow-idb');
    await seedLegacy(page, { noLocalMirror: true });       // data only in IndexedDB, mirror empty (worst case)
    await page.addInitScript(() => {
      const realGet = IDBObjectStore.prototype.get; const until = Date.now() + 9000;
      IDBObjectStore.prototype.get = function (key) {
        if (Date.now() < until && this.name === 'data_store') { const fake = {}; return fake; } // never fires onsuccess → hang
        return realGet.call(this, key);
      };
    });
    await openApp(page);
    const s1 = await page.evaluate(() => ({ n: state.meals.length, seed: state.meals.some((m) => m.id === 'meal-init-1'), verified: DataGuard.verified.meals }));
    ok('slow IDB: no sample meal while IndexedDB is unreadable', !s1.seed && s1.n === 0 && s1.verified === false, JSON.stringify(s1));
    await page.evaluate(() => quickAddFood('موزة أثناء التعطل', 105, 1, 27, 0));
    await page.waitForTimeout(300);
    await page.waitForFunction(() => DataGuard.verified.meals === true, null, { timeout: 25000 });
    await page.waitForTimeout(500);
    const s2 = await page.evaluate(() => ({ n: state.meals.length, banana: state.meals.some((m) => m.title.includes('موزة أثناء')) }));
    ok('slow IDB: once readable, original data restored AND new meal merged', s2.n === 8 && s2.banana, JSON.stringify(s2));
    const idb = await idbRead(page, 'Su3rahNativeDB_v12', 'su3rah_meals_db');
    ok('slow IDB: IndexedDB now holds 7 originals + 1 new', idb.length === 8);
    await ctx.close();
  }
  {
    const ctx = await newContext(browser);
    const page = await ctx.newPage(); watch(page, 'failed-open');
    await seedLegacy(page);
    await page.addInitScript(() => {
      const realOpen = IDBFactory.prototype.open;
      IDBFactory.prototype.open = function (name, v) {
        if (name === 'Su3rahNativeDB_v12') { const req = {}; setTimeout(() => req.onerror && req.onerror(new Event('error')), 20); return req; }
        return realOpen.apply(this, arguments);
      };
    });
    await openApp(page);
    const s = await page.evaluate(() => ({ n: state.meals.length, seed: state.meals.some((m) => m.id === 'meal-init-1'), status: StorageEngine.status }));
    ok('failed IDB open: meals served from localStorage mirror, no seed', s.n === 7 && !s.seed && s.status === 'error', JSON.stringify(s));
    await ctx.close();
    // and with an empty mirror too
    const ctx2 = await newContext(browser); const p2 = await ctx2.newPage(); watch(p2, 'failed-open-2');
    await seedLegacy(p2, { noLocalMirror: true });
    await p2.addInitScript(() => { const realOpen = IDBFactory.prototype.open; IDBFactory.prototype.open = function (name) { if (name === 'Su3rahNativeDB_v12') { const req = {}; setTimeout(() => req.onerror && req.onerror(new Event('error')), 20); return req; } return realOpen.apply(this, arguments); }; });
    await openApp(p2);
    const s2 = await p2.evaluate(() => ({ n: state.meals.length, seed: state.meals.some((m) => m.id === 'meal-init-1') }));
    ok('failed IDB open + empty mirror: still no sample meal', !s2.seed && s2.n === 0, JSON.stringify(s2));
    await ctx2.close();
    // Real IndexedDB still has the 7 meals afterwards
    const ctx3 = await newContext(browser); // separate origin storage → re-check on the same context is not possible; verified via test above
    await ctx3.close();
  }

  // =============== 4. FIRST RUN (truly empty) ===============
  {
    const ctx = await newContext(browser);
    const page = await ctx.newPage(); watch(page, 'first-run');
    await openApp(page);
    ok('first run: sample meal seeded exactly once on a truly empty device', await page.evaluate(() => state.meals.length === 1 && state.meals[0].id === 'meal-init-1'));
    page.on('dialog', (d) => d.accept());
    await page.evaluate(() => deleteMeal('meal-init-1'));
    await page.reload(); await booted(page);
    ok('first run: sample not re-seeded after the user deleted it', await page.evaluate(() => state.meals.length === 0));
    if (SHOTS) { await page.waitForTimeout(900); await page.screenshot({ path: path.join(SHOTS, 'empty-state.png') }); }
    await ctx.close();
  }

  // =============== 5. DEEPSEEK chat + analysis, photos → Gemini, switching, fallbacks ===============
  {
    const ctx = await newContext(browser); const ds = mockDeepSeek(ctx); const gm = mockGemini(ctx);
    await ctx.routeWebSocket(/generativelanguage\.googleapis\.com/, (ws) => { ws.onMessage((m) => { if (/"setup"/.test(String(m))) ws.send(JSON.stringify({ setupComplete: {} })); }); });
    const page = await ctx.newPage(); watch(page, 'deepseek');
    await seedLegacy(page);
    await openApp(page);
    // Save DeepSeek key through the Settings UI
    await page.evaluate(() => switchTab('settings'));
    await page.fill('#settings-deepseek-key-input', 'sk-test-1234567890');
    await page.click('button[onclick="saveDeepseekKeyFromSettings()"]');
    await page.waitForFunction(() => /متصل/.test(document.getElementById('deepseek-key-status').textContent), null, { timeout: 8000 });
    ok('DeepSeek: key saved + Test connection shows ✓ with balance', /الرصيد 4.20 USD/.test(await page.textContent('#deepseek-key-status')), await page.textContent('#deepseek-key-status'));
    ok('DeepSeek: key stored under NEW key su3rah_deepseek_api_key', await page.evaluate(() => JSON.parse(localStorage.getItem('su3rah_deepseek_api_key')) === 'sk-test-1234567890'));
    ok('DeepSeek: key sent only as Bearer header, never in URL', ds.every((e) => e.auth === 'Bearer sk-test-1234567890' && !e.url.includes('sk-test')));
    const models = await page.evaluate(() => [...document.querySelectorAll('#set-chat-model option')].map((o) => o.value));
    ok('DeepSeek: model list from GET /models populates dropdown', models.includes('deepseek-v9-mock'), models.join(','));
    ok('DeepSeek: models cached for 24h', await page.evaluate(() => JSON.parse(localStorage.getItem('su3rah_deepseek_models')).list.length === 3));
    if (SHOTS) { await page.waitForTimeout(500); await page.screenshot({ path: path.join(SHOTS, 'settings-mobile.png'), fullPage: true }); }

    // Chat
    const geminiBefore = gm.length;
    await page.evaluate(() => switchTab('chat'));
    await page.fill('#input-chat-text', 'كم بروتين باقي لي؟');
    await page.click('button[aria-label="إرسال"]');
    await page.waitForFunction(() => getActiveChatSession().messages.some((m) => m.provider === 'deepseek'), null, { timeout: 8000 });
    const chatReq = ds.filter((e) => e.path === '/chat/completions').pop();
    const roles = chatReq.body.messages.map((m) => m.role);
    ok('DeepSeek chat: proper multi-turn messages (system → user/assistant alternating → user)', roles[0] === 'system' && roles[roles.length - 1] === 'user' && roles.slice(1).every((r, i, a) => i === 0 || r !== a[i - 1]) && roles.includes('assistant'), roles.join('>'));
    ok('DeepSeek chat: system prompt carries goals + today intake', /2300/.test(chatReq.body.messages[0].content) && /المستهلك/.test(chatReq.body.messages[0].content));
    ok('DeepSeek chat: model/temperature/max_tokens sent', chatReq.body.model === 'deepseek-chat' && chatReq.body.temperature === 0.75 && chatReq.body.max_tokens === 1200);
    const meta = await page.textContent('#chat-messages-container .bubble-meta:last-of-type');
    ok('DeepSeek chat: label under the coach message shows provider · model', /DeepSeek · deepseek-chat/.test(await page.evaluate(() => [...document.querySelectorAll('#chat-messages-container .bubble-meta')].pop().textContent)), meta);
    ok('DeepSeek chat: Gemini fetch wrapper not involved (no Gemini generateContent, Gemini usage counter untouched)', gm.slice(geminiBefore).filter((e) => /generateContent/.test(e.url)).length === 0 && await page.evaluate(() => !Object.keys(getUsageMap()).length));
    ok('DeepSeek usage tracked per model with tokens', await page.evaluate(() => DeepSeekUsage.today()['deepseek-chat'].in === 321 && DeepSeekUsage.today()['deepseek-chat'].out === 54));
    if (SHOTS) await page.screenshot({ path: path.join(SHOTS, 'chat-mobile.png') });

    // Meal analysis (text) via DeepSeek JSON mode
    await page.evaluate(() => switchTab('dashboard'));
    await page.evaluate(() => openMealModal());
    await page.fill('#ai-description', 'صدر دجاج 200 غرام مع رز');
    await page.click('#btn-submit-ai');
    await page.waitForFunction(() => state.meals.some((m) => /DeepSeek/.test(m.source)), null, { timeout: 8000 });
    const anaReq = ds.filter((e) => e.path === '/chat/completions').pop();
    const meal = await page.evaluate(() => state.meals.find((m) => /DeepSeek/.test(m.source)));
    ok('DeepSeek analysis: response_format json_object + JSON parsed into meal', anaReq.body.response_format?.type === 'json_object' && meal.calories === 612 && meal.protein === 48 && meal.source === 'DeepSeek (deepseek-chat)', meal.source);
    ok('New meals carry numeric createdAt', typeof meal.createdAt === 'number' && meal.createdAt > 1e12);
    ok('Meal card shows source badge', (await page.textContent('#meals-container')).includes('DeepSeek (deepseek-chat)'));

    // Reasoner: rejects JSON mode → retried without; no temperature sent
    await page.evaluate(() => setTaskModel('analysis', 'deepseek-reasoner'));
    await page.evaluate(() => openMealModal());
    await page.fill('#ai-description', 'سلطة سيزر');
    const nBefore = ds.length;
    await page.click('#btn-submit-ai');
    await page.waitForFunction((n) => state.meals.filter((m) => /deepseek-reasoner/.test(m.source)).length === 1, nBefore, { timeout: 8000 });
    const rs = ds.slice(nBefore).filter((e) => e.path === '/chat/completions');
    ok('DeepSeek reasoner: temperature omitted, JSON-mode 400 retried without response_format', rs.length === 2 && rs.every((e) => e.body.temperature === undefined) && rs[0].body.response_format && !rs[1].body.response_format);
    await page.evaluate(() => setTaskModel('analysis', 'deepseek-chat'));

    // Photo meal → Gemini automatically
    const dsBefore = ds.length, gmBefore = gm.length;
    await page.evaluate(() => openMealModal());
    await page.setInputFiles('#meal-gallery-input', path.join(ROOT, 'icon.png'));
    await page.waitForFunction(() => state.mealImages.length === 1);
    ok('Photo: route note visible when analysis provider is DeepSeek', await page.isVisible('#photo-route-note'));
    if (SHOTS) await page.screenshot({ path: path.join(SHOTS, 'meal-modal.png') });
    await page.fill('#ai-description', 'طبق في الصورة');
    await page.click('#btn-submit-ai');
    await page.waitForFunction(() => state.meals.some((m) => /^Gemini/.test(m.source) && m.calories === 733), null, { timeout: 8000 });
    const gReq = gm.slice(gmBefore).find((e) => /generateContent/.test(e.url));
    ok('Photo: request went to Gemini with inlineData, DeepSeek not called', gReq && JSON.stringify(gReq.body).includes('inlineData') && ds.slice(dsBefore).filter((e) => e.path === '/chat/completions').length === 0);
    ok('Photo: toast tells the user it was routed to Gemini', /Gemini/.test(await lastToast(page)), await lastToast(page));
    const photoMeal = await page.evaluate(() => state.meals.find((m) => m.calories === 733));
    ok('Photo: compressed image saved with the meal', photoMeal.images.length === 1 && /^data:image\/jpeg/.test(photoMeal.images[0]));

    // Provider switching: chat → Gemini
    await page.evaluate(() => setTaskProvider('chat', 'gemini'));
    await page.evaluate(() => switchTab('chat'));
    await page.fill('#input-chat-text', 'مرحبا');
    await page.click('button[aria-label="إرسال"]');
    await page.waitForFunction(() => getActiveChatSession().messages.slice(-1)[0].provider === 'gemini', null, { timeout: 8000 });
    ok('Switching: chat provider → Gemini answers, label updated', /Gemini/.test(await page.evaluate(() => [...document.querySelectorAll('#chat-messages-container .bubble-meta')].pop().textContent)));
    ok('Switching: top-bar quick switcher reflects provider', await page.evaluate(() => document.getElementById('chat-provider-select').value === 'gemini'));
    await page.evaluate(() => setTaskProvider('chat', 'deepseek'));
    await page.evaluate(() => switchTab('dashboard'));
    if (SHOTS) { await page.waitForTimeout(1000); await page.screenshot({ path: path.join(SHOTS, 'dashboard-meals.png'), fullPage: true }); }

    // Gemini Live opens (WebSocket mocked)
    await page.evaluate(() => startLiveCall());
    try { await page.waitForFunction(() => /متصل —/.test(document.getElementById('live-call-status').textContent), null, { timeout: 10000 }); }
    catch (e) { console.log('   live status was:', await page.textContent('#live-call-status'), '| cc:', await page.textContent('#cc-live-state')); }
    ok('Gemini Live: overlay opens and session reaches "متصل"', await page.isVisible('#live-call-overlay') && /متصل —/.test(await page.textContent('#live-call-status')), await page.textContent('#live-call-status'));
    if (SHOTS) await page.screenshot({ path: path.join(SHOTS, 'live-call.png') });
    await page.evaluate(() => endLiveCall());
    ok('Gemini Live: closes cleanly', !(await page.isVisible('#live-call-overlay')));

    // Pattern engine through AIProvider (DeepSeek default, Gemini key present for retrieval)
    await page.evaluate(() => switchTab('command'));
    await page.evaluate(() => PatternEngine.run());
    await page.waitForFunction(() => /DeepSeek|Gemini/.test(document.getElementById('cc-progress-label').textContent) && /اكتمل|محلي/.test(document.getElementById('cc-progress-label').textContent), null, { timeout: 15000 });
    ok('PatternEngine: runs through AIProvider', /اكتمل التحليل عبر/.test(await page.textContent('#cc-progress-label')), await page.textContent('#cc-progress-label'));
    if (SHOTS) await page.screenshot({ path: path.join(SHOTS, 'command.png'), fullPage: true });
    // Story card renders
    await page.evaluate(() => switchTab('dashboard'));
    await page.evaluate(() => openShareStoryModal());
    await page.waitForTimeout(800);
    if (SHOTS) {
      const data = await page.evaluate(() => document.getElementById('story-canvas').toDataURL('image/png'));
      fs.writeFileSync(path.join(SHOTS, 'story-card.png'), Buffer.from(data.split(',')[1], 'base64'));
    }
    ok('Story card: canvas painted', await page.evaluate(() => { const c = document.getElementById('story-canvas').getContext('2d').getImageData(300, 420, 1, 1).data; return c[3] === 255; }));
    await page.evaluate(() => closeShareStoryModal());
    await ctx.close();
  }

  // ---- fallbacks ----
  async function fallbackCase(label, dsBehaviour, gmBehaviour, setup, expect) {
    const ctx = await newContext(browser); const ds = mockDeepSeek(ctx, dsBehaviour); const gm = mockGemini(ctx, gmBehaviour);
    const page = await ctx.newPage(); watch(page, label);
    await seedLegacy(page);
    await openApp(page);
    page.on('dialog', (d) => d.accept());
    await page.evaluate(setup);
    await page.evaluate(() => { openMealModal(); document.getElementById('ai-description').value = 'دجاج مع رز'; });
    await page.click('#btn-submit-ai');
    await page.waitForFunction((n) => state.meals.length === n + 1, 7, { timeout: 10000 });
    const m = await page.evaluate(() => state.meals[0]);
    expect(m, await lastToast(page), ds, gm);
    // chat too
    await page.evaluate(() => { switchTab('chat'); document.getElementById('input-chat-text').value = 'سؤال'; sendChatMessage(); });
    await page.waitForFunction(() => !state.isChatThinking, null, { timeout: 10000 });
    const last = await page.evaluate(() => getActiveChatSession().messages.slice(-1)[0]);
    await ctx.close();
    return last;
  }
  let last = await fallbackCase('fb-invalid', { status: 401 }, {}, () => { state.deepseekKey = 'sk-bad'; },
    (m, t) => ok('Fallback: DeepSeek 401 → Gemini answers analysis (auto-fallback ON)', /^Gemini/.test(m.source) && /تحويل تلقائي/.test(t), `${m.source} | ${t}`));
  ok('Fallback: DeepSeek 401 → Gemini answers chat', last.provider === 'gemini');
  last = await fallbackCase('fb-missing', {}, {}, () => { state.deepseekKey = ''; },
    (m) => ok('Fallback: missing DeepSeek key → Gemini', /^Gemini/.test(m.source), m.source));
  last = await fallbackCase('fb-both', { status: 402 }, { status: 400 }, () => { state.deepseekKey = 'sk-x'; },
    (m) => ok('Fallback: both providers fail → local estimate with reason', m.source === 'تقدير محلي' && /رصيد DeepSeek/.test(m.notes) && /Gemini/.test(m.notes), m.notes.slice(0, 120)));
  ok('Fallback: chat shows Arabic reasons when everything fails', last.error && /رصيد DeepSeek غير كافٍ/.test(last.text));
  last = await fallbackCase('fb-off', { status: 402 }, {}, () => { state.deepseekKey = 'sk-x'; AISettings.v.autoFallback = false; },
    (m) => ok('Fallback OFF: DeepSeek 402 → local estimate (Gemini not tried)', m.source === 'تقدير محلي'));
  last = await fallbackCase('fb-cors', { abort: true }, {}, () => { state.deepseekKey = 'sk-x'; AISettings.v.autoFallback = false; }, () => {});
  ok('CORS/network failure: clear Arabic message, not silent', /CORS/.test(last.text) && /api\.deepseek\.com/.test(last.text), last.text.slice(0, 140));
  {
    const ctx = await newContext(browser); mockDeepSeek(ctx, { noBalance: true }); const page = await ctx.newPage();
    await seedLegacy(page); await openApp(page);
    await page.evaluate(() => { state.deepseekKey = 'sk-zero'; });
    await page.evaluate(() => testDeepseekConnection());
    await page.waitForFunction(() => /رصيد/.test(document.getElementById('deepseek-key-status').textContent));
    ok('Test connection: "no balance" status', /لا يوجد رصيد/.test(await page.textContent('#deepseek-key-status')));
    await page.unrouteAll({ behavior: 'ignoreErrors' });
    await ctx.route('https://api.deepseek.com/**', (r) => r.fulfill({ status: 401, headers: { 'Access-Control-Allow-Origin': BASE }, body: '{"error":{"message":"bad"}}' }));
    await page.evaluate(() => testDeepseekConnection());
    await page.waitForFunction(() => /غير صالح/.test(document.getElementById('deepseek-key-status').textContent));
    ok('Test connection: "invalid key" status', true);
    await ctx.unrouteAll({ behavior: 'ignoreErrors' });
    await ctx.route('https://api.deepseek.com/**', (r) => r.abort('failed'));
    await page.evaluate(() => testDeepseekConnection());
    await page.waitForFunction(() => /CORS/.test(document.getElementById('deepseek-key-status').textContent));
    ok('Test connection: "CORS / network" status', true);
    await ctx.close();
  }

  // =============== 6. EXPORT / IMPORT round-trip, WIPE ===============
  {
    const ctx = await newContext(browser, { acceptDownloads: true });
    const page = await ctx.newPage(); watch(page, 'backup');
    await seedLegacy(page);
    await openApp(page);
    await page.evaluate(() => switchTab('settings'));
    let [dl] = await Promise.all([page.waitForEvent('download'), page.click('text=تصدير كل البيانات')]);
    const file1 = path.join(require('os').tmpdir(), 'su3rah-export-1.json'); await dl.saveAs(file1); const json1 = JSON.parse(fs.readFileSync(file1, 'utf8'));
    ok('Export: meals, chats, goal, settings, insights included', json1.data.meals.length === 7 && json1.data.chatSessions.length === 2 && json1.data.goal.targetCalories === 2300 && json1.data.v5Insights && json1.data.aiSettings);
    ok('Export: API keys NOT included by default', !json1.keys && !JSON.stringify(json1).includes('AIzaTEST-old-key'));
    await page.check('#backup-include-keys');
    [dl] = await Promise.all([page.waitForEvent('download'), page.click('text=تصدير كل البيانات')]);
    const file2 = path.join(require('os').tmpdir(), 'su3rah-export-2.json'); await dl.saveAs(file2); const json2 = JSON.parse(fs.readFileSync(file2, 'utf8'));
    ok('Export: keys included only when the checkbox is ticked', json2.keys && json2.keys.gemini === 'AIzaTEST-old-key');
    await ctx.close();

    // Import into a different device that already has its own meals
    const ctx2 = await newContext(browser);
    const p2 = await ctx2.newPage(); watch(p2, 'import');
    await openApp(p2);   // fresh → sample meal
    await p2.evaluate(() => { quickAddFood('وجبة الجهاز الثاني', 200, 10, 20, 5); });
    p2.on('dialog', (d) => d.accept());
    await p2.evaluate(() => switchTab('settings'));
    await p2.setInputFiles('#import-file-input', file1);
    await p2.waitForFunction(() => state.meals.length >= 9, null, { timeout: 8000 });
    const s = await p2.evaluate(() => ({ n: state.meals.length, own: state.meals.some((m) => m.title === 'وجبة الجهاز الثاني'), goal: state.goalConfig.targetCalories, chats: state.chatSessions.length }));
    ok('Import: merged by id, existing local meals kept', s.n === 9 && s.own, JSON.stringify(s));
    ok('Import: goals applied (user confirmed) and chats merged', s.goal === 2300 && s.chats >= 3);
    await p2.setInputFiles('#import-file-input', file1);
    await p2.waitForTimeout(800);
    ok('Import twice: no duplicates', await p2.evaluate(() => state.meals.length) === 9, await lastToast(p2));
    await p2.evaluate(() => undoLastSnapshot());
    await p2.waitForTimeout(300);
    // second import added nothing → undo is a no-op; take first-import undo path by importing into a clean context instead
    const ctx3 = await newContext(browser); const p3 = await ctx3.newPage(); p3.on('dialog', (d) => d.accept());
    await openApp(p3); await p3.evaluate(() => quickAddFood('محلي', 100, 1, 1, 1));
    await p3.setInputFiles('#import-file-input', file1);
    await p3.waitForFunction(() => state.meals.length >= 9);
    await p3.evaluate(() => undoLastSnapshot()); await p3.waitForTimeout(300);
    const u = await p3.evaluate(() => ({ n: state.meals.length, local: state.meals.some((m) => m.title === 'محلي'), goal: state.goalConfig.targetCalories }));
    ok('Import undo: imported meals removed, local meal kept, goal restored', u.n === 2 && u.local && u.goal !== 2300, JSON.stringify(u));
    await ctx3.close();

    // Wipe: wrong word → nothing; correct word → only su3rah keys removed
    const ctx4 = await newContext(browser); const p4 = await ctx4.newPage();
    await seedLegacy(p4); await openApp(p4);
    p4.once('dialog', (d) => d.accept('لا'));
    await p4.evaluate(() => wipeAllData()); await p4.waitForTimeout(200);
    ok('Wipe: wrong confirmation word does nothing', await p4.evaluate(() => state.meals.length) === 7);
    p4.once('dialog', (d) => d.accept('امسح'));
    await p4.evaluate(() => wipeAllData()); await p4.waitForTimeout(400);
    const w = await p4.evaluate(() => ({ n: state.meals.length, other: localStorage.getItem('other_app_key'), su3rah: Object.keys(localStorage).filter((k) => /^su3rah/.test(k)) }));
    ok('Wipe: typed "امسح" clears su3rah data only (other keys survive)', w.n === 0 && w.other === 'must-survive-wipe', JSON.stringify(w));
    await p4.reload(); await booted(p4);
    ok('Wipe: after reload no sample meal and no auto-rescue', await p4.evaluate(() => state.meals.length) === 0);
    await ctx4.close(); await ctx2.close();
  }

  // =============== 7. Desktop screenshots ===============
  if (SHOTS) {
    const ctx = await newContext(browser, { viewport: { width: 1360, height: 900 } }); mockDeepSeek(ctx); mockGemini(ctx);
    const page = await ctx.newPage();
    await seedLegacy(page); await openApp(page); await page.waitForTimeout(1200);
    await page.screenshot({ path: path.join(SHOTS, 'dashboard-desktop.png') });
    await page.evaluate(() => switchTab('settings')); await page.waitForTimeout(600);
    await page.screenshot({ path: path.join(SHOTS, 'settings-desktop.png'), fullPage: true });
    await page.goto(`${BASE}/index.html`); await page.waitForTimeout(150);
    await page.screenshot({ path: path.join(SHOTS, 'splash.png') });
    await ctx.close();
  }

  ok('No uncaught page errors', errors.length === 0, errors.slice(0, 5).join(' | '));
  await browser.close(); server.close();
  const failed = results.filter((r) => !r.pass);
  console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
  process.exit(failed.length ? 1 : 0);
})().catch((e) => { console.error(e); server.close(); process.exit(2); });
