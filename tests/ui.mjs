// Shepr end-to-end test: iPhone-sized Chromium against a server running on the ISOLATED hrtest herdr session.
//   tests/fake-session.sh up ; eval "$(tests/fake-session.sh env)"; SHEPR_URL=http://localhost:8743 python3 server.py 8743 &
//   node tests/ui.mjs
import { createRequire } from 'module';
import { execFileSync } from 'child_process';
import fs from 'fs';
const require = createRequire(process.env.PW_PATH || '/home/pi/.local/share/mise/installs/npm-playwright/latest/node_modules/');
const { chromium, devices } = require('playwright');

const OUT = '/tmp/claude-1000/shots'; fs.mkdirSync(OUT, { recursive: true });
const BASE = 'http://localhost:8743';
const SERVER = new URL('../server.py', import.meta.url).pathname;
const ENV = { ...process.env, SHEPR_STATE: process.env.SHEPR_STATE || '/tmp/claude-1000/shepr-state', SHEPR_URL: BASE,
              HERDR_SOCKET_PATH: process.env.HERDR_SOCKET_PATH || '/home/pi/.config/herdr/sessions/hrtest/herdr.sock' };
const cli = (...a) => execFileSync('python3', [SERVER, ...a], { env: ENV, encoding: 'utf8' });
const newCode = (png) => JSON.parse(cli('pair', '--no-wait', '--json', ...(png ? ['--png', png] : '')));

const ok = [];
const check = (name, cond) => { ok.push([name, !!cond]); console.log((cond ? 'PASS ' : 'FAIL ') + name); };
const errs = [];

// pointer helpers: dispatch the sequences a finger produces
async function hold(page, sel, ms) {
  await page.evaluate(({ sel, ms }) => new Promise((res) => {
    const n = document.querySelector(sel); const r = n.getBoundingClientRect();
    const o = { bubbles: true, clientX: r.x + r.width / 2, clientY: r.y + r.height / 2, pointerId: 1, pointerType: 'touch', isPrimary: true, button: 0 };
    n.dispatchEvent(new PointerEvent('pointerdown', o));
    setTimeout(() => { n.dispatchEvent(new PointerEvent('pointerup', o)); res(); }, ms);
  }), { sel, ms });
}
async function tap(page, sel, n = 1, gap = 90) {
  await page.evaluate(({ sel, n, gap }) => new Promise((res) => {
    const node = document.querySelector(sel); const r = node.getBoundingClientRect();
    const o = { bubbles: true, clientX: r.x + r.width / 2, clientY: r.y + r.height / 2, pointerId: 1, pointerType: 'touch', isPrimary: true, button: 0 };
    let i = 0; const go = () => {
      node.dispatchEvent(new PointerEvent('pointerdown', o)); node.dispatchEvent(new PointerEvent('pointerup', o));
      if (++i < n) setTimeout(go, gap); else res();
    }; go();
  }), { sel, n, gap });
}
const watch = (page) => {
  page.on('pageerror', (e) => errs.push('pageerror: ' + e.message));
  page.on('console', (m) => { if (m.type() === 'error' && !/400|401|403|409|410|429|502/.test(m.text())) errs.push('console: ' + m.text()); });
};

const dev = devices['iPhone 14'];
const browser = await chromium.launch({ executablePath: '/usr/bin/chromium', args: ['--no-sandbox'] });

// =============================================================== 1. splash + first run (unpaired)
{
  const ctx = await browser.newContext({ ...dev, serviceWorkers: 'block' });
  const page = await ctx.newPage(); watch(page);
  await page.goto(BASE + '/');
  await page.waitForSelector('#splash');
  check('splash shows the wordmark', (await page.textContent('.sword')).replace(/\s/g, '') === 'SHEPR');
  await page.waitForTimeout(400);  await page.screenshot({ path: `${OUT}/s1-splash-early.png` });
  await page.screenshot({ path: `${OUT}/s2-splash-mid.png` });
  await page.waitForSelector('#splash', { state: 'detached', timeout: 6000 });
  check('splash removes itself', true);
  check('unpaired phone lands on the pairing screen', await page.isVisible('#pair'));
  check('no API data is shown while unpaired', (await page.$$('.item')).length === 0);
  await page.screenshot({ path: `${OUT}/p1-pair.png` });

  // ---- pair by typing the code
  const { code } = newCode();
  await page.click('#pcode');
  await page.fill('#pcodein', code.toLowerCase().replace(/-/g, ''));
  check('code field formats as XXXX-XXXX-XXXX', (await page.inputValue('#pcodein')) === code);
  await page.fill('#pname', 'Test iPhone');
  await page.screenshot({ path: `${OUT}/p2-form.png` });
  await page.click('#pgo');
  await page.waitForSelector('#pdone:not([hidden])');
  await page.waitForTimeout(500);
  await page.screenshot({ path: `${OUT}/p3-success.png` });
  await page.waitForSelector('.item', { timeout: 8000 });
  check('pairing succeeds and the queue loads with signed requests', (await page.$$('.item')).length >= 3);
  check('private key is stored non-extractable', await page.evaluate(async () => { const d = window.shepr.S.dev; return d.key.extractable === false && d.key.type === 'private'; }));
  const devJson = JSON.parse(fs.readFileSync(ENV.SHEPR_STATE + '/devices.json', 'utf8'));
  const myId = await page.evaluate(() => window.shepr.S.dev.id);
  check('host recorded this phone as a public key only (no private part)', !!devJson[myId] && !('d' in devJson[myId]) && Object.values(devJson).every((d) => !('d' in d)));
  const reuse = await page.evaluate(async (code) => {
    const kp = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign']);
    const j = await crypto.subtle.exportKey('jwk', kp.publicKey);
    const r = await fetch('api/pair', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Shepr': '1' },
      body: JSON.stringify({ code, jwk: { kty: j.kty, crv: j.crv, x: j.x, y: j.y }, name: 'attacker' }) });
    return r.status;
  }, code);
  check('a used pairing code cannot be used again', reuse === 403);

  // ---- attacks against the signature scheme
  const r = await page.evaluate(async () => {
    const S = window.shepr, out = {};
    const h = await S.signHeaders('GET', 'api/queue', '');
    out.first = (await fetch('api/queue', { headers: h })).status;
    out.replay = (await fetch('api/queue', { headers: h })).status;
    const h2 = await S.signHeaders('GET', 'api/queue', '');
    out.otherPath = (await fetch('api/pane?host=gus&pane=w1:p1', { headers: h2 })).status;   // signed for another path
    const h3 = await S.signHeaders('POST', 'api/hosts/scan', '{}');
    out.methodSwap = (await fetch('api/hosts', { headers: h3 })).status;
    out.noSig = (await fetch('api/queue')).status;
    const h4 = { ...(await S.signHeaders('GET', 'api/queue', '')), 'X-Shepr-Ts': String(Date.now() - 10 * 60 * 1000) };
    out.stale = (await fetch('api/queue', { headers: h4 })).status;
    return out;
  });
  console.log('   attacks:', JSON.stringify(r));
  check('valid signature accepted once', r.first === 200);
  check('replayed request refused', r.replay === 401);
  check('signature bound to the path', r.otherPath === 401);
  check('signature bound to the method', r.methodSwap === 401);
  check('unsigned request refused', r.noSig === 401);
  check('old timestamp refused', r.stale === 401);

  // ---- main screen
  await page.waitForTimeout(600);
  await page.screenshot({ path: `${OUT}/q1-queue.png` });
  const ages = await page.$$eval('.item .age', (n) => n.map((x) => x.textContent));
  check('queue shows blocked rows', ages.length >= 3);

  // ---- the host announces the current build; a stale app reloads itself, but only at a safe moment
  const t0 = await page.evaluate(() => performance.timeOrigin);
  await page.evaluate(() => window.shepr.appIsStale('v999'));      // on the list, nothing typed, no sheet: safe
  await page.waitForTimeout(1800);
  await page.waitForSelector('.item', { timeout: 8000 });
  check('a stale app reloads itself on the list screen', (await page.evaluate(() => performance.timeOrigin)) !== t0);
  check('reload keeps this phone paired (key survives)', (await page.$$('.item')).length >= 3);
  check('page does not scroll (Law 17)', await page.evaluate(() => document.documentElement.scrollHeight <= innerHeight + 1));

  // ---- queue order: needs you, then sleeping, then working
  const secs = await page.$$eval('#main .sec', (n) => n.map((x) => x.textContent.trim().split(' ')[0]));
  console.log('   sections:', secs.join(' > '));
  check('queue order: Needs you before Sleeping before Working', secs.indexOf('Needs') === 0 && secs.indexOf('Sleeping') > secs.indexOf('Needs') && (secs.indexOf('Working') === -1 || secs.indexOf('Working') > secs.indexOf('Sleeping')));
  const statuses = await page.$$eval('#main .item', (n) => n.map((x) => x.classList.contains('blocked') ? 'b' : x.classList.contains('working') ? 'w' : 'i').join(''));
  check('rows are ordered blocked, then sleeping, then working', /^b+i*w*$/.test(statuses));

  // ---- wake sleeping sessions: confirm first, never a blocked one
  const blockedPane = await page.evaluate(() => window.shepr.S.q.agents.find((a) => a.status === 'blocked'));
  const refuse = await page.evaluate(async (a) => {
    const body = JSON.stringify({ kind: 'wake', targets: [{ host: a.host, pane: a.pane }], text: 'go' });
    const h = await window.shepr.signHeaders('POST', 'api/send/prepare', body);
    const r = await fetch('api/send/prepare', { method: 'POST', headers: { ...h, 'Content-Type': 'application/json', 'X-Shepr': '1' }, body });
    return [r.status, (await r.json()).error];
  }, blockedPane);
  check('wake refuses a BLOCKED session (cannot approve anything)', refuse[0] === 400 && refuse[1] === 'not_sleeping');
  await page.click('#main .secrow .mini-btn');
  await page.waitForSelector('#sheet:not([hidden]) .chk');
  await page.waitForTimeout(500);
  await page.screenshot({ path: `${OUT}/w1-wake.png` });
  check('wake sheet lists the sleeping sessions, all ticked', (await page.$$eval('#sheet .chk input', (n) => n.length && n.every((x) => x.checked))));
  await page.fill('#sheet .wakemsg', 'Pick this back up');
  await page.click('#sheet .btns .go');
  await page.waitForSelector('#sheet .kv');
  const prev = await page.textContent('#sheet .kv');
  await page.screenshot({ path: `${OUT}/w2-wake-confirm.png` });
  check('preview names every target and the exact message', prev.includes('Wakes') && prev.includes('Pick this back up'));
  check('wake preview says nothing is approved', prev.includes('Nothing is approved'));
  await page.waitForTimeout(900);
  await page.click('#sheet .btns .go');                      // Wake them
  await page.waitForSelector('#gtoast:not([hidden])', { timeout: 15000 });
  const wres = await page.textContent('#gtoast');
  console.log('   wake result:', wres.slice(0, 160));
  check('wake reports honestly (the fake agent refuses a prompt, and it says so)', /failed|Woke/.test(wres));

  // ---- slash row: last 6 used, tap fills (never sends), MORE searches all, none on a blocked session
  const idleA = await page.evaluate(() => window.shepr.S.q.agents.find((a) => a.status === 'idle'));
  await tap(page, `.item[data-key="${idleA.host}|${idleA.pane}"]`);
  await page.waitForSelector('#detail:not([hidden])'); await page.waitForSelector('#slashbtn:not([hidden])', { timeout: 8000 });
  await page.click('#slashbtn'); await page.waitForSelector('#slashrow:not([hidden]) button:not(.more)');
  const chips = await page.$$eval('#slashrow button:not(.more)', (n) => n.map((x) => x.textContent));
  console.log('   slash chips:', chips.join(' '));
  check('slash row: last 6 used, newest first, no /exit, no paths', JSON.stringify(chips) === JSON.stringify(['/Beta', '/effort', '/plug:delta', '/Alpha', '/model', '/Gamma']));
  await page.screenshot({ path: `${OUT}/sl1-row.png` });
  await page.click('#slashrow button:first-child');
  check('tapping a chip fills the box with /name and sends nothing', (await page.inputValue('#msg')) === '/Beta ' && (await page.$eval('#sheet', (n) => n.hidden)));
  await page.fill('#msg', '/al');
  check('typing / filters the row to matches', (await page.$$eval('#slashrow button:not(.more)', (n) => n.map((x) => x.textContent))).includes('/Alpha'));
  await page.fill('#msg', '');
  await page.click('#slashbtn');                                                     // open the row again
  await page.click('#slashrow .more'); await page.waitForSelector('#sheet:not([hidden]) .cmd');
  await page.fill('#sheet .search', 'delta'); await page.waitForTimeout(200);
  const found = await page.$$eval('#sheet .cmd .n', (n) => n.map((x) => x.textContent));
  check('MORE searches every skill, including plugin skills', found.length === 1 && found[0] === '/plug:delta');
  await page.fill('#sheet .search', 'fixture'); await page.waitForTimeout(200);
  await page.screenshot({ path: `${OUT}/sl2-more.png` });
  check('MORE search matches descriptions too (3 fixture skills)', (await page.$$('#sheet .cmd')).length === 3);
  await page.click('#sheet .cmd:first-child');
  check('picking from MORE fills the box', /^\/[A-Za-z]/.test(await page.inputValue('#msg')) && (await page.$eval('#sheet', (n) => n.hidden)));
  await page.fill('#msg', '/Alpha please'); await page.click('#send'); await page.waitForSelector('#sheet:not([hidden]) .kv');
  check('a slash command still goes through the preview sheet', (await page.textContent('#sheet .kv')).includes('/Alpha please'));
  await page.click('#sheet .btns button:first-child'); await page.fill('#msg', '');
  await page.click('#dback'); await page.waitForTimeout(300);
  const blk = await page.evaluate(() => window.shepr.S.q.agents.find((a) => a.status === 'blocked'));
  await tap(page, `.item[data-key="${blk.host}|${blk.pane}"]`);
  await page.waitForSelector('#detail:not([hidden])'); await page.waitForSelector('#optrow button'); await page.waitForTimeout(400);
  check('a session at a dialog offers no slash command', await page.$eval('#slashbtn', (n) => n.hidden));
  await page.click('#dback'); await page.waitForTimeout(300);

  // ---- session text is big and adjustable
  await tap(page, '.item:nth-of-type(2)');
  await page.waitForSelector('#detail:not([hidden])'); await page.waitForTimeout(600);
  const fs1 = await page.$eval('#tail', (n) => parseFloat(getComputedStyle(n).fontSize));
  check('session text is at least 17px', fs1 >= 17);
  await page.click('#fsp'); await page.click('#fsp');
  const fs2 = await page.$eval('#tail', (n) => parseFloat(getComputedStyle(n).fontSize));
  check('A+ makes the session text bigger', fs2 === fs1 + 2);
  await page.click('#fsm'); await page.click('#fsm'); await page.click('#fsm');
  check('A- makes it smaller', (await page.$eval('#tail', (n) => parseFloat(getComputedStyle(n).fontSize))) === fs1 - 1);
  await page.click('#fsp');
  await page.screenshot({ path: `${OUT}/d3-bigtext.png` });
  // inside a session a stale app must NOT reload under your thumb: it offers an Update button instead
  const t1 = await page.evaluate(() => performance.timeOrigin);
  await page.evaluate(() => window.shepr.appIsStale('v999'));
  await page.waitForTimeout(800);
  check('in a session: no reload, an Update button appears', (await page.evaluate(() => performance.timeOrigin)) === t1 && (await page.textContent('#toast')).includes('Update'));
  await page.click('#dback'); await page.waitForTimeout(300);

  // ---- icon tab bar
  const tabs = await page.$$eval('.tab', (n) => n.map((x) => [x.dataset.view, !!x.querySelector('svg'), x.textContent.trim()]));
  console.log('   tabs:', JSON.stringify(tabs));
  check('five icon tabs with labels', tabs.length === 5 && tabs.every((t) => t[1]));
  const x0 = await page.$eval('#tabind', (n) => getComputedStyle(n).transform);
  await tap(page, '.tab[data-view=all]'); await page.waitForTimeout(500);
  const x1 = await page.$eval('#tabind', (n) => getComputedStyle(n).transform);
  check('tab indicator slides', x0 !== x1);
  await page.screenshot({ path: `${OUT}/t1-herd.png` });
  await tap(page, '.tab[data-view=go]'); await page.waitForSelector('#sheet:not([hidden]) .search');
  check('Go tab opens Go To', true);
  await page.waitForTimeout(600);   // let the sheet finish sliding up before measuring it
  check('Go To sheet keeps its Close button on screen', await page.evaluate(() => { const b = document.querySelector('#sheet .btns button'); return b && b.getBoundingClientRect().bottom <= innerHeight; }));
  await page.screenshot({ path: `${OUT}/t2-goto.png` });
  await page.evaluate(() => document.getElementById('shade').click());
  await tap(page, '.tab[data-view=waiting]'); await page.waitForTimeout(300);

  // ---- gestures still work
  await hold(page, '.item:nth-of-type(2)', 650);
  await page.waitForSelector('#sheet:not([hidden]) .peek'); await page.waitForTimeout(400);
  check('long-press row opens peek', (await page.textContent('.peek')).length > 10);
  await page.click('#sheet .btns button:first-child');
  await tap(page, '.item:nth-of-type(2)');
  await page.waitForSelector('#detail:not([hidden])');
  await page.waitForFunction(() => document.querySelector('#tail').textContent.length > 20);
  await page.waitForTimeout(500);
  await page.screenshot({ path: `${OUT}/d1-detail.png` });
  check('detail shows option buttons', (await page.$$('#optrow button')).length >= 3);
  const before = await page.textContent('#dsub');
  await tap(page, '#dhead', 2, 80); await page.waitForTimeout(900);
  check('double-tap title jumps to next waiting', before !== (await page.textContent('#dsub')));
  await hold(page, '#dhead', 650); await page.waitForTimeout(900);
  check('hold title flips back', (await page.textContent('#dsub')) === before);

  // ---- confirm sheet; nothing sent until Send
  await page.click('#optrow button:nth-child(2)');
  await page.waitForSelector('#sheet:not([hidden]) .kv');
  await page.screenshot({ path: `${OUT}/d2-confirm.png` });
  check('Send disabled at first (ghost-tap guard)', await page.locator('#sheet .btns .go').isDisabled());
  await page.click('#sheet .btns button:first-child');
  await page.click('#dback');

  // ---- hosts + keys
  await tap(page, '.tab[data-view=hosts]'); await page.waitForTimeout(900);
  await page.screenshot({ path: `${OUT}/h1-hosts.png` });
  check('Hosts view lists the local host and vic (disabled)', (await page.textContent('#main')).includes('vic'));
  await tap(page, '.tab[data-view=keys]'); await page.waitForTimeout(900);
  await page.screenshot({ path: `${OUT}/k1-keys.png` });
  check('Keys view shows the device fingerprint', (await page.textContent('#main')).includes('SHA256:'));

  // ---- revocation signs the phone out
  cli('revoke', myId);
  await page.evaluate(() => window.shepr.S.q && fetch('api/queue').catch(() => 0));
  await page.evaluate(async () => { try { await window.fetch('api/queue', { headers: await window.shepr.signHeaders('GET', 'api/queue', '') }); } catch (e) {} });
  await tap(page, '#refresh').catch(() => {}); await page.click('#refresh');
  await page.waitForSelector('#pair:not([hidden])', { timeout: 6000 });
  check('revoked phone is thrown back to the pairing screen', true);
  const rv = await page.evaluate(async () => (await fetch('api/queue', { headers: await window.shepr.signHeaders('GET', 'api/queue', '') })).status);
  check('revoked key is refused by the host', rv === 401);
  await ctx.close();
}

// =============================================================== 2. pair by SCANNING (fake camera -> jsQR)
{
  const { url } = newCode('/tmp/claude-1000/qr-live.png');
  execFileSync('ffmpeg', ['-y', '-loglevel', 'error', '-loop', '1', '-i', '/tmp/claude-1000/qr-live.png', '-t', '3', '-r', '15',
    '-vf', 'scale=640:480:force_original_aspect_ratio=decrease,pad=640:480:(ow-iw)/2:(oh-ih)/2:white', '-pix_fmt', 'yuv420p', '/tmp/claude-1000/qr-live.y4m']);
  const b2 = await chromium.launch({ executablePath: '/usr/bin/chromium', args: ['--no-sandbox', '--use-fake-ui-for-media-stream',
    '--use-fake-device-for-media-stream', '--use-file-for-fake-video-capture=/tmp/claude-1000/qr-live.y4m'] });
  const ctx = await b2.newContext({ ...dev, serviceWorkers: 'block', permissions: ['camera'] });
  const page = await ctx.newPage(); watch(page);
  await page.goto(BASE + '/');
  await page.waitForSelector('#pair:not([hidden])', { timeout: 8000 });
  await page.click('#pscan');
  await page.waitForSelector('#pscanner:not([hidden])');
  await page.waitForTimeout(700); await page.screenshot({ path: `${OUT}/sc1-scanner.png` });
  await page.waitForSelector('#pform:not([hidden])', { timeout: 12000 });
  const filled = await page.inputValue('#pcodein');
  check('scanner decoded the QR and filled the code', url.endsWith(filled));
  await page.screenshot({ path: `${OUT}/sc2-scanned.png` });
  await page.click('#pgo');
  await page.waitForSelector('.item', { timeout: 10000 });
  check('paired by scanning, queue loaded', true);
  await ctx.close(); await b2.close();
}

// =============================================================== 3. wrong code is refused
{
  const ctx = await browser.newContext({ ...dev, serviceWorkers: 'block' });
  const page = await ctx.newPage(); watch(page);
  await page.goto(BASE + '/'); await page.waitForSelector('#pair:not([hidden])', { timeout: 8000 });
  await page.click('#pcode'); await page.fill('#pcodein', 'ZZZZZZZZZZZZ'); await page.click('#pgo');
  await page.waitForSelector('#perr:not([hidden])');
  check('wrong code is refused with a clear message', /wrong|expired|used/i.test(await page.textContent('#perr')));
  await ctx.close();
}

await browser.close();
check('no page errors', errs.length === 0);
if (errs.length) console.log(errs.join('\n'));
const failed = ok.filter((x) => !x[1]);
console.log(failed.length ? `\n${failed.length} FAILED` : '\nALL PASSED');
process.exit(failed.length ? 1 : 0);
