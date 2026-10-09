/* Shepr app.js
   Template jobs (service worker, reachability) plus: the device key, QR pairing, the attention
   queue, the session view, gesture navigation, hosts, and the confirm-first send flow.

   Rules this file keeps:
     1. Text that came from a pane or a host is DATA. It only ever goes through textContent.
     2. Nothing is sent without the preview sheet. Taps, double-taps and long-presses only NAVIGATE.
     3. No timer, retry or "auto" anything ever sends. A failed send is reported, never repeated.
     4. The private key never leaves the phone: it is generated non-extractable and only signs. */
'use strict';

// ---------------------------------------------------------------------------
// 1. Service worker. Without this, a dead tailnet shows Safari's error page and
//    the user thinks YOUR app is broken.
// ---------------------------------------------------------------------------
if ('serviceWorker' in navigator) {
  window.addEventListener('load', function () {
    navigator.serviceWorker.register('sw.js').catch(function (e) {
      console.warn('[shepr] service worker not registered:', e.message);
    });
  });
}

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------
const $ = (id) => document.getElementById(id);
function el(tag, cls, text) {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (text != null) n.textContent = text;
  return n;
}
const store = {
  get(k, d) { try { const v = localStorage.getItem(k); return v == null ? d : JSON.parse(v); } catch (e) { return d; } },
  set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch (e) { /* private mode: fine */ } },
};
const REDUCED = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
const clock = (sec) => new Date(sec * 1000).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
const keyOf = (a) => a.host + '|' + a.pane;
// What a session is CALLED everywhere: its project (the directory it runs in), never herdr's session title,
// which is a summary of the last conversation and changes under you. Two sessions in one project on one
// host get their pane id added so they can be told apart.
function label(a) {
  const same = (S.q ? S.q.agents : []).filter((x) => x.host === a.host && x.project === a.project);
  return same.length > 1 ? a.project + ' · ' + a.pane : a.project;
}
const enc = new TextEncoder();
const b64u = (buf) => btoa(String.fromCharCode.apply(null, new Uint8Array(buf))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const hex = (buf) => Array.prototype.map.call(new Uint8Array(buf), (x) => x.toString(16).padStart(2, '0')).join('');

function fmtAge(s, exact) {
  const lead = exact === false ? '≥' : '';
  if (s < 60) return { main: 'now', sub: '' };   // no ≥ here: under a minute is not worth hedging
  const m = Math.floor(s / 60);
  if (m < 60) return { main: lead + m + 'm', sub: '' };
  const h = Math.floor(m / 60);
  if (h < 24) return { main: lead + h + 'h', sub: String(m % 60).padStart(2, '0') + 'm' };
  return { main: lead + Math.floor(h / 24) + 'd', sub: (h % 24) + 'h' };
}
const ageClass = (s) => (s >= 3600 ? 'hot' : s >= 600 ? 'warm' : '');
const STATE_LABEL = { blocked: 'BLOCKED', working: 'WORKING', idle: 'IDLE', done: 'DONE', unknown: 'UNKNOWN' };

const S = {
  q: null,            // last /api/queue
  hello: null,        // /api/hello
  dev: null,          // {id, key, jwk, name}: this phone's identity
  skew: 0,            // server clock minus phone clock, ms
  tab: store.get('shepr.tab', 'waiting'),
  host: store.get('shepr.host', null),   // host filter
  hosts: null,        // /api/hosts
  cur: null,          // {host, pane} of the open session
  prevKey: null,      // the session you were on before this one (hold the title to flip back)
  ctx: 'waiting',     // which list the open session came from; prev/next walk it
  idx: 0,
  keybuf: [],
  tailText: null,
  sheetOpen: false,
  menu: null,
  agent: null,
  shown: new Set(),   // rows already animated in, so a poll does not replay the entrance
};
if (S.tab === 'go') S.tab = 'waiting';

// ---------------------------------------------------------------------------
// 2. The device key. ECDSA P-256, generated non-extractable: the phone can sign with it and
//    nothing, not even this script, can read it back out. Kept in IndexedDB (a CryptoKey cannot
//    go in localStorage). The host holds only the public half, like an authorized_keys entry.
// ---------------------------------------------------------------------------
function idb() {
  return new Promise((res, rej) => {
    const r = indexedDB.open('shepr', 1);
    r.onupgradeneeded = () => r.result.createObjectStore('kv');
    r.onsuccess = () => res(r.result);
    r.onerror = () => rej(r.error);
  });
}
async function kv(mode, k, v) {
  const db = await idb();
  return new Promise((res, rej) => {
    const st = db.transaction('kv', mode === 'get' ? 'readonly' : 'readwrite').objectStore('kv');
    const q = mode === 'get' ? st.get(k) : mode === 'set' ? st.put(v, k) : st.delete(k);
    q.onsuccess = () => res(q.result);
    q.onerror = () => rej(q.error);
  });
}
const loadDevice = () => kv('get', 'device');
const saveDevice = (d) => kv('set', 'device', d);
const forgetDevice = () => kv('del', 'device');

async function newKey() {
  const kp = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, false, ['sign']);
  const j = await crypto.subtle.exportKey('jwk', kp.publicKey);
  return { key: kp.privateKey, jwk: { kty: j.kty, crv: j.crv, x: j.x, y: j.y } };
}

// Every request to the host is signed over: time, a fresh nonce, the method, the exact path and
// a hash of the body. Replaying it, or changing any part of it, fails on the host.
async function signHeaders(method, path, body) {
  const u = new URL(path, location.href);
  const ts = String(Math.round(Date.now() + S.skew));
  const nonce = b64u(crypto.getRandomValues(new Uint8Array(12)));
  const bh = hex(await crypto.subtle.digest('SHA-256', enc.encode(body || '')));
  const msg = [ts, nonce, method, u.pathname + u.search, bh].join('\n');
  const sig = await crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, S.dev.key, enc.encode(msg));
  return { 'X-Shepr-Device': S.dev.id, 'X-Shepr-Ts': ts, 'X-Shepr-Nonce': nonce, 'X-Shepr-Sig': b64u(sig) };
}

const AUTH_CODES = ['unpaired', 'unknown_device', 'bad_signature'];
async function api(path, opts) {
  opts = opts || {};
  const method = (opts.method || 'GET').toUpperCase();
  const body = opts.body || '';
  const headers = Object.assign({}, opts.headers);
  if (!opts.public) {
    if (!S.dev) { const e = new Error('This phone is not paired yet.'); e.code = 'unpaired'; e.status = 401; throw e; }
    Object.assign(headers, await signHeaders(method, path, body));
  }
  const r = await fetch(path, { method, headers, body: body || undefined, cache: 'no-store' });
  const j = await r.json().catch(() => ({ error: 'bad_response', message: 'HTTP ' + r.status }));
  if (!r.ok || j.error) {
    const e = new Error(j.message || ('HTTP ' + r.status));
    e.code = j.error; e.status = r.status;
    // The phone clock drifted: learn the host's time and try a READ once more. Never a write.
    if (e.code === 'stale' && method === 'GET' && !opts.retried) {
      await syncClock();
      return api(path, Object.assign({}, opts, { retried: true }));
    }
    if (!opts.public && AUTH_CODES.indexOf(e.code) >= 0) showPair(e.code === 'unknown_device'
      ? 'This phone is not authorised on the host any more. Pair it again.' : null);
    throw e;
  }
  return j;
}
function post(path, body, extra) {
  return api(path, Object.assign({ method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Shepr': '1' },
                                   body: JSON.stringify(body) }, extra));
}
async function syncClock() {
  const t0 = Date.now();
  const h = await api('api/hello', { public: true });
  S.hello = h; S.skew = h.t * 1000 - (t0 + Date.now()) / 2;
}

// ---------------------------------------------------------------------------
// 3. Reachability. navigator.onLine only tells you the RADIO is up, so we ask the host.
// ---------------------------------------------------------------------------
const netDot = $('net'), banner = $('offline');
let online = true;
function ping() {
  return fetch('ping?t=' + Date.now(), { cache: 'no-store' }).then((r) => r.ok).catch(() => false);
}
function setOnline(up) {
  online = up;
  netDot.classList.toggle('off', !up);
  paintBanner();
}
function paintBanner() {
  const q = S.q;
  const stale = q && q.age_s != null && q.age_s > 3 * (q.poll_s || 15);
  banner.hidden = online && !stale;
  if (banner.hidden) return;
  banner.textContent = '';
  const at = el('b', null, q ? clock(q.now) : '--:--');
  if (online) banner.append('herdr has not answered for ' + Math.round(q.age_s / 60) + ' min. Showing what I knew at ', at, '.');
  else banner.append("Can't reach ", el('b', null, location.hostname || 'home'), '. Showing what I knew at ', at, '.');
}
function checkNet() { ping().then(setOnline); }
setInterval(checkNet, 20000);
window.addEventListener('online', checkNet);
window.addEventListener('offline', () => setOnline(false));
const standalone = window.matchMedia('(display-mode: standalone)').matches || window.navigator.standalone === true;

// ---------------------------------------------------------------------------
// 4. Gestures. Tap, double-tap and long-press are how you MOVE; none of them ever writes.
//    h = { tap, dbl, long, instant }. With `dbl` and not `instant`, tap waits DBL_MS to see
//    whether a second one follows (so a double-tap does not also fire the single-tap action).
// ---------------------------------------------------------------------------
const LONG_MS = 450, DBL_MS = 260, SLOP = 10;
function gesture(node, h) {
  let x0 = 0, y0 = 0, down = false, moved = false, fired = false;
  let longT = null, pressT = null, tapT = null, lastUp = 0, lastX = 0, lastY = 0;
  const clear = () => { clearTimeout(longT); clearTimeout(pressT); node.classList.remove('pressing'); };
  node.addEventListener('pointerdown', (e) => {
    if (e.button > 0) return;
    down = true; moved = false; fired = false; x0 = e.clientX; y0 = e.clientY;
    if (h.long) {
      pressT = setTimeout(() => node.classList.add('pressing'), 140);
      longT = setTimeout(() => {
        fired = true; clear();
        node.classList.add('pressed'); setTimeout(() => node.classList.remove('pressed'), 250);
        h.long();
      }, LONG_MS);
    }
  });
  node.addEventListener('pointermove', (e) => {
    if (down && Math.hypot(e.clientX - x0, e.clientY - y0) > SLOP) { moved = true; clear(); }
  });
  node.addEventListener('pointercancel', () => { down = false; moved = true; clear(); });
  node.addEventListener('pointerup', (e) => {
    if (!down) return;
    down = false; clear();
    if (fired || moved) return;
    const now = performance.now(), near = Math.hypot(e.clientX - lastX, e.clientY - lastY) < 30;
    const second = h.dbl && now - lastUp < DBL_MS && near;
    lastX = e.clientX; lastY = e.clientY;
    if (!h.dbl) { h.tap && h.tap(e); return; }
    if (h.instant) {
      lastUp = second ? 0 : now;
      if (second) h.dbl(e); else h.tap && h.tap(e);
      return;
    }
    if (second) { clearTimeout(tapT); tapT = null; lastUp = 0; h.dbl(e); return; }
    lastUp = now;
    tapT = setTimeout(() => { tapT = null; h.tap && h.tap(e); }, DBL_MS);
  });
  // WHY: a long-press on iOS raises its own context menu; ours is the navigation gesture.
  node.addEventListener('contextmenu', (e) => e.preventDefault());
  // Keyboard and assistive tech produce click with detail 0.
  node.addEventListener('click', (e) => { if (e.detail === 0 && h.tap) h.tap(e); });
}

// ---------------------------------------------------------------------------
// 5. Queue data
// ---------------------------------------------------------------------------
let fetching = false;
function fetchQueue(fresh) {
  if (fetching || !S.dev) return Promise.resolve();
  fetching = true;
  $('mini').classList.add('busy');
  return api('api/queue' + (fresh ? '?fresh=1' : '')).then((q) => {
    S.q = q; setOnline(true); render();
  }).catch((e) => { if (!e.status) setOnline(false); })
    .finally(() => { fetching = false; setTimeout(() => $('mini').classList.remove('busy'), 400); });
}
const agents = () => (S.q ? S.q.agents : []);
const byKey = (k) => agents().find((a) => keyOf(a) === k);
const inHost = (a) => !S.host || a.host === S.host;
const waiting = () => agents().filter((a) => a.status === 'blocked' && inHost(a));
const finished = () => agents().filter((a) => a.status === 'done' && inHost(a));

// ---------------------------------------------------------------------------
// 6. Icon tab bar
// ---------------------------------------------------------------------------
const ICON = {
  waiting: '<path d="M6 9a6 6 0 0 1 12 0c0 6 2 7 2 7H4s2-1 2-7"/><path d="M10 19a2 2 0 0 0 4 0"/>',
  all: '<rect x="3.5" y="3.5" width="7" height="7" rx="2"/><rect x="13.5" y="3.5" width="7" height="7" rx="2"/><rect x="3.5" y="13.5" width="7" height="7" rx="2"/><rect x="13.5" y="13.5" width="7" height="7" rx="2"/>',
  go: '<circle cx="12" cy="12" r="9"/><path d="m15.6 8.4-2.1 5.1-5.1 2.1 2.1-5.1z"/>',
  hosts: '<rect x="3.5" y="4" width="17" height="6.5" rx="2"/><rect x="3.5" y="13.5" width="17" height="6.5" rx="2"/><path d="M7 7.25h.01M7 16.75h.01"/>',
  keys: '<circle cx="8" cy="15.5" r="4"/><path d="m10.9 12.6 8.1-8.1M16 7.5l2.5 2.5M13.4 10.1l1.6 1.6"/>',
};
const TABS = [
  { id: 'waiting', label: 'Queue' }, { id: 'all', label: 'Herd' }, { id: 'go', label: 'Go', action: true },
  { id: 'hosts', label: 'Hosts' }, { id: 'keys', label: 'Keys' },
];
function buildTabs() {
  const nav = $('tabs');
  nav.textContent = '';
  const ind = el('div', 'tab-ind'); ind.id = 'tabind'; ind.style.width = (100 / TABS.length) + '%';
  nav.append(ind);
  TABS.forEach((t) => {
    const b = el('button', 'tab' + (t.action ? ' go' : '')); b.dataset.view = t.id; b.type = 'button';
    b.setAttribute('aria-label', t.label);
    const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    svg.setAttribute('viewBox', '0 0 24 24');
    svg.innerHTML = ICON[t.id];   // constant markup defined above, never data
    b.append(svg, el('span', null, t.label));
    if (t.id === 'waiting') { const bd = el('span', 'badge'); bd.id = 'badge'; bd.hidden = true; b.append(bd); }
    gesture(b, {
      instant: true,
      tap: () => (t.action ? openGoTo('') : switchTab(t.id)),
      dbl: () => { $('main').scrollTop = 0; fetchQueue(true); if (S.tab === 'hosts' || S.tab === 'keys') loadHosts(); },
      long: () => openGoTo(''),
    });
    nav.append(b);
  });
}
function switchTab(id) {
  if (id !== S.tab) S.shown.clear();
  S.tab = id; store.set('shepr.tab', id);
  const b = document.querySelector('.tab[data-view="' + id + '"]');
  if (b) { b.classList.remove('bump'); void b.offsetWidth; b.classList.add('bump'); }
  render();
  if (id === 'hosts' || id === 'keys') loadHosts();
}
function paintTabs() {
  let i = 0;
  document.querySelectorAll('.tab').forEach((t, n) => {
    const on = t.dataset.view === S.tab;
    t.classList.toggle('on', on);
    if (on) i = n;
  });
  $('tabind').style.transform = 'translateX(' + (i * 100) + '%)';
}

// ---------------------------------------------------------------------------
// 7. Main screen
// ---------------------------------------------------------------------------
function ageBox(a) {
  const box = el('div', 'age');
  if (a.for_s != null) {
    const f = fmtAge(a.for_s, a.exact);
    box.textContent = f.main;
    const c = ageClass(a.for_s); if (c) box.classList.add(c);
    box.append(el('small', null, f.sub || (a.status === 'done' ? 'done' : 'blocked')));
  } else {
    box.append(el('span', 'sdot ' + a.status), el('small', null, a.status));
  }
  return box;
}

function itemNode(a, ctx, compact, idx) {
  const n = el('div', 'item ' + a.status + (compact ? ' compact' : ''));
  n.dataset.key = keyOf(a);
  const k = ctx + '/' + keyOf(a);
  if (!S.shown.has(k) && !REDUCED) { n.classList.add('enter'); n.style.setProperty('--i', Math.min(idx || 0, 9)); }
  S.shown.add(k);
  if (compact) {
    const d = el('div', 'age'); d.append(el('span', 'sdot ' + a.status)); d.style.flexBasis = '18px';
    n.append(d);
  } else n.append(ageBox(a));
  const m = el('div', 'meta');
  const t = el('div', 'ttl', label(a));
  if (S.q && S.q.hosts.length > 1) t.append(el('span', 'htag', a.host));
  m.append(t, el('div', 'sub', a.title));
  n.append(m, el('div', 'chev', '›'));
  gesture(n, { tap: () => openDetail(a.host, a.pane, ctx), long: () => openPeek(a, ctx) });
  return n;
}

function render() {
  const q = S.q;
  if (!q) return;
  const totalWaiting = agents().filter((a) => a.status === 'blocked').length;
  const c = $('count');
  c.hidden = false; c.textContent = totalWaiting; c.classList.toggle('none', totalWaiting === 0);
  const b = $('badge');
  if (b) {
    const was = b.textContent;
    b.hidden = totalWaiting === 0; b.textContent = totalWaiting;
    if (was !== String(totalWaiting) && totalWaiting) { b.classList.remove('pop'); void b.offsetWidth; b.classList.add('pop'); }
  }
  document.title = (totalWaiting ? '(' + totalWaiting + ') ' : '') + 'Shepr';
  paintBanner();
  paintHostbar();
  paintTabs();
  paintMain();
  if (S.cur) paintDetailChrome();
}

function paintHostbar() {
  const hb = $('hostbar'), hosts = S.q.hosts;
  hb.hidden = (hosts.length < 2 && hosts.every((h) => h.status === 'ok')) || (S.tab !== 'waiting' && S.tab !== 'all');
  hb.textContent = '';
  if (S.host && !hosts.some((h) => h.id === S.host)) { S.host = null; store.set('shepr.host', null); }
  hosts.forEach((h) => {
    const c = el('button', 'chip' + (S.host === h.id ? ' on' : '') + (h.status !== 'ok' ? ' bad' : ''));
    c.append(h.id);
    const blocked = (h.counts && h.counts.blocked) || 0;
    if (h.status !== 'ok') c.append(el('i', null, h.status === 'disabled' ? 'off' : 'down'));
    else if (blocked) c.append(el('i', null, blocked));
    const setHost = (id) => { S.host = id; store.set('shepr.host', id); S.shown.clear(); render(); };
    gesture(c, {
      instant: true,
      tap: () => setHost(S.host === h.id ? null : h.id),
      dbl: () => setHost(null),
      long: () => { S.tab = 'waiting'; store.set('shepr.tab', S.tab); setHost(h.id); },
    });
    hb.append(c);
  });
}

function section(text, n) {
  const s = el('div', 'sec', text);
  if (n != null) s.append(' ', el('b', null, '(' + n + ')'));
  return s;
}

function paintMain() {
  const m = $('main');
  const keep = m.scrollTop;
  m.textContent = '';
  if (S.tab === 'waiting') {
    const w = waiting(), d = finished();
    if (!w.length && !d.length) {
      const e = el('div', 'empty');
      const r = el('div', 'radar'); r.append(el('i'), el('i'), el('i'), el('b'));
      e.append(r, el('b', null, 'Nothing is waiting on you.'));
      const others = agents().filter(inHost);
      e.append(others.length + ' session' + (others.length === 1 ? '' : 's') + ' running, none blocked.');
      m.append(e);
    }
    if (w.length) { m.append(section('Waiting on you · longest first', w.length)); w.forEach((a, i) => m.append(itemNode(a, 'waiting', false, i))); }
    if (d.length) { m.append(section('Finished, not yet looked at', d.length)); d.forEach((a, i) => m.append(itemNode(a, 'waiting', false, i))); }
  } else if (S.tab === 'all') {
    const list = agents().filter(inHost);
    let lastHost = null, i = 0;
    if (!list.length) m.append(el('div', 'empty', 'No sessions.'));
    list.slice().sort((a, b) => a.host.localeCompare(b.host) || a.project.localeCompare(b.project)).forEach((a) => {
      if (a.host !== lastHost) { m.append(section(a.host)); lastHost = a.host; }
      m.append(itemNode(a, 'all', true, i++));
    });
  } else if (S.tab === 'hosts') {
    paintHostsView(m);
  } else {
    paintKeysView(m);
  }
  m.scrollTop = keep;
}

$('refresh').addEventListener('click', () => { fetchQueue(true); if (S.tab === 'hosts' || S.tab === 'keys') loadHosts(); });

// ---------------------------------------------------------------------------
// 8. Hosts and keys views
// ---------------------------------------------------------------------------
function loadHosts() {
  return api('api/hosts').then((h) => {
    S.hosts = h;
    if (S.tab === 'hosts' || S.tab === 'keys') paintMain();
    if (h.scan && h.scan.running) setTimeout(loadHosts, 1500);
  }).catch(() => { /* the banner already says what is wrong */ });
}

function copyText(text, what) {
  const done = () => notify('Copied ' + (what || 'it') + '.', false);
  if (navigator.clipboard && navigator.clipboard.writeText) {
    navigator.clipboard.writeText(text).then(done).catch(() => fallbackCopy(text, done));
  } else fallbackCopy(text, done);
}
function fallbackCopy(text, done) {
  const t = el('textarea'); t.value = text; t.style.cssText = 'position:fixed;opacity:0;left:-1000px';
  document.body.append(t); t.select();
  try { document.execCommand('copy'); done(); } catch (e) { notify('Could not copy: select it by hand.', true); }
  t.remove();
}

function hostRow(h) {
  const r = el('div', 'hrow');
  const m = el('div', 'meta');
  const counts = Object.keys(h.counts || {}).map((k) => h.counts[k] + ' ' + k).join(', ');
  m.append(el('div', 'ttl', h.id + (h.kind === 'local' ? ' · this machine' : '')),
           el('div', 'sub', h.status === 'ok' ? (counts || 'no sessions') : !h.enabled ? 'saved, switched off' : (h.error || h.status || '')));
  r.append(m);
  const st = h.kind === 'local' ? 'ok' : !h.enabled ? 'off' : h.status === 'ok' ? 'ok' : 'bad';
  r.append(el('span', 'pill ' + (st === 'ok' ? 'ok' : st === 'bad' ? 'bad' : ''), st === 'ok' ? 'on' : st === 'off' ? 'off' : 'down'));
  if (h.kind === 'remote' && S.hosts && S.hosts.writes) {
    r.append(btn(h.enabled ? 'Turn off' : 'Turn on', 'mini-btn' + (h.enabled ? ' warn' : ''),
      () => prepare({ kind: h.enabled ? 'host_disable' : 'host_enable', id: h.id })));
  }
  return r;
}

const PEER_STATE = {
  ready: ['ready', 'ok'], nokey: ['needs key', 'warn'], hostkey: ['first connect', 'warn'],
  noherdr: ['no herdr', ''], down: ['unreachable', 'bad'],
};
function peerRow(p) {
  const r = el('div', 'hrow');
  const m = el('div', 'meta');
  m.append(el('div', 'ttl', p.name), el('div', 'sub', p.os + ' · ' + p.ip + ' · ' + p.detail));
  const ps = PEER_STATE[p.state] || [p.state, ''];
  r.append(m, el('span', 'pill ' + ps[1], ps[0]));
  if (p.state === 'ready' && S.hosts.writes) r.append(btn('Add', 'mini-btn', () => prepare({ kind: 'host_add', name: p.name })));
  if (p.state === 'nokey' && S.hosts.enroll) {
    r.append(btn('Copy key', 'mini-btn warn', () => copyText(S.hosts.enroll, 'the one-line command. Paste it on ' + p.name)));
  }
  if (p.state === 'hostkey') r.append(btn('Copy', 'mini-btn warn', () => copyText('ssh ' + p.name, 'ssh ' + p.name)));
  return r;
}

function paintHostsView(m) {
  const H = S.hosts;
  if (!H) { m.append(el('div', 'empty', 'Loading hosts…')); return; }
  m.append(section('Hosts herdr can reach', H.saved.length));
  H.saved.forEach((h) => m.append(hostRow(h)));

  m.append(section('Find hosts on your tailnet'));
  const c = el('div', 'card hscan');
  const r = el('div', 'radar sm' + (H.scan.running ? ' scan' : '')); r.append(el('i'), el('i'), el('i'), el('b'));
  const side = el('div', 'side');
  side.append(el('p', 'dim', H.scan.running ? "Looking\u2026 trying ssh with this host's key, never prompting."
    : H.scan.at ? 'Scanned ' + clock(H.scan.at) + ': ' + H.scan.peers.length + ' of your machine' + (H.scan.peers.length === 1 ? '' : 's') + ' online, not yet added.'
    : 'Only machines that belong to you are tried. Shared-in nodes are never touched.'));
  const sb = btn(H.scan.running ? 'Scanning\u2026' : 'Scan tailnet', 'bigbtn', startScan);
  sb.disabled = H.scan.running || !H.writes;
  side.append(sb);
  c.append(r, side);
  m.append(c);
  H.scan.peers.forEach((p) => m.append(peerRow(p)));
  if (H.scan.peers.some((p) => p.state === 'nokey')) {
    const k = el('div', 'card');
    k.append(el('h2', null, 'Why "needs key"'));
    k.append(el('p', null, H.hub + " cannot ssh there yet. Copy the one-line command and run it once on that machine; it adds " + H.hub + "'s public key to authorized_keys. Then Scan again."));
    m.append(k);
  }
}

function startScan() {
  post('api/hosts/scan', {}).then(() => { loadHosts(); setTimeout(loadHosts, 600); })
    .catch((e) => notify(e.message, true));
}

function paintKeysView(m) {
  const H = S.hosts, q = S.q;
  const me = el('div', 'card');
  me.append(el('h2', null, 'This phone'));
  me.append(el('p', null, (S.dev ? S.dev.name : '?') + ' is paired with ' + ((q && q.host) || (S.hello && S.hello.name) || 'the host') + '.'));
  const mine = H && H.devices.find((d) => d.you);
  if (mine) me.append(el('div', 'code selectable', mine.fp));
  me.append(el('p', 'dim', 'The private key stays in this app, cannot be exported, and signs every request.'
    + (standalone ? '' : ' Add Shepr to the Home Screen so iOS keeps it.')));
  m.append(me);

  if (H) {
    m.append(section('Phones the host trusts', H.devices.length));
    const box = el('div', 'devbox');
    H.devices.forEach((d) => {
      const r = el('div', 'hrow'); const mm = el('div', 'meta');
      mm.append(el('div', 'ttl', d.name + (d.you ? ' (this phone)' : '')),
                el('div', 'sub', d.fp.slice(0, 20) + '\u2026 \u00b7 seen ' + (d.last_seen ? clock(d.last_seen) : 'never')));
      r.append(mm);
      if (H.writes) r.append(btn('Revoke', 'mini-btn bad', () => prepare({ kind: 'device_revoke', id: d.id })));
      box.append(r);
    });
    m.append(box);
  }

  const add = el('div', 'card');
  add.append(el('h2', null, 'Pair another phone'));
  const cmd = el('div', 'code selectable', 'shepr pair');
  add.append(el('p', 'dim', 'Run this on the host, then tap Scan on the new phone:'), cmd);
  m.append(add);

  const row = el('div', 'btns');
  row.append(btn('How to move around', '', openHelp), btn('Forget this phone\u2026', 'bad', forgetThisPhone));
  m.append(row);
  m.append(el('p', 'dim fine', (q && q.writes ? 'Sends always preview first; Shepr never approves anything by itself.' : 'Read-only host.')
    + ' Blocked time is watched every ' + ((q && q.poll_s) || 15) + 's; \u2265 means it was already blocked when watching began.'));
}

function openHelp() {
  const box = el('div');
  box.append(el('h3', null, 'Moving around'), el('div', 'sub', 'Tap, double-tap and hold. None of them ever sends anything.'));
  const kv = el('div', 'kv');
  [['Queue row', 'tap opens \u00b7 hold peeks at the last lines'],
   ['Session title', 'tap = Go To \u00b7 double-tap = next waiting \u00b7 hold = previous session'],
   ['\u25c0  \u25b6', 'tap steps \u00b7 hold jumps to first or last'],
   ['Tab', 'tap switches \u00b7 double-tap refreshes \u00b7 hold = Go To'],
   ['Host chip', 'tap filters \u00b7 double-tap clears \u00b7 hold = only that host']]
    .forEach((r) => { kv.append(el('div', 'k', r[0]), el('div', 'v', r[1])); });
  box.append(kv);
  const row = el('div', 'btns'); row.append(btn('Got it', 'go', closeSheet)); box.append(row);
  openSheet(box);
}

function forgetThisPhone() {
  const box = el('div');
  box.append(el('h3', null, 'Forget this phone?'),
             el('div', 'sub', 'Deletes the key from this app. The host keeps trusting it until you revoke it there.'));
  const row = el('div', 'btns');
  row.append(btn('Cancel', '', closeSheet), btn('Forget', 'go appr', () => {
    forgetDevice().finally(() => { S.dev = null; S.q = null; closeSheet(); showPair('This phone forgot its key. Pair again to continue.'); });
  }));
  box.append(row); openSheet(box);
}

// ---------------------------------------------------------------------------
// 9. Sheet (one at a time): confirm / peek / go to
// ---------------------------------------------------------------------------
let sheetTimer = null;
function openSheet(node) {
  const sh = $('sheet');
  sh.textContent = ''; sh.append(node);
  $('shade').hidden = false; sh.hidden = false; S.sheetOpen = true;
}
function closeSheet() {
  clearTimeout(sheetTimer);
  $('shade').hidden = true; $('sheet').hidden = true; $('sheet').textContent = ''; S.sheetOpen = false;
}
$('shade').addEventListener('click', closeSheet);

function btn(text, cls, fn) {
  const b = el('button', cls, text); b.type = 'button'; b.addEventListener('click', fn); return b;
}

// ---- peek (hold a row): the last lines without leaving the list
function openPeek(a, ctx) {
  const box = el('div');
  box.append(el('h3', null, label(a)), el('div', 'sub', [a.title, a.host, STATE_LABEL[a.status] || a.status].filter(Boolean).join(' · ')));
  const pre = el('pre', 'peek selectable', 'reading…');
  box.append(pre);
  const row = el('div', 'btns');
  row.append(btn('Close', '', closeSheet),
             btn('Project', '', () => { closeSheet(); openGoTo(a.project); }),
             btn('Open', 'go', () => { closeSheet(); openDetail(a.host, a.pane, ctx); }));
  box.append(row);
  openSheet(box);
  api('api/pane?host=' + encodeURIComponent(a.host) + '&pane=' + encodeURIComponent(a.pane) + '&lines=14')
    .then((r) => { pre.textContent = tidy(r.text); pre.scrollTop = pre.scrollHeight; })
    .catch((e) => { pre.textContent = 'Could not read: ' + e.message; });
}

// ---- Go To: every session on every host, searchable
function openGoTo(prefill) {
  const box = el('div');
  box.style.cssText = 'display:flex;flex-direction:column;min-height:0';
  const inp = el('input', 'search'); inp.type = 'search'; inp.placeholder = 'Go to project, session or host';
  inp.value = prefill || ''; inp.autocomplete = 'off'; inp.autocapitalize = 'off'; inp.spellcheck = false;
  const list = el('div', 'golist');
  box.append(inp, list);
  const row = el('div', 'btns'); row.style.marginTop = '8px';
  row.append(btn('Close', '', closeSheet));
  box.append(row);
  const recent = store.get('shepr.recent', []);
  const ri = (a) => { const i = recent.indexOf(keyOf(a)); return i < 0 ? 99 : i; };
  const draw = () => {
    list.textContent = '';
    const toks = inp.value.toLowerCase().split(/\s+/).filter(Boolean);
    const rank = (a) => (a.status === 'blocked' ? 0 : a.status === 'done' ? 1 : (recent.indexOf(keyOf(a)) >= 0 ? 2 : 3));
    const hits = agents().filter((a) => {
      const hay = [a.host, a.project, a.title, a.workspace, a.agent, a.status, a.cwd].join(' ').toLowerCase();
      return toks.every((t) => hay.indexOf(t) >= 0);
    }).sort((a, b) => rank(a) - rank(b) || ri(a) - ri(b));
    if (!hits.length) list.append(el('div', 'empty', 'Nothing matches.'));
    hits.slice(0, 60).forEach((a) => {
      const n = itemNode(a, 'all', false, 0).cloneNode(true);   // clone drops the list gestures
      n.classList.remove('enter');
      gesture(n, { tap: () => { closeSheet(); openDetail(a.host, a.pane, 'all'); } });
      list.append(n);
    });
  };
  inp.addEventListener('input', draw);
  draw();
  openSheet(box);
}

// ---- confirm a send (or a host change)
const HOST_KINDS = ['host_enable', 'host_disable', 'host_add', 'device_revoke'];
function showPlan(plan) {
  const t = plan.target;
  const isHost = HOST_KINDS.indexOf(plan.kind) >= 0;
  const box = el('div');
  box.append(el('h3', null, plan.approves ? 'This approves it. Send?' : isHost ? 'Make this change?' : 'Send this?'),
             el('div', 'sub', [t.host, t.title, t.pane].filter(Boolean).join(' · ') + (t.status ? ' · ' + (STATE_LABEL[t.status] || t.status) : '')));
  if (plan.approves) box.append(el('div', 'warnbox', 'The option you picked reads like an approval. Check it is what you mean.'));
  const kv = el('div', 'kv selectable');
  plan.lines.forEach((l) => { kv.append(el('div', 'k', l.k), el('div', 'v', l.v)); });
  box.append(kv);
  const go = btn(isHost ? 'Do it' : 'Send', 'go' + (plan.approves ? ' appr' : ''), () => commit(plan, go));
  // WHY: the sheet appears under the thumb that just tapped Send in the dock. A short dead time
  // stops a double-tap or a late touch from confirming something nobody has read yet.
  go.disabled = true;
  sheetTimer = setTimeout(() => { go.disabled = false; }, 700);
  const row = el('div', 'btns');
  row.append(btn('Cancel', '', closeSheet), go);
  box.append(row);
  openSheet(box);
}

function commit(plan, goBtn) {
  goBtn.disabled = true; goBtn.textContent = 'Working…';
  post('api/send/commit', { nonce: plan.nonce }).then(() => {
    closeSheet();
    if (HOST_KINDS.indexOf(plan.kind) >= 0) {
      notify('Done.', false); loadHosts(); fetchQueue(true);
      return;
    }
    S.keybuf = []; paintStage();
    $('msg').value = ''; autosize();
    notify('Sent to ' + (plan.target.title || plan.target.pane), false);
    setTimeout(loadTail, 1400);
    fetchQueue(true);
  }).catch((e) => {
    closeSheet();
    notify(e.message, true);   // includes "may still have landed" for transport failures
    if (S.cur) loadTail();
  });
}

function prepare(body) {
  const isHost = HOST_KINDS.indexOf(body.kind) >= 0;
  if (!isHost && !S.cur) return;
  const b = isHost ? body : Object.assign({ host: S.cur.host, pane: S.cur.pane }, body);
  post('api/send/prepare', b).then((p) => { p.kind = p.kind || body.kind; showPlan(p); })
    .catch((e) => notify(e.message, true));
}

// ---------------------------------------------------------------------------
// 10. Session view
// ---------------------------------------------------------------------------
function navList() {
  if (S.ctx === 'waiting') return agents().filter((a) => a.status === 'blocked' || a.status === 'done').filter(inHost);
  return agents().filter(inHost);
}
function position() {
  const l = navList(), i = l.findIndex((a) => S.cur && keyOf(a) === S.cur.host + '|' + S.cur.pane);
  if (i >= 0) S.idx = i;
  return { l, i };
}

function openDetail(host, pane, ctx) {
  const k = host + '|' + pane;
  if (S.cur && (S.cur.host + '|' + S.cur.pane) !== k) S.prevKey = S.cur.host + '|' + S.cur.pane;
  S.cur = { host, pane }; S.ctx = ctx || S.ctx;
  S.tailText = null; S.menu = null; S.agent = null; S.keybuf = [];
  const rec = store.get('shepr.recent', []).filter((x) => x !== k);
  rec.unshift(k); store.set('shepr.recent', rec.slice(0, 12));
  try { history.replaceState(null, '', '#' + encodeURIComponent(host) + '/' + encodeURIComponent(pane)); } catch (e) { /* ignore */ }
  const d = $('detail');
  if (d.hidden) { d.hidden = false; } else { d.style.animation = 'none'; void d.offsetWidth; d.style.animation = ''; }
  $('tail').textContent = 'reading…';
  $('toast').hidden = true;
  paintStage(); paintDetailChrome();
  loadTail(true);
}

function closeDetail() {
  $('detail').hidden = true; S.cur = null;
  try { history.replaceState(null, '', location.pathname + location.search); } catch (e) { /* ignore */ }
  fetchQueue(true);
}

function paintDetailChrome() {
  if (!S.cur) return;
  const a = byKey(S.cur.host + '|' + S.cur.pane) || S.agent;
  const { l, i } = position();
  if (a) {
    $('dtitle').textContent = label(a);
    $('dsub').textContent = a.title;
    const st = $('dstate');
    let txt = STATE_LABEL[a.status] || a.status;
    if (a.for_s != null) txt += ' ' + fmtAge(a.for_s, a.exact).main + (fmtAge(a.for_s, a.exact).sub || '');
    st.textContent = txt; st.className = 'state ' + a.status;
  } else {
    $('dstate').textContent = 'GONE'; $('dstate').className = 'state';
  }
  $('dpos').textContent = i >= 0 ? (i + 1) + '/' + l.length : '–/' + l.length;
  $('dprev').disabled = !(l.length && (i > 0 || (i < 0 && S.idx > 0)));
  $('dnext').disabled = !(l.length && (i >= 0 ? i < l.length - 1 : S.idx < l.length));
}

function stepTo(delta, edge) {
  const { l, i } = position();
  if (!l.length) return;
  let j;
  if (edge === 'first') j = 0;
  else if (edge === 'last') j = l.length - 1;
  else j = (i >= 0 ? i : (delta > 0 ? S.idx - 1 : S.idx)) + delta;
  j = Math.max(0, Math.min(l.length - 1, j));
  if (l[j] && keyOf(l[j]) !== S.cur.host + '|' + S.cur.pane) openDetail(l[j].host, l[j].pane);
}

function nextWaiting() {
  if (!S.cur) { const w = agents().filter((a) => a.status === 'blocked'); if (w[0]) openDetail(w[0].host, w[0].pane, 'waiting'); return; }
  const cur = S.cur.host + '|' + S.cur.pane;
  const w = agents().filter((a) => a.status === 'blocked' && keyOf(a) !== cur);
  if (!w.length) { notify('Nothing else is waiting on you.', false); return; }
  openDetail(w[0].host, w[0].pane, 'waiting');
}

function flipPrevious() {
  const p = S.prevKey && byKey(S.prevKey);
  if (!p) { notify('No previous session yet.', false); return; }
  openDetail(p.host, p.pane);
}

gesture($('dprev'), { tap: () => stepTo(-1), long: () => stepTo(0, 'first') });
gesture($('dnext'), { tap: () => stepTo(1), long: () => stepTo(0, 'last') });
gesture($('dhead'), { tap: () => openGoTo(''), dbl: nextWaiting, long: flipPrevious });
$('dback').addEventListener('click', closeDetail);
$('drefresh').addEventListener('click', () => loadTail(true));

// Collapse long runs of box-drawing so a wrapped rule is one short line on a phone.
const RULE = /^[\s─-╿\-_=|]{8,}$/;
function tidy(text) {
  return text.split('\n').map((l) => (RULE.test(l) ? '────────────' : l)).join('\n');
}

function renderTail(text) {
  const t = $('tail');
  const near = t.scrollHeight - t.scrollTop - t.clientHeight < 60;
  const frag = document.createDocumentFragment();
  tidy(text).split('\n').forEach((line, i, arr) => {
    const s = /^\s*❯/.test(line) ? el('span', 'sel', line) : document.createTextNode(line);
    frag.append(s);
    if (i < arr.length - 1) frag.append('\n');
  });
  t.textContent = '';
  t.append(frag);
  return near;
}

let tailBusy = false;
function loadTail(force) {
  if (!S.cur || tailBusy) return;
  const at = S.cur;
  tailBusy = true;
  api('api/pane?host=' + encodeURIComponent(at.host) + '&pane=' + encodeURIComponent(at.pane) + '&lines=40')
    .then((r) => {
      if (!S.cur || S.cur.host !== at.host || S.cur.pane !== at.pane) return;
      S.agent = r.agent; S.menu = r.menu;
      const changed = r.text !== S.tailText;
      if (changed || force) {
        const first = S.tailText === null;
        const stick = renderTail(r.text);
        S.tailText = r.text;
        if (first || force || stick) $('tail').scrollTop = $('tail').scrollHeight;
      }
      $('dtime').textContent = [at.host, at.pane, clock(r.at)].join(' · ');
      paintDock(); paintDetailChrome();
    })
    .catch((e) => {
      if (S.cur && S.cur.pane === at.pane) {
        $('tail').textContent = e.code === 'bad_host' ? 'That host is not reachable.' : 'Could not read this session: ' + e.message;
        S.agent = null; paintDock();
      }
    })
    .finally(() => { tailBusy = false; });
}
setInterval(() => { if (S.cur && !S.sheetOpen && !document.hidden) loadTail(); }, 6000);

// ---- dock: options, keys, compose
const KEYS = [['↑', 'up'], ['↓', 'down'], ['⏎', 'enter'], ['Esc', 'esc'], ['Tab', 'tab'], ['␣', 'space']];
const KEYNAME = {}; KEYS.forEach((k) => { KEYNAME[k[1]] = k[0]; });

function paintDock() {
  const st = S.agent ? S.agent.status : null;
  const opt = $('optrow'), key = $('keyrow');
  opt.textContent = ''; key.textContent = '';
  const m = S.menu;
  opt.hidden = !(st === 'blocked' && m && m.options.length);
  if (!opt.hidden) {
    m.options.forEach((o) => {
      const b = btn(String(o.n), (o.n === m.current ? 'cur ' : '') + (o.approves ? 'appr' : ''), () => prepare({ kind: 'choose', option: o.n }));
      b.setAttribute('aria-label', 'Pick option ' + o.n + ': ' + o.label);
      opt.append(b);
    });
  }
  key.hidden = !(st === 'blocked' || st === 'working');
  if (!key.hidden) {
    (st === 'working' ? [KEYS[3]] : KEYS).forEach((k) => key.append(btn(k[0], '', () => stageKey(k[1]))));
  }
  const ph = st === 'blocked' ? 'Type an answer, sent with ⏎'
           : st === 'working' ? 'Working: a prompt waits its turn'
           : 'Send a prompt' + (S.agent ? ' to ' + S.agent.agent : '');
  $('msg').placeholder = ph;
  $('send').disabled = !S.agent;
}

function stageKey(k) {
  if (S.keybuf.length >= 8) return;
  S.keybuf.push(k); paintStage();
}
function paintStage() {
  const st = $('stage');
  st.textContent = ''; st.hidden = S.keybuf.length === 0;
  if (st.hidden) return;
  const lab = el('div', 'dim', 'Keys: ' + S.keybuf.map((k) => KEYNAME[k] || k).join(' '));
  lab.style.cssText = 'flex:1 1 auto;align-self:center;font-weight:700;color:#fff';
  const clear = btn('Clear', '', () => { S.keybuf = []; paintStage(); });
  const send = btn('Send keys', '', () => prepare({ kind: 'keys', keys: S.keybuf.slice() }));
  clear.style.flex = '0 0 auto';
  send.style.cssText = 'flex:0 0 auto;padding:0 14px;color:#04141a;background:var(--accent);border-color:var(--accent)';
  st.append(lab, clear, send);
}

function autosize() {
  const t = $('msg'); t.style.height = 'auto'; t.style.height = Math.min(t.scrollHeight, 92) + 'px';
}
$('msg').addEventListener('input', autosize);
$('compose').addEventListener('submit', (e) => {
  e.preventDefault();
  const text = $('msg').value.trim();
  if (text) prepare({ kind: 'text', text });
});

// ---- toasts: inside the session view, or floating above the tab bar elsewhere
let toastT = null;
function notify(msg, isErr) {
  const inDetail = !$('detail').hidden;
  let t = inDetail ? $('toast') : $('gtoast');
  if (!t) { t = el('div', 'toast gtoast'); t.id = 'gtoast'; $('app').append(t); }
  t.textContent = ''; t.className = 'toast' + (inDetail ? '' : ' gtoast') + (isErr ? ' err' : ''); t.hidden = false;
  t.append(el('span', 'grow', msg));
  if (inDetail && !isErr && S.cur) {
    const nxt = agents().filter((a) => a.status === 'blocked' && keyOf(a) !== S.cur.host + '|' + S.cur.pane);
    if (nxt.length) t.append(btn('Next waiting (' + nxt.length + ')', '', nextWaiting));
  }
  clearTimeout(toastT);
  if (!isErr) toastT = setTimeout(() => { t.hidden = true; }, 7000);
  else t.append(btn('✕', '', () => { t.hidden = true; }));
}

// ---------------------------------------------------------------------------
// 11. Pairing: scan the QR the host shows, or type the code
// ---------------------------------------------------------------------------
const pairState = { stream: null, raf: 0, scanning: false };
function pairErr(msg) { const e = $('perr'); e.hidden = !msg; e.textContent = msg || ''; }
function defaultName() {
  const ua = navigator.userAgent || '';
  return store.get('shepr.name', /iPad/.test(ua) ? 'iPad' : /iPhone/.test(ua) ? 'iPhone' : 'Browser');
}
function showPair(reason, code) {
  $('pair').hidden = false;
  stopScanner();
  const host = (S.hello && S.hello.name) || location.hostname;
  $('ptitle').textContent = 'Pair with ' + host;
  pairErr(reason);
  $('pbtns').hidden = false; $('pform').hidden = true; $('pdone').hidden = true;
  if (code) showForm(code);
}
function showForm(code) {
  $('pbtns').hidden = true; $('pform').hidden = false;
  $('pcodein').value = code || '';
  $('pname').value = defaultName();
  setTimeout(() => (code ? $('pname') : $('pcodein')).focus(), 50);
}
$('pcmd').addEventListener('click', () => {
  const c = $('pcmd'); copyText('shepr pair', 'shepr pair');
  c.classList.add('copied'); setTimeout(() => c.classList.remove('copied'), 1200);
});
$('pcode').addEventListener('click', () => showForm(''));
$('pscan').addEventListener('click', startScanner);
$('pstop').addEventListener('click', () => { stopScanner(); $('pbtns').hidden = false; });
$('pcodein').addEventListener('input', (e) => {
  const raw = e.target.value.toUpperCase().replace(/[^0-9A-Z]/g, '').slice(0, 12);
  e.target.value = raw.replace(/(.{4})(?=.)/g, '$1-');
});

function parsePair(t) {
  t = String(t).trim();
  try {
    const u = new URL(t);
    const m = /shepr-pair=([A-Za-z0-9-]+)/.exec(u.hash || '');
    if (!m) return { err: 'That QR is not a Shepr pairing code.' };
    if (u.origin !== location.origin) return { err: 'That QR is for ' + u.host + ' but this app is served from ' + location.host + '.' };
    return { code: m[1] };
  } catch (e) { /* not a URL: maybe a bare code */ }
  const c = t.replace(/[^0-9A-Za-z]/g, '').toUpperCase();
  return c.length === 12 ? { code: c.replace(/(.{4})(?=.)/g, '$1-') } : { err: 'That does not look like a pairing code.' };
}

function loadScript(src) {
  return new Promise((res, rej) => {
    if (window.jsQR) return res();
    const s = document.createElement('script'); s.src = src; s.onload = res; s.onerror = () => rej(new Error('scanner failed to load'));
    document.head.append(s);
  });
}

async function startScanner() {
  pairErr(null);
  $('pbtns').hidden = true; $('pscanner').hidden = false; $('pscanner').classList.remove('hit');
  $('pscanmsg').textContent = 'Starting the camera…';
  try {
    pairState.stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: { ideal: 'environment' } }, audio: false });
  } catch (e) {
    stopScanner();
    pairErr('The camera is not available (' + (e.name || 'error') + '). Allow it in Settings, or type the code.');
    showForm('');
    return;
  }
  const v = $('pvideo');
  v.srcObject = pairState.stream;
  try { await v.play(); } catch (e) { /* autoplay quirks: the stream still decodes */ }
  const det = 'BarcodeDetector' in window ? new BarcodeDetector({ formats: ['qr_code'] }) : null;
  if (!det) {
    try { await loadScript('vendor/jsQR.js'); } catch (e) { stopScanner(); pairErr(e.message); showForm(''); return; }
  }
  $('pscanmsg').textContent = 'Point at the QR on your host';
  const cv = document.createElement('canvas'), cx = cv.getContext('2d', { willReadFrequently: true });
  pairState.scanning = true;
  const tick = async () => {
    if (!pairState.scanning) return;
    if (v.readyState >= 2 && v.videoWidth) {
      const w = Math.min(640, v.videoWidth), h = Math.round(w * v.videoHeight / v.videoWidth);
      cv.width = w; cv.height = h; cx.drawImage(v, 0, 0, w, h);
      let text = null;
      try {
        if (det) { const r = await det.detect(cv); text = r[0] && r[0].rawValue; }
        else { const r = window.jsQR(cx.getImageData(0, 0, w, h).data, w, h, { inversionAttempts: 'dontInvert' }); text = r && r.data; }
      } catch (e) { /* a bad frame: try the next */ }
      if (text) {
        const p = parsePair(text);
        if (p.err) { $('pscanmsg').textContent = p.err; }
        else {
          pairState.scanning = false;
          $('pscanner').classList.add('hit'); $('pscanmsg').textContent = 'Got it';
          setTimeout(() => { stopScanner(); showForm(p.code); }, 450);
          return;
        }
      }
    }
    pairState.raf = setTimeout(tick, 110);
  };
  tick();
}
function stopScanner() {
  pairState.scanning = false; clearTimeout(pairState.raf);
  if (pairState.stream) { pairState.stream.getTracks().forEach((t) => t.stop()); pairState.stream = null; }
  $('pvideo').srcObject = null; $('pscanner').hidden = true;
}
document.addEventListener('visibilitychange', () => { if (document.hidden && pairState.scanning) { stopScanner(); $('pbtns').hidden = false; } });

$('pform').addEventListener('submit', async (e) => {
  e.preventDefault();
  pairErr(null);
  const code = $('pcodein').value, name = $('pname').value.trim() || 'iPhone';
  if (code.replace(/-/g, '').length !== 12) { pairErr('The code is 12 characters: XXXX-XXXX-XXXX.'); return; }
  $('pgo').disabled = true; $('pgo').textContent = 'Pairing…';
  try {
    if (!(window.crypto && crypto.subtle)) throw new Error('This browser has no secure crypto: open the HTTPS address, not http.');
    const k = await newKey();
    const res = await api('api/pair', { method: 'POST', public: true, headers: { 'Content-Type': 'application/json', 'X-Shepr': '1' },
                                        body: JSON.stringify({ code, jwk: k.jwk, name }) });
    S.dev = { id: res.device, key: k.key, jwk: k.jwk, name, host: res.host };
    await saveDevice(S.dev);
    store.set('shepr.name', name);
    try { if (navigator.storage && navigator.storage.persist) navigator.storage.persist(); } catch (x) { /* optional */ }
    $('pdonemsg').textContent = 'Paired with ' + res.host;
    $('pdone').hidden = false;
    setTimeout(() => { $('pair').hidden = true; $('pdone').hidden = true; fetchQueue(true); switchTab('waiting'); }, REDUCED ? 300 : 1700);
  } catch (err) {
    pairErr(err.message);
  } finally {
    $('pgo').disabled = false; $('pgo').textContent = 'Pair';
  }
});

// ---------------------------------------------------------------------------
// 12. Keyboard: the on-screen keyboard shrinks the VISUAL viewport on iOS but not the layout
//     viewport, so the dock would sit underneath it. Follow visualViewport instead.
// ---------------------------------------------------------------------------
if (window.visualViewport) {
  const vv = window.visualViewport;
  const fit = () => {
    document.documentElement.style.setProperty('--vvh', vv.height + 'px');
    document.documentElement.style.setProperty('--vvt', vv.offsetTop + 'px');
    window.scrollTo(0, 0);   // WHY: iOS pans the locked page to reveal a focused field; pan it back.
  };
  vv.addEventListener('resize', fit); vv.addEventListener('scroll', fit); fit();
}

// ---------------------------------------------------------------------------
// 13. Splash and boot
// ---------------------------------------------------------------------------
const splash = $('splash');
const t0 = performance.now();
const lastSplash = store.get('shepr.splash', 0);
const quick = REDUCED || Date.now() - lastSplash < 20 * 60 * 1000;   // seen it recently: keep it short
if (quick) splash.classList.add('quick');
store.set('shepr.splash', Date.now());
let splashGone = false;
function hideSplash(force) {
  if (splashGone) return;
  const min = force ? 0 : quick ? 650 : 2500;
  const wait = Math.max(0, min - (performance.now() - t0));
  splashGone = true;
  setTimeout(() => { splash.classList.add('out'); setTimeout(() => splash.remove(), 650); }, wait);
}
splash.addEventListener('pointerdown', () => { splashGone = false; hideSplash(true); });

document.addEventListener('visibilitychange', () => { if (!document.hidden && S.dev) { checkNet(); fetchQueue(true); loadTail(); } });
setInterval(() => { if (!document.hidden && !S.sheetOpen && S.dev && $('pair').hidden) fetchQueue(false); }, 10000);

async function boot() {
  buildTabs();
  try { await syncClock(); } catch (e) { setOnline(false); }
  try { S.dev = await loadDevice(); } catch (e) { S.dev = null; }
  const hash = decodeURIComponent(location.hash.slice(1));
  const pm = /^shepr-pair=([A-Za-z0-9-]+)$/.exec(hash);
  if (pm) {
    try { history.replaceState(null, '', location.pathname + location.search); } catch (e) { /* ignore */ }
    showPair(null, pm[1]);
  } else if (!S.dev) {
    showPair(S.hello ? null : 'Cannot reach the host. Is Tailscale on?');
  } else {
    await fetchQueue(true);
    // A link like #gus/w4E:p1 opens that session directly.
    const m = hash.match(/^([^/]+)\/(w[0-9A-Za-z]+:p[0-9A-Za-z]+)$/);
    if (m) openDetail(m[1], m[2], 'all');
  }
  hideSplash(false);
}
boot();
window.shepr = { S, ping, standalone, signHeaders };
