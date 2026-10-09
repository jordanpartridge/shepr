// Service worker: network-first shell with a cache fallback. Needs a running test server on :8743 (see ui.mjs header).
import { createRequire } from 'module';
const require = createRequire(process.env.PW_PATH || '/home/pi/.local/share/mise/installs/npm-playwright/latest/node_modules/');
const { chromium, devices } = require('playwright');
const b = await chromium.launch({ executablePath: '/usr/bin/chromium', args: ['--no-sandbox'] });
const ctx = await b.newContext({ ...devices['iPhone 14'] });
const p = await ctx.newPage();
const res = [];
const check = (n, c) => { res.push(!!c); console.log((c ? 'PASS ' : 'FAIL ') + n); };
await p.goto('http://localhost:8743/');
await p.evaluate(() => navigator.serviceWorker.ready.then(() => true));
await p.reload(); await p.waitForTimeout(800);                       // now controlled by the worker
check('service worker controls the page', await p.evaluate(() => !!navigator.serviceWorker.controller));
const cached = await p.evaluate(async () => (await caches.keys()).length && (await (await caches.open((await caches.keys())[0])).keys()).map((r) => new URL(r.url).pathname));
check('shell is cached (index, js, css)', ['/index.html', '/app.js', '/app.css'].every((x) => cached.includes(x) || (x === '/index.html' && cached.includes('/'))));
await ctx.setOffline(true);
await p.reload({ waitUntil: 'domcontentloaded' });
check('offline: the app still opens from cache', (await p.title()).includes('Shepr') && !!(await p.$('#app')));
check('offline: the cached app.js runs (tabs built)', (await p.$$('.tab')).length === 5);
await b.close();
process.exit(res.every(Boolean) ? 0 : 1);
