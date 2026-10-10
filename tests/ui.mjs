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
  page.on('console', (m) => { if (m.type() === 'error' && !/400|401|403|404|409|410|429|502/.test(m.text())) errs.push('console: ' + m.text()); });
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
    // Same path, same (empty) body, ONLY the method differs: a valid POST signature replayed as a GET.
    const h3 = await S.signHeaders('POST', 'api/queue', '');
    out.methodSwap = (await fetch('api/queue', { headers: h3 })).status;
    out.noSig = (await fetch('api/queue')).status;
    // A CORRECTLY signed request that is ten minutes old (the clock offset is part of what gets signed).
    const st = S.S, skew = st.skew; st.skew = skew - 10 * 60 * 1000;
    const h4 = await S.signHeaders('GET', 'api/queue', '');
    st.skew = skew;
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

  // ---- queue order: needs you, then working, then sleeping last
  const secs = await page.$$eval('#main .sec', (n) => n.map((x) => x.textContent.trim().split(' ')[0]));
  console.log('   sections:', secs.join(' > '));
  const tail = secs.filter((x) => x !== 'Asleep');   // the Asleep row (projects with no agent) always comes last of all
  check('queue order: Needs you before Working before Sleeping, then Asleep', secs.indexOf('Needs') === 0 && tail.indexOf('Sleeping') === tail.length - 1 && (tail.indexOf('Working') === -1 || tail.indexOf('Working') < tail.indexOf('Sleeping')) && (secs.indexOf('Asleep') === -1 || secs.indexOf('Asleep') === secs.length - 1));
  const statuses = await page.$$eval('#main .item', (n) => n.map((x) => x.classList.contains('blocked') ? 'b' : x.classList.contains('working') ? 'w' : 'i').join(''));
  check('rows are ordered blocked, then working, then sleeping', /^b+w*i*$/.test(statuses));

  // ---- pull down from the top refreshes (a read: it asks the host for a fresh queue, nothing else)
  {
    let fresh = 0; const onReq = (r) => { if (/api\/queue\?fresh=1/.test(r.url())) fresh++; };
    page.on('request', onReq);
    await page.evaluate(() => {
      const m = document.getElementById('main'); m.scrollTop = 0;
      const t = (type, y) => m.dispatchEvent(new TouchEvent(type, { bubbles: true, cancelable: true,
        touches: type === 'touchend' ? [] : [new Touch({ identifier: 1, target: m, clientX: 190, clientY: y })],
        changedTouches: [new Touch({ identifier: 1, target: m, clientX: 190, clientY: y })] }));
      t('touchstart', 200); t('touchmove', 230); t('touchmove', 300); t('touchend', 300);
    });
    await page.waitForTimeout(700);
    check('pull down from the top refreshes the queue', fresh >= 1);
    const before = fresh;
    await page.evaluate(() => {
      const m = document.getElementById('main'); m.scrollTop = 0;
      const t = (type, y) => m.dispatchEvent(new TouchEvent(type, { bubbles: true, cancelable: true,
        touches: type === 'touchend' ? [] : [new Touch({ identifier: 1, target: m, clientX: 190, clientY: y })],
        changedTouches: [new Touch({ identifier: 1, target: m, clientX: 190, clientY: y })] }));
      t('touchstart', 200); t('touchmove', 220); t('touchend', 220);
    });
    await page.waitForTimeout(500);
    check('a short pull does not refresh', fresh === before);
    page.off('request', onReq);
  }

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

  // ---- tick-several questions: tapping only ticks on the phone, Submit shows exactly what will be pressed
  {
    const fs_ = new URL('./fake-session.sh', import.meta.url).pathname;
    execFileSync('bash', [fs_, 'multi'], { env: ENV, encoding: 'utf8' });
    await page.waitForFunction(() => window.shepr.S.q && window.shepr.S.q.agents.some((a) => a.wlabel === 'multi'), null, { timeout: 15000 }).catch(async () => {
      await page.click('#refresh'); await page.waitForTimeout(4000);
    });
    const key = await page.evaluate(() => { const a = window.shepr.S.q.agents.find((x) => x.wlabel === 'multi'); return a && (a.host + '|' + a.pane); });
    check('the tick-several fixture session is visible, named by its workspace', !!key);
    if (key) {
      await tap(page, '.tab[data-view=waiting]'); await page.waitForTimeout(400);
      await tap(page, `.item[data-key="${key}"]`);
      await page.waitForSelector('#detail:not([hidden])'); await page.waitForSelector('#optrow .tog', { timeout: 8000 });
      const labels = await page.$$eval('#optrow button', (n) => n.map((x) => x.textContent.trim()));
      console.log('   multi buttons:', JSON.stringify(labels));
      check('multi: four tick buttons and a Submit button, no "Type something"', labels.length === 5 && /^Submit/.test(labels[4]));
      check('multi: the option already ticked on screen starts ticked', (await page.$$eval('#optrow .tog.on', (n) => n.map((x) => x.textContent.trim()))).join() === '\u2713 2');
      await page.click('#optrow .tog:nth-child(1)'); await page.click('#optrow .tog:nth-child(3)');
      check('multi: tapping ticks on the phone and sends nothing', (await page.$$eval('#optrow .tog.on', (n) => n.length)) === 3 && (await page.locator('#sheet:not([hidden])').count()) === 0);
      await page.screenshot({ path: `${OUT}/m1-multi.png` });
      await page.click('#optrow .tog-go');
      await page.waitForSelector('#sheet:not([hidden]) .kv');
      const kv = await page.textContent('#sheet .kv');
      console.log('   multi plan:', kv.replace(/\s+/g, ' ').trim());
      check('multi: the sheet lists what gets ticked and pressed', /Ticks/.test(kv) && /1\. Alpha/.test(kv) && /3\. Charlie/.test(kv) && /Submit/.test(kv) && /1 3 \u2193 \u2193 \u2193 \u2193 \u2193 \u23ce/.test(kv));
      await page.screenshot({ path: `${OUT}/m2-multi-confirm.png` });
      await page.click('#sheet .btns button:first-child');
      const r = await page.evaluate(async (k) => { const [host, pane] = k.split('|'); const body = JSON.stringify({ host, pane, kind: 'choose', option: 1 });
        const res = await fetch('api/send/prepare', { method: 'POST', body, headers: Object.assign({ 'Content-Type': 'application/json', 'X-Shepr': '1' }, await window.shepr.signHeaders('POST', 'api/send/prepare', body)) });
        return res.status + ' ' + (await res.text()); }, key);
      console.log('   choose on multi:', r.slice(0, 160));
      check('multi: choosing a single option on a tick-several question is refused', /multi_select|tick/i.test(String(r)));
    }
    await page.click('#dback').catch(() => {}); await page.waitForTimeout(500);
    execFileSync('bash', [fs_, 'multi-rm'], { env: ENV, encoding: 'utf8' });
  }

  // ---- the whole session in ONE scroll (the host's /api/history is stubbed: this tests the PAGE)
  {
    const mk = (n, count = 40) => Array.from({ length: count }, (_, i) => ({ ts: '2026-10-09T10:00:00Z', r: ['user', 'assistant', 'tool'][i % 3], x: `p${n} entry ${i}` }));
    // the last two entries are what the live text already shows, so the page must hide them
    const seen = [{ ts: '2026-10-09T10:01:00Z', r: 'assistant', x: 'Working on burnbar. Do you want to proceed?' }, { ts: '2026-10-09T10:01:01Z', r: 'assistant', x: 'Do you want to proceed? 1. Yes 2. Yes, and do not ask again' }];
    let newest = [...mk(3, 38), ...seen];
    const calls = [];
    await page.route('**/api/history*', (route) => {
      const b = new URL(route.request().url()).searchParams.get('before'); calls.push(b);
      const n = b === null ? 3 : b === '300' ? 2 : 1;
      route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ source: 'transcript',
        entries: b === null ? newest : mk(n), before: n === 1 ? null : n === 3 ? 300 : 100, size: 999, note: null, at: Date.now() / 1000 }) });
    });
    await tap(page, '.tab[data-view=waiting]'); await page.waitForTimeout(400);
    const bk = await page.evaluate(() => { const a = window.shepr.S.q.agents.find((x) => x.status === 'blocked'); return a.host + '|' + a.pane; });
    await tap(page, `.item[data-key="${bk}"]`);
    await page.waitForSelector('#detail:not([hidden])');
    await page.waitForSelector('#hist .hent', { timeout: 8000 });
    await page.waitForTimeout(300);
    const t1 = await page.evaluate(() => { const t = document.getElementById('tail'); return { n: t.querySelectorAll('#hist .hent').length,
      nearBottom: t.scrollHeight - t.scrollTop - t.clientHeight < 40, hist: document.getElementById('hist').textContent, live: document.querySelectorAll('#live .tl').length,
      button: !!t.querySelector('.earlier, .hlive, .hbar') }; });
    check('history: no button, it is just there above the live text', !t1.button && t1.n > 0);
    check('history: the live text stays at the bottom, in view', t1.nearBottom && t1.live > 3);
    check('history: entries the live text already shows are hidden (38 of 40 shown)', t1.n === 38 && !t1.hist.includes('Working on burnbar'));
    check('history: the page itself does not scroll', await page.evaluate(() => document.documentElement.scrollHeight <= innerHeight + 1));
    await page.screenshot({ path: `${OUT}/h1-history.png` });
    await page.evaluate(() => { const t = document.getElementById('tail'); t.scrollTop = t.scrollHeight - t.clientHeight - 900; t.dispatchEvent(new Event('scroll')); });
    await page.waitForTimeout(300);
    check('history: scrolling up from the live text walks into the history, no jump', await page.evaluate(() => { const t = document.getElementById('tail'); return t.scrollTop > 0 && t.querySelectorAll('#hist .hent').length === 38; }));
    await page.evaluate(() => { const t = document.getElementById('tail'); t.scrollTop = 0; t.dispatchEvent(new Event('scroll')); });
    await page.waitForFunction(() => document.querySelectorAll('#hist .hent').length === 78, null, { timeout: 5000 });
    const t2 = await page.evaluate(() => { const t = document.getElementById('tail'); const ents = [...t.querySelectorAll('#hist .hent')];
      return { first: ents[0].textContent, joint: ents[40].textContent, top: t.scrollTop }; });
    check('history: reaching the top loads the next older page ABOVE, in order', t2.first.includes('p2 entry 0') && t2.joint.includes('p3 entry 0'));
    check('history: your place is kept when older text lands above it', t2.top > 200);
    await page.evaluate(() => { const t = document.getElementById('tail'); t.scrollTop = 0; t.dispatchEvent(new Event('scroll')); });
    await page.waitForFunction(() => document.getElementById('hmark').textContent.includes('start of this session'), null, { timeout: 5000 });
    check('history: keeps going until the very start, then says so', JSON.stringify(calls.slice(0, 3)) === JSON.stringify([null, '300', '100']) && (await page.$$eval('#hist .hent', (n) => n.length)) === 118);
    await page.screenshot({ path: `${OUT}/h2-history-start.png` });
    // the session grows while it is open: the new entries appear at the bottom of the history, once each, in order
    newest = [...mk(3, 38), ...[1, 2, 3].map((i) => ({ ts: `2026-10-09T10:0${i + 1}:00Z`, r: 'assistant', x: `fresh entry ${i}` }))];
    await page.evaluate(() => window.shepr.syncHistory());
    await page.waitForFunction(() => document.getElementById('hist').textContent.includes('fresh entry 3'), null, { timeout: 5000 });
    const t3 = await page.evaluate(() => { const e = [...document.querySelectorAll('#hist .hent')].map((n) => n.textContent); return { n: e.length, tail: e.slice(-3) }; });
    check('history: new entries are appended once, in order, with no gap', t3.n === 121 && t3.tail.every((x, i) => x.includes('fresh entry ' + (i + 1))));
    check('history: the matching rule is sound (short text never matches, long text does)', await page.evaluate(() => {
      window.shepr.S.tailText = 'Alpha beta gamma delta epsilon zeta eta theta';
      const hit = window.shepr.liveCut([{ x: 'unrelated old message here' }, { x: 'alpha, beta! gamma delta epsilon zeta' }, { x: 'ok' }]);
      const none = window.shepr.liveCut([{ x: 'yes' }, { x: 'no' }]);
      return hit === 1 && none === 2; }));
    await page.unroute('**/api/history*');
    // no stub: the fixture agents have no transcript, so the host falls back to what herdr keeps
    await page.click('#dback'); await page.waitForTimeout(500);
    await tap(page, `.item[data-key="${bk}"]`);
    await page.waitForSelector('#detail:not([hidden])');
    await page.waitForFunction(() => document.getElementById('hmark') && document.getElementById('hmark').textContent.includes('herdr keeps'), null, { timeout: 8000 });
    check('history: an agent with no transcript falls back to what herdr keeps, and says so', (await page.$$('#live .tl')).length > 3);
    await page.click('#dback').catch(() => {}); await page.waitForTimeout(500);
  }

  // ---- no pinch zoom and no sideways scrolling, in every view, with hostile (very long, unbroken) content
  {
    const LONG = 'W'.repeat(500), PATHY = 'some/long/path/'.repeat(40), URL = 'https://example.com/' + 'x'.repeat(300);
    await page.route('**/api/pane*', async (route) => {
      const res = await route.fetch(); const j = await res.json();
      j.text = [LONG, PATHY, URL, j.text].join('\n');
      route.fulfill({ response: res, json: j });
    });
    await page.route('**/api/history*', (route) => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ source: 'transcript',
      entries: [{ ts: '2026-10-09T10:00:00Z', r: 'user', x: 'H'.repeat(500) }, { ts: '2026-10-09T10:00:01Z', r: 'assistant', x: 'other/dir/'.repeat(60) + 'https://history.example/' + 'q'.repeat(300) },
                { r: 'tool', x: 'Bash(' + 'T'.repeat(400) + ')' }, { r: 'result', x: 'R'.repeat(450) }], before: null, size: 9, note: null, at: Date.now() / 1000 }) }));
    const audit = () => page.evaluate(async () => {
      const off = [], de = document.documentElement;
      if (de.scrollWidth > innerWidth + 1) off.push('document ' + de.scrollWidth + '>' + innerWidth);
      if (document.body.scrollWidth > innerWidth + 1) off.push('body ' + document.body.scrollWidth);
      const scrollers = [];
      for (const n of document.querySelectorAll('body, body *')) {
        const cs = getComputedStyle(n);
        if (cs.display === 'none' || n.closest('[hidden]')) continue;
        const name = n.id ? '#' + n.id : n.className && typeof n.className === 'string' ? '.' + n.className.split(' ')[0] : n.tagName;
        if ((cs.overflowY === 'auto' || cs.overflowY === 'scroll') && cs.overflowX !== 'hidden' && cs.overflowX !== 'clip') off.push(name + ' could scroll sideways (overflow-x ' + cs.overflowX + ')');
        if (cs.overflowY === 'auto' || cs.overflowY === 'scroll') scrollers.push(n);
        const r = n.getBoundingClientRect();
        if (r.width > 0 && (r.right > innerWidth + 1 || r.left < -1) && cs.position !== 'fixed') off.push(name + ' sticks out of the screen (' + Math.round(r.left) + '..' + Math.round(r.right) + ')');
      }
      for (const n of [de, ...scrollers]) n.scrollLeft = 80;                // try to push everything sideways
      await new Promise((r) => setTimeout(r, 150));
      for (const n of [de, ...scrollers]) if (n.scrollLeft !== 0) off.push((n.id || n.className || 'document') + ' moved sideways to ' + n.scrollLeft);
      return off;
    });
    const noSide = async (label) => { const off = await audit(); if (off.length) console.log('   sideways (' + label + '):', JSON.stringify(off.slice(0, 5))); check('no sideways scroll: ' + label, off.length === 0); };

    await tap(page, '.tab[data-view=waiting]'); await page.waitForTimeout(500);
    await noSide('queue');
    await hold(page, '.item:nth-of-type(2)', 650);
    await page.waitForSelector('#sheet:not([hidden]) .peek'); await page.waitForTimeout(400);
    await noSide('peek sheet (long pane text)');
    await page.click('#sheet .btns button:first-child'); await page.waitForTimeout(300);
    await page.click('#main .secrow .mini-btn'); await page.waitForSelector('#sheet:not([hidden]) .chk'); await page.waitForTimeout(300);
    await page.fill('#sheet textarea, #sheet input[type=text]', LONG).catch(() => {});
    await noSide('wake sheet');
    await page.click('#sheet .btns button:first-child'); await page.waitForTimeout(300);

    const bk2 = await page.evaluate(() => { const a = window.shepr.S.q.agents.find((x) => x.status === 'blocked'); return a.host + '|' + a.pane; });
    await tap(page, `.item[data-key="${bk2}"]`);
    await page.waitForSelector('#detail:not([hidden])'); await page.waitForSelector('#hist .hent', { timeout: 8000 }); await page.waitForTimeout(400);
    await noSide('session view (long pane text and long history)');
    await page.screenshot({ path: `${OUT}/z1-long-content.png` });
    await page.fill('#msg', LONG + ' ' + URL); await page.click('#send'); await page.waitForSelector('#sheet:not([hidden]) .kv'); await page.waitForTimeout(300);
    await noSide('confirm sheet (long message)');
    await page.click('#sheet .btns button:first-child'); await page.waitForTimeout(300);
    await page.fill('#msg', '');
    await page.click('#dback'); await page.waitForTimeout(400);
    await tap(page, '.tab[data-view=go]'); await page.waitForSelector('#sheet:not([hidden]) .search'); await page.fill('#sheet .search', LONG); await page.waitForTimeout(300);
    await noSide('go-to (long search)');
    await page.evaluate(() => document.getElementById('shade').click()); await page.waitForTimeout(300);
    for (const v of ['all', 'hosts', 'keys']) { await tap(page, `.tab[data-view=${v}]`); await page.waitForTimeout(500); await noSide('tab ' + v); }
    await tap(page, '.tab[data-view=waiting]'); await page.waitForTimeout(300);
    await page.unroute('**/api/pane*'); await page.unroute('**/api/history*');

    // pinch zoom: the page must refuse it
    const meta = await page.getAttribute('meta[name=viewport]', 'content');
    check('zoom: the viewport forbids scaling (user-scalable=no, minimum and maximum scale 1)', /user-scalable=no/.test(meta) && /maximum-scale=1\b/.test(meta) && /minimum-scale=1\b/.test(meta));
    const ta = await page.evaluate(() => ['body', '#main', '#tail', '#send', '.item', '.tab', '#msg', '.sheet', 'html'].map((q) => { const n = document.querySelector(q); return n ? [q, getComputedStyle(n).touchAction] : null; }).filter(Boolean));
    check('zoom: touch-action is pan-y on every kind of element (iOS ignores user-scalable)', ta.length >= 8 && ta.every(([, v]) => v === 'pan-y'));
    check('zoom: Safari gesture events (pinch) are cancelled', await page.evaluate(() => ['gesturestart', 'gesturechange', 'gestureend'].every((t) => { const e = new Event(t, { cancelable: true, bubbles: true }); document.body.dispatchEvent(e); return e.defaultPrevented; })));
    check('zoom: a two-finger move is cancelled', await page.evaluate(() => { const mkT = (id, x) => new Touch({ identifier: id, target: document.body, clientX: x, clientY: 200 });
      const e = new TouchEvent('touchmove', { cancelable: true, bubbles: true, touches: [mkT(1, 100), mkT(2, 200)], changedTouches: [mkT(1, 100)] }); document.body.dispatchEvent(e); return e.defaultPrevented; }));
    check('zoom: a one-finger move is NOT cancelled (scrolling still works)', await page.evaluate(() => { const t = new Touch({ identifier: 1, target: document.body, clientX: 100, clientY: 200 });
      const e = new TouchEvent('touchmove', { cancelable: true, bubbles: true, touches: [t], changedTouches: [t] }); document.body.dispatchEvent(e); return !e.defaultPrevented; }));
    check('zoom: ctrl+wheel (trackpad pinch) is cancelled', await page.evaluate(() => { const e = new WheelEvent('wheel', { ctrlKey: true, deltaY: -50, cancelable: true, bubbles: true }); document.body.dispatchEvent(e); return e.defaultPrevented; }));
    const cdp = await page.context().newCDPSession(page);
    await cdp.send('Input.synthesizePinchGesture', { x: 195, y: 300, scaleFactor: 2.5, relativeSpeed: 600, gestureSourceType: 'touch' }).catch(() => {});
    await page.waitForTimeout(300);
    check('zoom: a real synthesized pinch leaves the page at scale 1', (await page.evaluate(() => window.visualViewport.scale)) === 1);
  }

  // ---- wake a PROJECT: a terminal with no agent in it (needs the server started with SHEPR_CLAUDE_CMD="echo STARTED")
  {
    const fsh = new URL('./fake-session.sh', import.meta.url).pathname;
    execFileSync('bash', [fsh, 'asleep'], { env: ENV, encoding: 'utf8' });
    const hr = (...a) => execFileSync('herdr', a, { env: ENV, encoding: 'utf8', input: '' });
    const paneOf = (cwd) => JSON.parse(hr('pane', 'list')).result.panes.find((p) => p.cwd === cwd).pane_id;
    const herdrRead = (pane) => hr('pane', 'read', pane, '--lines', '30');
    await tap(page, '.tab[data-view=waiting]'); await page.waitForTimeout(300);
    await page.waitForFunction(() => (window.shepr.S.q.hosts || []).some((h) => h.asleep >= 2), null, { timeout: 15000 }).catch(async () => { await page.click('#refresh'); await page.waitForTimeout(4000); });
    await page.waitForSelector('#asleeprow .mini-btn', { timeout: 8000 });
    check('asleep: the queue has one "Asleep (N)" row with a Wake button, not a row per project', /Asleep/.test(await page.textContent('#asleeprow')) && (await page.$$('#main .item')).length < 12);
    await page.screenshot({ path: `${OUT}/a1-asleep-row.png` });
    await page.click('#asleeprow .mini-btn');
    await page.waitForSelector('#sheet:not([hidden]) .hrow', { timeout: 8000 }).catch(async (e) => { console.log('   picker sheet text:', JSON.stringify((await page.textContent('#sheet')).slice(0, 200))); throw e; });
    const rows = await page.$$eval('#sheet .hrow', (n) => n.map((x) => x.textContent));
    console.log('   asleep list:', JSON.stringify(rows.map((r) => r.slice(0, 60))));
    const iD = rows.findIndex((r) => r.includes('dormant')), iB = rows.findIndex((r) => r.includes('busy'));
    check('asleep: lists the projects with no agent, the one with a conversation before the one without', iD >= 0 && iB >= 0 && iD < iB);
    await page.screenshot({ path: `${OUT}/a2-asleep-picker.png` });
    await page.fill('#sheet .search', 'dorm'); await page.waitForTimeout(250);
    check('asleep: search narrows the list', (await page.$$('#sheet .hrow')).length === 1);
    check('asleep: every project can be woken with Claude or Codex', (await page.$$eval('#sheet .hrow button', (b) => b.map((x) => x.textContent))).join() === 'Claude,Codex');
    check('asleep: Resume last is the default', (await page.$$eval('#sheet .seg .on', (b) => b.map((x) => x.textContent))).join() === 'Resume last');
    await page.click('#sheet .hrow button:first-of-type');
    await page.waitForSelector('#sheet:not([hidden]) .kv', { timeout: 8000 });
    const kv = await page.textContent('#sheet .kv');
    console.log('   start plan:', kv.replace(/\s+/g, ' ').trim().slice(0, 200));
    check('asleep: the confirm sheet shows the exact command, the directory and what it resumes', /Claude: echo STARTED --continue/.test(kv) && /\/tmp\/shepr-dormant/.test(kv) && /Resumes/.test(kv));
    await page.screenshot({ path: `${OUT}/a3-asleep-confirm.png` });
    check('asleep: nothing has run yet', !herdrRead(paneOf('/tmp/shepr-dormant')).includes('STARTED'));
    await page.waitForTimeout(800);
    await page.click('#sheet .btns .go');
    await page.waitForFunction(() => document.querySelector('#toast, .toast') && /Starting dormant/.test(document.body.textContent), null, { timeout: 8000 });
    const paneId = paneOf('/tmp/shepr-dormant');
    let seen = '';
    for (let i = 0; i < 10 && !seen.includes('STARTED --continue'); i++) { await page.waitForTimeout(500); seen = herdrRead(paneId); }
    check('asleep: after confirming, the command ran in that terminal', seen.includes('STARTED --continue'));
    // Codex: resume the last Codex session, or start a new one, from the same picker
    await page.waitForTimeout(600);
    await page.click('#asleeprow .mini-btn'); await page.waitForSelector('#sheet:not([hidden]) .hrow'); await page.fill('#sheet .search', 'busy'); await page.waitForTimeout(250);
    check('asleep: Resume is disabled where there is nothing to resume (and Start new enables it)', (await page.$$eval('#sheet .hrow button', (b) => b.map((x) => x.disabled))).every(Boolean));
    await page.click('#sheet .seg .mini-btn:last-child'); await page.waitForTimeout(200);
    check('asleep: Start new enables both agents', (await page.$$eval('#sheet .hrow button', (b) => b.map((x) => x.disabled))).every((d) => !d));
    await page.fill('#sheet .search', 'dorm'); await page.click('#sheet .seg .mini-btn:first-child'); await page.waitForTimeout(200);
    await page.click('#sheet .hrow button:nth-of-type(2)');
    await page.waitForSelector('#sheet:not([hidden]) .kv');
    const kv2 = await page.textContent('#sheet .kv');
    check('asleep: Codex resumes the last Codex session in that directory', /Codex: echo CODEX resume --last/.test(kv2) && /Resumes/.test(kv2) && /Codex conversation/.test(kv2));
    await page.waitForTimeout(800); await page.click('#sheet .btns .go');
    let seen2 = '';
    for (let i = 0; i < 10 && !seen2.includes('CODEX resume --last'); i++) { await page.waitForTimeout(500); seen2 = herdrRead(paneId); }
    check('asleep: after confirming, the Codex command ran in that terminal', seen2.includes('CODEX resume --last'));
    // a terminal that is busy (not a shell prompt) must be refused, even though it has no agent
    const busy = await page.evaluate(async () => {
      const sign = (m, p, b) => window.shepr.signHeaders(m, p, b);
      const a = await (await fetch('api/asleep', { headers: await sign('GET', 'api/asleep', '') })).json();
      const it = a.items.find((x) => x.label === 'busy');
      const body = JSON.stringify({ host: it.host, pane: it.pane, kind: 'start', mode: 'fresh', agent: 'codex' });
      const r = await fetch('api/send/prepare', { method: 'POST', body, headers: Object.assign({ 'Content-Type': 'application/json', 'X-Shepr': '1' }, await sign('POST', 'api/send/prepare', body)) });
      return r.status + ' ' + (await r.text());
    });
    console.log('   busy terminal:', busy.slice(0, 170));
    check('asleep: a terminal running something else is refused, with the reason', /not_idle_shell/.test(busy) && /sleep/.test(busy) && !/^2/.test(busy));
    check('asleep: and so is a pane that is not asleep at all (an agent is in it)', await page.evaluate(async () => {
      const sign = (m, p, b) => window.shepr.signHeaders(m, p, b);
      const ag = window.shepr.S.q.agents[0];
      const body = JSON.stringify({ host: ag.host, pane: ag.pane, kind: 'start', mode: 'fresh' });
      const r = await fetch('api/send/prepare', { method: 'POST', body, headers: Object.assign({ 'Content-Type': 'application/json', 'X-Shepr': '1' }, await sign('POST', 'api/send/prepare', body)) });
      return !r.ok && /not_asleep|already running/.test(await r.text()); }));
    execFileSync('bash', [fsh, 'asleep-rm'], { env: ENV, encoding: 'utf8' });
  }

  // ---- Start new: a brand-new project (name on the title bar, folder under ~/Projects, ccc started). The server runs with
  // SHEPR_NEW_CMD="echo CCC" and SHEPR_PROJECTS=/tmp/shepr-projects so nothing touches the real ~/Projects.
  {
    fs.mkdirSync('/tmp/shepr-projects/exists', { recursive: true });
    const hr = (...a) => execFileSync('herdr', a, { env: ENV, encoding: 'utf8', input: '' });
    const wsOf = (label) => JSON.parse(hr('workspace', 'list')).result.workspaces.find((w) => w.label === label);
    await tap(page, '.tab[data-view=waiting]'); await page.waitForTimeout(500);
    check('new: a big "Start new" button is the first thing in the queue', await page.evaluate(() => { const b = document.getElementById('newproject');
      return !!b && b === document.getElementById('main').firstElementChild && b.getBoundingClientRect().height >= 56 && /Start new/.test(b.textContent); }));
    await page.screenshot({ path: `${OUT}/a4-start-new-button.png` });
    await page.click('#newproject'); await page.waitForSelector('#np-name');
    await page.screenshot({ path: `${OUT}/a5-start-new-empty.png` });
    check('new: Review is off until there is a name and a folder', await page.$eval('#sheet .btns .go', (b) => b.disabled));
    await page.fill('#np-name', 'Test Project X');
    check('new: the folder name is suggested from the project name', (await page.inputValue('#np-dir')) === 'test-project-x' && !(await page.$eval('#sheet .btns .go', (b) => b.disabled)));
    for (const bad of ['../evil', 'a/b', '.hidden', '-x', 'bad name', 'x.']) {
      await page.fill('#np-dir', bad);
      if (!(await page.$eval('#sheet .btns .go', (b) => b.disabled))) { check('new: folder ' + JSON.stringify(bad) + ' is refused', false); }
    }
    check('new: folders with a slash, a leading dot or dash, a space, or a trailing dot are refused', true);
    await page.fill('#np-dir', 'exists'); await page.click('#sheet .btns .go'); await page.waitForSelector('#sheet:not([hidden]) .kv');
    check('new: an existing folder is flagged, and will be reused', /already exists/.test(await page.textContent('#sheet .kv')));
    await page.click('#sheet .btns button:first-child'); await page.waitForTimeout(300);
    await page.click('#newproject'); await page.waitForSelector('#np-name');
    await page.fill('#np-name', 'Test Project X'); await page.click('#sheet .btns .go'); await page.waitForSelector('#sheet:not([hidden]) .kv');
    const kvn = await page.textContent('#sheet .kv');
    console.log('   new project plan:', kvn.replace(/\s+/g, ' ').trim().slice(0, 260));
    check('new: the confirm sheet shows the name, the folder, and the exact command', /Test Project X/.test(kvn) && /\/tmp\/shepr-projects\/test-project-x/.test(kvn) && /will be created/.test(kvn) &&
      /mkdir -p \/tmp\/shepr-projects\/test-project-x && cd \/tmp\/shepr-projects\/test-project-x && echo CCC/.test(kvn));
    await page.screenshot({ path: `${OUT}/a6-start-new-confirm.png` });
    check('new: nothing exists yet', !wsOf('Test Project X') && !fs.existsSync('/tmp/shepr-projects/test-project-x'));
    await page.waitForTimeout(800); await page.click('#sheet .btns .go');
    await page.waitForFunction(() => /Created Test Project X/.test(document.body.textContent), null, { timeout: 8000 });
    let ws = null, pane = '', out = '';
    for (let i = 0; i < 12 && !(ws && out.includes('CCC')); i++) { await page.waitForTimeout(500); ws = wsOf('Test Project X'); if (ws) { pane = ws.workspace_id + ':p1'; out = hr('pane', 'read', pane, '--lines', '30'); } }
    check('new: the herdr project exists with the name on its title bar', !!ws);
    check('new: the folder was created', fs.existsSync('/tmp/shepr-projects/test-project-x'));
    check('new: the command ran in that terminal, in the new folder', out.includes('CCC') && /shepr-projects\/test-project-x/.test(out));
    const prep = (body) => page.evaluate(async (b) => { const body = JSON.stringify(Object.assign({ host: window.shepr.S.hello.name, kind: 'new_project' }, b));
      const r = await fetch('api/send/prepare', { method: 'POST', body, headers: Object.assign({ 'Content-Type': 'application/json', 'X-Shepr': '1' }, await window.shepr.signHeaders('POST', 'api/send/prepare', body)) });
      return r.status + ' ' + (await r.text()); }, body);
    const bads = [await prep({ name: 'ok', dir: '../etc' }), await prep({ name: 'ok', dir: 'a/b' }), await prep({ name: 'ok', dir: '.x' }), await prep({ name: 'ok', dir: 'a;rm -rf' }),
                  await prep({ name: '', dir: 'fine' }), await prep({ name: 'x'.repeat(61), dir: 'fine' }), await prep({ name: 'bad\nname', dir: 'fine' }), await prep({ name: 'ok', dir: '' })];
    console.log('   refused:', JSON.stringify(bads.map((b) => b.slice(0, 18))));
    check('new: the server refuses path tricks, empty or oversized names, and newlines on its own', bads.every((b) => /^400 /.test(b) && /bad_dir|bad_name/.test(b)));
    if (ws) hr('workspace', 'close', ws.workspace_id);
    fs.rmSync('/tmp/shepr-projects', { recursive: true, force: true });
  }

  // ---- photos and files: resize on the phone, store on the host, put the path in the message box, send nothing
  {
    const TINY_PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64');
    await tap(page, '.tab[data-view=waiting]'); await page.waitForTimeout(400);
    const key = await page.evaluate(() => { const a = window.shepr.S.q.agents.find((x) => x.status === 'blocked'); return a.host + '|' + a.pane; });
    await tap(page, `.item[data-key="${key}"]`); await page.waitForSelector('#detail:not([hidden])'); await page.waitForTimeout(500);
    check('photo: the message bar has an attach button', !!(await page.$('#attachbtn')) && (await page.$eval('#attachbtn', (b) => b.getBoundingClientRect().height)) >= 44);
    await page.screenshot({ path: `${OUT}/p1-attach-button.png` });
    await page.setInputFiles('#filepick', { name: 'shot.png', mimeType: 'image/png', buffer: TINY_PNG });
    await page.waitForFunction(() => /\/uploads\/.+\.png/.test(document.getElementById('msg').value), null, { timeout: 8000 });
    const m1 = await page.inputValue('#msg');
    const p1 = m1.trim().split(/\s+/).pop();
    check('photo: the saved path lands in the message box, ready for a note', /\/uploads\/\d{4}-\d{2}-\d{2}\/[0-9a-f]{16}\.png$/.test(p1));
    check('photo: the file on the host is the PNG, private (0600)', fs.existsSync(p1) && Buffer.compare(fs.readFileSync(p1), TINY_PNG) === 0 && (fs.statSync(p1).mode & 0o777) === 0o600);
    await page.fill('#msg', '');
    await page.setInputFiles('#filepick', { name: 'notes.txt', mimeType: 'text/plain', buffer: Buffer.from('line one\nline two\n') });
    await page.waitForFunction(() => /\.txt/.test(document.getElementById('msg').value), null, { timeout: 8000 });
    const p2 = (await page.inputValue('#msg')).trim().split(/\s+/).pop();
    check('photo: a plain text file is stored as text', fs.readFileSync(p2, 'utf8') === 'line one\nline two\n');
    await page.fill('#msg', 'keep this');
    await page.setInputFiles('#filepick', { name: 'evil.exe', mimeType: 'application/octet-stream', buffer: Buffer.from('MZ\x90\x00 not allowed') });
    await page.waitForFunction(() => /not a photo|will accept/.test(document.body.textContent), null, { timeout: 8000 });
    check('photo: a program is refused with a reason, and the message box is untouched', (await page.inputValue('#msg')) === 'keep this');
    const big = await page.evaluate(async () => { const c = document.createElement('canvas'); c.width = 3200; c.height = 2400; const x = c.getContext('2d');
      for (let i = 0; i < 40; i++) { x.fillStyle = `hsl(${i * 9},80%,50%)`; x.fillRect(i * 80, (i % 7) * 340, 300, 600); }
      const blob = await new Promise((r) => c.toBlob(r, 'image/jpeg', 0.95)); const f = new File([blob], 'IMG_0001.JPG', { type: 'image/jpeg' });
      const out = await window.shepr.prepareUpload(f); const bmp = await createImageBitmap(new Blob([out.bytes]));
      return { w: bmp.width, h: bmp.height, ext: out.ext, magic: Array.from(out.bytes.slice(0, 3)), orig: blob.size, now: out.bytes.length }; });
    check('photo: a big camera photo is shrunk to 2000 px and sent as JPEG', Math.max(big.w, big.h) === 2000 && big.ext === 'jpg' && big.magic.join() === '255,216,255' && big.now < big.orig);
    // the endpoint itself, with hostile requests
    const tryUp = (opts) => page.evaluate(async (o) => {
      const path = 'api/upload?host=' + encodeURIComponent(o.host || window.shepr.S.hello.name) + '&ext=' + (o.ext || 'png');
      const bytes = o.bytes ? new Uint8Array(o.bytes) : new Uint8Array(10);
      const h = { 'Content-Type': o.ctype || 'application/octet-stream' }; if (o.xs !== false) h['X-Shepr'] = '1';
      if (o.sign !== false) Object.assign(h, await window.shepr.signHeaders('POST', path, o.signedBody || bytes));
      const r = await fetch(path, { method: 'POST', headers: h, body: bytes }); return r.status + ' ' + (await r.text()).slice(0, 120); },
      opts);
    const png = [...TINY_PNG];
    const res = { unsigned: await tryUp({ sign: false, bytes: png }), json: await tryUp({ ctype: 'application/json', bytes: png }), noHeader: await tryUp({ xs: false, bytes: png }),
                  badMagic: await tryUp({ bytes: [77, 90, 0, 0, 1, 2, 3] }), badHost: await tryUp({ host: 'nowhere', bytes: png }), tampered: await tryUp({ bytes: png, signedBody: new Uint8Array(3) }),
                  tooBig: await page.evaluate(async () => { const path = 'api/upload?host=' + window.shepr.S.hello.name + '&ext=png'; const b = new Uint8Array(9 * 1024 * 1024);
                    const r = await fetch(path, { method: 'POST', headers: Object.assign({ 'Content-Type': 'application/octet-stream', 'X-Shepr': '1' }, await window.shepr.signHeaders('POST', path, b)), body: b }); return r.status + ' ' + (await r.text()).slice(0, 90); }) };
    console.log('   upload attacks:', JSON.stringify(Object.fromEntries(Object.entries(res).map(([k, v]) => [k, v.slice(0, 22)]))));
    check('photo: an unsigned upload is refused (401)', /^401 /.test(res.unsigned));
    check('photo: a wrong content type, a missing header, a tampered body and a bad host are refused (400/401)', /^400 /.test(res.json) && /^400 /.test(res.noHeader) && /^401 /.test(res.tampered) && /^40[04] /.test(res.badHost));
    check('photo: bytes that are not an allowed type are refused with a reason', /^400 /.test(res.badMagic) && /not a photo/.test(res.badMagic));
    check('photo: a 9 MB upload is refused before it is read', /^400 /.test(res.tooBig) && /too large/.test(res.tooBig));
    await page.fill('#msg', 'what is this? ' + p1); await page.click('#send'); await page.waitForSelector('#sheet:not([hidden]) .kv');
    check('photo: Send still shows the exact text on the confirm sheet, with the path in it', (await page.textContent('#sheet .kv')).includes(p1));
    await page.click('#sheet .btns button:first-child'); await page.fill('#msg', '');
    await page.click('#dback').catch(() => {}); await page.waitForTimeout(400);
  }

  // ---- an app newer than its server: say so plainly instead of a confusing pane error
  {
    const prep = (kind) => page.evaluate(async (k) => { const body = JSON.stringify({ host: window.shepr.S.hello.name, kind: k });
      const r = await fetch('api/send/prepare', { method: 'POST', body, headers: Object.assign({ 'Content-Type': 'application/json', 'X-Shepr': '1' }, await window.shepr.signHeaders('POST', 'api/send/prepare', body)) });
      return r.status + ' ' + (await r.text()); }, kind);
    const bogus = await prep('teleport');
    console.log('   unknown action:', bogus.slice(0, 150));
    check('skew: an action the server does not know says the server is older, not "not a pane id"', /^400 /.test(bogus) && /older than the app/.test(bogus) && !/pane id/.test(bogus));
    check('skew: the queue carries the server build, equal to the app build when they match', await page.evaluate(async () => { const q = await window.shepr.S.q; return !!q.server_build && q.server_build === q.build; }));
    await page.route('**/api/queue*', async (route) => { const res = await route.fetch(); const j = await res.json(); j.server_build = 'v0'; route.fulfill({ response: res, json: j }); });
    await page.evaluate(() => { window.shepr.S.skewShown = false; });
    await page.click('#refresh'); await page.waitForTimeout(1200);
    check('skew: when the host runs an older Shepr than the app, the phone says so, once', /older|Restart Shepr on the host/.test(await page.textContent('body')));
    await page.unroute('**/api/queue*');
  }

  // ---- swipe left / right in a session to move to the next / previous open project
  {
    await tap(page, '.tab[data-view=waiting]'); await page.waitForTimeout(400);
    const first = await page.evaluate(() => { const l = [...document.querySelectorAll('#main .item')][0]; return l.dataset.key; });
    await tap(page, `.item[data-key="${first}"]`);
    await page.waitForSelector('#detail:not([hidden])'); await page.waitForTimeout(600);
    const who = () => page.textContent('#dtitle');
    const swipe = (x0, y0, x1, y1, ms = 160, from = null) => page.evaluate(({ x0, y0, x1, y1, ms, from }) => new Promise((res) => {
      const tgt = from ? document.querySelector(from) : document.elementFromPoint(x0, y0);
      const ev = (type, x, y) => tgt.dispatchEvent(new PointerEvent(type, { pointerId: 7, pointerType: 'touch', isPrimary: true, clientX: x, clientY: y, bubbles: true, cancelable: true }));
      ev('pointerdown', x0, y0); setTimeout(() => { ev('pointermove', (x0 + x1) / 2, (y0 + y1) / 2); ev('pointerup', x1, y1); res(); }, ms);
    }), { x0, y0, x1, y1, ms, from });
    const t0 = await who();
    await swipe(300, 300, 80, 305);
    await page.waitForTimeout(500);
    const t1 = await who();
    check('swipe: a left swipe in a session goes to the next open project', t1 !== t0);
    await swipe(80, 300, 300, 295); await page.waitForTimeout(500);
    check('swipe: a right swipe comes back to the previous one', (await who()) === t0);
    await swipe(300, 300, 250, 302); await page.waitForTimeout(400);
    check('swipe: a short swipe does nothing', (await who()) === t0);
    await swipe(200, 200, 150, 480); await page.waitForTimeout(400);
    check('swipe: a mostly-vertical drag does nothing (it is scrolling)', (await who()) === t0);
    await swipe(300, 300, 80, 305, 1100); await page.waitForTimeout(400);
    check('swipe: a slow drag does nothing', (await who()) === t0);
    await swipe(300, 1500, 80, 1500, 160, '#msg'); await page.waitForTimeout(400);
    check('swipe: a swipe that starts in the message box does nothing', (await who()) === t0);
    await swipe(300, 300, 80, 305); await swipe(300, 300, 80, 305); await swipe(300, 300, 80, 305);
    for (let i = 0; i < 8; i++) { await swipe(300, 300, 80, 305); await page.waitForTimeout(250); }
    check('swipe: at the last project it stops and says so', /last open project/.test(await page.textContent('body')));
    await page.click('#dback').catch(() => {}); await page.waitForTimeout(400);
  }

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
