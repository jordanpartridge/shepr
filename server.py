#!/usr/bin/env python3
"""Shepr server.

Static files, /ping, and a small /api that fronts the `herdr` CLI so a phone can see which agent
sessions are waiting on a human, read the tail of one, and answer it. Standard library only.

    python3 server.py [port] [--bind ADDR]

Listens on 127.0.0.1 by default. `nixweb serve|install` puts `tailscale serve` in front of it,
which adds HTTPS and exposes it to the tailnet and nowhere else.

The rules this file exists to keep:

  * Reads are free. Writes confirm. A send is TWO requests: /api/send/prepare returns exactly what
    will happen plus a one-use nonce, /api/send/commit executes it. Nothing here sends on its own.
  * Never auto-approve. There is no endpoint, flag or timer that answers a dialog without a person
    having seen the plan for THAT dialog. The plan is bound to the agent's state_change_seq, so if
    the agent moved on between the preview and the tap, the commit is refused.
  * Everything read from a pane is DATA. It is returned as text and never interpreted here.
  * A failed write may still have landed. Errors say so and nothing is ever retried automatically.
"""
import argparse
import base64
import concurrent.futures
import functools
import glob
import hashlib
import hmac
import io
import json
import os
import re
import secrets
import socket
import subprocess
import sys
import threading
import time
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import parse_qs, unquote, urlsplit

HERE = os.path.dirname(os.path.realpath(__file__))   # realpath: `shepr` is a symlink to this file
HERDR = os.environ.get("HERDR_BIN", "herdr")
LOCAL = os.environ.get("SHEPR_LABEL") or socket.gethostname().split(".")[0]
READONLY = os.environ.get("SHEPR_READONLY") == "1"
POLL_S = float(os.environ.get("SHEPR_POLL", "15"))
STATE_DIR = os.environ.get("SHEPR_STATE") or os.path.expanduser("~/.local/state/shepr")
CLAUDE_HOME = os.environ.get("CLAUDE_HOME") or os.path.expanduser("~/.claude")
NONCE_TTL_S = 90
TAIL_MAX_BYTES = 48 * 1024

PANE_RE = re.compile(r"^w[0-9A-Za-z]+:p[0-9A-Za-z]+$")
ANSI_RE = re.compile(r"\x1b\[[0-9;?]*[ -/]*[@-~]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|\x1b[@-_]")
CTRL_RE = re.compile(r"[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]")
OPT_RE = re.compile(r"^\s*(❯|>)?\s*(\d{1,2})\.\s+(\S.*?)\s*$")
APPROVE_RE = re.compile(r"^(yes|allow|approve|accept|proceed|always|trust|continue)\b", re.I)

# What a phone may press. Letters and digits cover y/n and numbered menus; no ctrl-chords, because
# ctrl+c twice quits Claude Code and that is not something to do from a thumb.
KEY_NAMED = {"up", "down", "left", "right", "enter", "esc", "tab", "shift+tab", "space", "backspace"}
KEY_CHAR = re.compile(r"^[0-9A-Za-z]$")

LOCK = threading.RLock()
SNAP = {"ts": 0.0, "hosts": [], "agents": [], "polls": 0}
PLANS = {}
OWNER = {"login": None, "dns": None, "names": {"localhost", "127.0.0.1", "[::1]"}}


class HerdrError(Exception):
    def __init__(self, code, message):
        super().__init__(message)
        self.code, self.message = code, message


# --------------------------------------------------------------------------------------------
# talking to herdr
# --------------------------------------------------------------------------------------------
def run_herdr(machine, args, timeout=10, want_json=True):
    """Run one herdr command. machine=None is this host; otherwise a saved machine label.
    --machine goes in front of the subcommand, never combined with --session (herdr --skill)."""
    cmd = [HERDR] + (["--machine", machine] if machine else []) + list(args)
    try:
        p = subprocess.run(cmd, stdin=subprocess.DEVNULL, capture_output=True, text=True, timeout=timeout)
    except subprocess.TimeoutExpired:
        raise HerdrError("timeout", f"herdr took longer than {timeout}s")
    except FileNotFoundError:
        raise HerdrError("no_herdr", f"{HERDR} not found")
    out = p.stdout or ""
    if p.returncode != 0:
        msg = (p.stderr or out).strip()
        try:
            e = json.loads(msg)["error"]
            raise HerdrError(e.get("code", "error"), e.get("message", msg))
        except (ValueError, KeyError, TypeError):
            raise HerdrError("error", msg.splitlines()[-1] if msg else f"exit {p.returncode}")
    if not want_json:
        return out
    try:
        return json.loads(out)
    except ValueError:
        raise HerdrError("bad_json", "herdr returned something that is not JSON")


def discover_hosts():
    hosts = [{"id": LOCAL, "machine": None, "kind": "local", "enabled": True}]
    try:
        for m in run_herdr(None, ["machine", "list", "--json"], timeout=6):
            label = m.get("label") or m.get("id")
            if label and label != LOCAL:
                hosts.append({"id": label, "machine": label, "kind": "remote", "enabled": bool(m.get("enabled"))})
    except HerdrError:
        pass
    return hosts


def clean_text(s):
    return CTRL_RE.sub("", ANSI_RE.sub("", s)).replace("\r", "")


def read_tail(host, pane, lines):
    out = run_herdr(host["machine"], ["agent", "read", pane, "--source", "recent-unwrapped",
                                      "--lines", str(lines)], timeout=10, want_json=False)
    text = clean_text(out).rstrip()
    ls = text.split("\n")[-lines:]
    text = "\n".join(l[:600] for l in ls)
    return text[-TAIL_MAX_BYTES:]


def get_agent(host, pane):
    r = run_herdr(host["machine"], ["agent", "get", pane], timeout=8)
    return r["result"]["agent"]


# --------------------------------------------------------------------------------------------
# "blocked since" -- herdr exposes a change counter but no clock, so we keep our own.
# --------------------------------------------------------------------------------------------
def state_path(name):
    return os.path.join(STATE_DIR, name)


def load_state():
    try:
        with open(state_path("seen.json")) as f:
            d = json.load(f)
        d.setdefault("hosts", {}); d.setdefault("seen", {})
        return d
    except (OSError, ValueError):
        return {"hosts": {}, "seen": {}}


def save_state(d):
    os.makedirs(STATE_DIR, mode=0o700, exist_ok=True)
    tmp = state_path("seen.json.tmp")
    with open(tmp, "w") as f:
        json.dump(d, f)
    os.chmod(tmp, 0o600)
    os.replace(tmp, state_path("seen.json"))


STATE = load_state()


def transcript_mtime(agent):
    """Local Claude only: the session transcript stops being written the moment the agent blocks,
    so its mtime is a good estimate of WHEN it blocked for a session that was already blocked
    before we started watching. Returns None if it cannot be found."""
    sess = agent.get("agent_session") or {}
    sid = sess.get("value")
    if sess.get("agent") != "claude" or sess.get("kind") != "id" or not sid or "/" in sid:
        return None
    for cwd in (agent.get("cwd"), agent.get("foreground_cwd")):
        if cwd:
            p = os.path.join(CLAUDE_HOME, "projects", re.sub(r"[^A-Za-z0-9]", "-", cwd), sid + ".jsonl")
            if os.path.exists(p):
                return os.path.getmtime(p)
    hits = glob.glob(os.path.join(CLAUDE_HOME, "projects", "*", sid + ".jsonl"))
    return os.path.getmtime(hits[0]) if hits else None


def note_seen(host, agents, now):
    """Record the first time each blocked/done agent was seen in its current state."""
    hid = host["id"]
    hs = STATE["hosts"].setdefault(hid, {"watching_since": now, "last_ok": None})
    prev_ok = hs.get("last_ok")
    exact_ok = prev_ok is not None and now - prev_ok <= 3 * POLL_S
    live, changed = set(), False
    for a in agents:
        if a["agent_status"] not in ("blocked", "done"):
            continue
        key = f"{hid}|{a['pane_id']}|{a.get('state_change_seq')}|{a['agent_status']}"
        live.add(key)
        if key in STATE["seen"]:
            continue
        t, basis = now, "observed" if exact_ok else "first-look"
        if not exact_ok and host["kind"] == "local":
            mt = transcript_mtime(a)
            if mt and mt < now:
                t, basis = mt, "transcript"
        STATE["seen"][key] = {"t": t, "exact": exact_ok, "basis": basis}
        changed = True
    for key in [k for k in STATE["seen"] if k.startswith(hid + "|") and k not in live]:
        del STATE["seen"][key]; changed = True
    hs["last_ok"] = now
    if changed or prev_ok is None or now - prev_ok > 60:
        try:
            save_state(STATE)
        except OSError as e:
            print(f"shepr: cannot persist state: {e}", file=sys.stderr)


def poll_host(host):
    now = time.time()
    try:
        agents = run_herdr(host["machine"], ["agent", "list"], timeout=9)["result"]["agents"]
    except HerdrError as e:
        return host, None, {}, f"{e.code}: {e.message}"
    try:
        ws = {w["workspace_id"]: w.get("label") for w in
              run_herdr(host["machine"], ["workspace", "list"], timeout=9)["result"]["workspaces"]}
    except (HerdrError, KeyError, TypeError):
        ws = {}
    with LOCK:
        note_seen(host, agents, now)
    return host, agents, ws, None


def poll_all():
    hosts = discover_hosts()
    live = [h for h in hosts if h["enabled"]]
    results = {}
    if live:
        with concurrent.futures.ThreadPoolExecutor(max_workers=len(live)) as ex:
            for host, agents, ws, err in ex.map(poll_host, live):
                results[host["id"]] = (agents, ws, err)
    out_hosts, out_agents = [], []
    for h in hosts:
        entry = {"id": h["id"], "kind": h["kind"], "status": "ok", "error": None, "counts": {}}
        if not h["enabled"]:
            entry.update(status="disabled", error=f"saved machine is disabled (herdr machine enable {h['id']})")
        else:
            agents, ws, err = results[h["id"]]
            if err:
                entry.update(status="down", error=err)
            else:
                for a in agents:
                    s = a["agent_status"]
                    entry["counts"][s] = entry["counts"].get(s, 0) + 1
                    out_agents.append(shape_agent(h, a, ws))
        with LOCK:
            entry["last_ok"] = (STATE["hosts"].get(h["id"]) or {}).get("last_ok")
        out_hosts.append(entry)
    with LOCK:
        SNAP.update(ts=time.time(), hosts=out_hosts, agents=out_agents, polls=SNAP["polls"] + 1)


def shape_agent(host, a, ws):
    cwd = a.get("cwd") or a.get("foreground_cwd") or ""
    sess = (a.get("agent_session") or {}).get("value") or ""
    return {
        "host": host["id"], "pane": a["pane_id"], "agent": a.get("agent") or "?",
        "status": a["agent_status"], "seq": a.get("state_change_seq"),
        "title": a.get("terminal_title_stripped") or a.get("terminal_title") or a["pane_id"],
        "cwd": cwd, "project": os.path.basename(cwd.rstrip("/")) or cwd or "?",
        "workspace": ws.get(a.get("workspace_id")) or a.get("workspace_id"),
        "session": sess[:8], "focused": bool(a.get("focused")),
    }


def poller():
    while True:
        try:
            poll_all()
        except Exception as e:  # never let the loop die; the age field tells the phone it is stale
            print(f"shepr: poll failed: {e!r}", file=sys.stderr)
        time.sleep(POLL_S)


def build_queue():
    now = time.time()
    with LOCK:
        agents = [dict(a) for a in SNAP["agents"]]
        hosts = [dict(h) for h in SNAP["hosts"]]
        ts, polls = SNAP["ts"], SNAP["polls"]
        for a in agents:
            if a["status"] in ("blocked", "done"):
                s = STATE["seen"].get(f"{a['host']}|{a['pane']}|{a['seq']}|{a['status']}")
                if s:
                    a.update(since=s["t"], exact=s["exact"], basis=s["basis"], for_s=max(0, int(now - s["t"])))
    order = {"blocked": 0, "done": 1, "working": 2, "idle": 3}
    # Longest blocked first. Cross-host order needs wall-clock; within a host the seq breaks ties.
    agents.sort(key=lambda a: (order.get(a["status"], 4), a.get("since", 0), a.get("seq") or 0,
                               a["host"], a["project"]))
    return {"now": now, "age_s": int(now - ts) if ts else None, "polls": polls, "hosts": hosts,
            "agents": agents, "writes": not READONLY, "viewer": None, "poll_s": POLL_S}


# --------------------------------------------------------------------------------------------
# reading a dialog, and planning a send
# --------------------------------------------------------------------------------------------
def parse_menu(text):
    """Find the live numbered menu at the bottom of a pane, e.g. Claude Code's AskUserQuestion or a
    permission dialog. Returns {"current": n, "options": [{"n","label","approves"}]} or None."""
    lines = text.split("\n")
    cur = None
    for i in range(len(lines) - 1, max(-1, len(lines) - 30), -1):
        m = OPT_RE.match(lines[i])
        if m and m.group(1):
            cur = i
            break
    if cur is None:
        return None
    hits = [(i, int(m.group(2)), m.group(3), bool(m.group(1)))
            for i, l in enumerate(lines) if i >= max(0, cur - 20) and (m := OPT_RE.match(l))]
    starts = [k for k, h in enumerate(hits) if h[1] == 1 and h[0] <= cur]
    if not starts:
        return None
    run = [hits[starts[-1]]]
    for h in hits[starts[-1] + 1:]:
        if h[1] == run[-1][1] + 1:
            run.append(h)
    current = next((h[1] for h in run if h[0] == cur), None)
    if current is None:
        return None
    return {"current": current,
            "options": [{"n": h[1], "label": h[2], "approves": bool(APPROVE_RE.match(h[2]))} for h in run]}


def human_keys(keys):
    sym = {"up": "↑", "down": "↓", "left": "←", "right": "→", "enter": "⏎", "esc": "Esc",
           "tab": "Tab", "shift+tab": "⇧Tab", "space": "Space", "backspace": "⌫"}
    return " ".join(sym.get(k, k) for k in keys)


def need_host(hid):
    with LOCK:
        known = {h["id"] for h in SNAP["hosts"] if h["status"] == "ok"}
    for h in discover_hosts():
        if h["id"] == hid and h["enabled"] and hid in known:
            return h
    raise HerdrError("bad_host", f"unknown or unreachable host {hid!r}")


def build_plan(body):
    if READONLY:
        raise HerdrError("read_only", "this server was started read-only (SHEPR_READONLY=1)")
    if body.get("kind") in HOST_KINDS:
        return plan_host(body)
    if body.get("kind") == "wake":
        return plan_wake(body)
    host = need_host(str(body.get("host", "")))
    pane = str(body.get("pane", ""))
    if not PANE_RE.match(pane):
        raise HerdrError("bad_pane", "not a pane id")
    kind = body.get("kind")
    a = get_agent(host, pane)
    status = a["agent_status"]
    steps, lines, approves = [], [], False

    if kind == "text":
        text = body.get("text")
        if not isinstance(text, str) or not text.strip() or len(text) > 4000 or "\x00" in text:
            raise HerdrError("bad_text", "text must be 1 to 4000 characters")
        text = text.replace("\r\n", "\n").replace("\r", "\n")
        if status == "blocked":
            if "\n" in text:
                raise HerdrError("bad_text", "a blocked agent is at a dialog: one line only, a newline would submit early")
            steps = [{"op": "text", "text": text}, {"op": "keys", "keys": ["enter"]}]
            lines = [("Types into the dialog", text), ("Then presses", "⏎")]
        else:
            steps = [{"op": "prompt", "text": text}]
            lines = [("Sends as a prompt", text)]
            if status == "working":
                lines.append(("Note", "the agent is working right now; Claude queues this until it is free"))
    elif kind == "keys":
        keys = body.get("keys")
        if not isinstance(keys, list) or not 1 <= len(keys) <= 8:
            raise HerdrError("bad_keys", "1 to 8 keys")
        for k in keys:
            if not (k in KEY_NAMED or (isinstance(k, str) and KEY_CHAR.match(k))):
                raise HerdrError("bad_keys", f"key {k!r} is not allowed from the phone")
        if status == "working" and keys != ["esc"]:
            raise HerdrError("bad_keys", "the agent is working: the only key allowed is Esc (interrupt)")
        steps = [{"op": "keys", "keys": keys}]
        lines = [("Presses", human_keys(keys))]
    elif kind == "choose":
        if status != "blocked":
            raise HerdrError("not_blocked", "choosing an option only applies to a blocked agent")
        try:
            n = int(body.get("option"))
        except (TypeError, ValueError):
            raise HerdrError("bad_option", "option must be a number")
        menu = parse_menu(read_tail(host, pane, 80))
        opt = menu and next((o for o in menu["options"] if o["n"] == n), None)
        if not opt:
            raise HerdrError("no_menu", f"no option {n} on screen right now")
        d = n - menu["current"]
        keys = (["down"] if d > 0 else ["up"]) * abs(d) + ["enter"]
        steps = [{"op": "keys", "keys": keys}]
        approves = opt["approves"]
        lines = [("Picks", f"{n}. {opt['label']}"), ("By pressing", human_keys(keys))]
    else:
        raise HerdrError("bad_kind", "kind must be text, keys or choose")

    plan = {
        "nonce": secrets.token_urlsafe(18), "host": host["id"], "pane": pane, "kind": kind, "steps": steps,
        "snap": {"status": status, "seq": a.get("state_change_seq"),
                 "session": (a.get("agent_session") or {}).get("value")},
        "expires": time.time() + NONCE_TTL_S,
    }
    if kind == "choose":
        plan["snap"]["pick"] = [n, opt["label"], menu["current"]]
    with LOCK:
        for k in [k for k, p in PLANS.items() if p["expires"] < time.time()]:
            del PLANS[k]
        PLANS[plan["nonce"]] = plan
    return {
        "nonce": plan["nonce"], "kind": kind, "expires_s": NONCE_TTL_S, "approves": approves,
        "target": {"host": host["id"], "pane": pane,
                   "title": os.path.basename((a.get("cwd") or "").rstrip("/")) or pane, "project": "", "status": status},
        "lines": [{"k": k, "v": v} for k, v in lines],
    }


def run_step(host, pane, step):
    m = host["machine"]
    if step["op"] == "keys":
        return run_herdr(m, ["pane", "send-keys", pane] + step["keys"], timeout=10, want_json=False)
    if step["op"] == "text":
        return run_herdr(m, ["pane", "send-text", pane, "--", step["text"]], timeout=10, want_json=False)
    if step["op"] == "prompt":
        # No "--" here: `agent prompt` takes the text as a hyphen-tolerant positional and treats "--" as text.
        return run_herdr(m, ["agent", "prompt", pane, step["text"]], timeout=15, want_json=False)
    raise HerdrError("bad_step", step["op"])


def commit_plan(nonce):
    with LOCK:
        plan = PLANS.pop(str(nonce), None)  # one use, even if the commit then fails
    if not plan or plan["expires"] < time.time():
        raise HerdrError("expired", "that preview expired or was already used: look again and re-send")
    if plan["kind"] in HOST_KINDS:
        return commit_host(plan)
    if plan["kind"] == "wake":
        return commit_wake(plan)
    host = need_host(plan["host"])
    a = get_agent(host, plan["pane"])
    snap = plan["snap"]
    if (a["agent_status"], a.get("state_change_seq"), (a.get("agent_session") or {}).get("value")) != \
            (snap["status"], snap["seq"], snap["session"]):
        raise HerdrError("moved_on", "the agent changed state since you looked, so nothing was sent. Read it again.")
    if plan["kind"] == "choose":
        menu = parse_menu(read_tail(host, plan["pane"], 80))
        n, label, cur = snap["pick"]
        o = menu and next((o for o in menu["options"] if o["n"] == n), None)
        if not o or o["label"] != label or menu["current"] != cur:
            raise HerdrError("moved_on", "the menu on screen is not the one you chose from, so nothing was sent.")
    done = []
    for step in plan["steps"]:
        try:
            run_step(host, plan["pane"], step)
            done.append(step["op"])
        except HerdrError as e:
            audit(plan, False, f"{e.code}: {e.message}")
            raise HerdrError(e.code, f"{e.message}. Sent before the failure: {', '.join(done) or 'nothing'}. "
                                     "A failed write may still have landed: read the pane before trying again.")
    audit(plan, True, "")
    return {"ok": True, "sent": done}


def audit(plan, ok, err):
    try:
        os.makedirs(STATE_DIR, mode=0o700, exist_ok=True)
        rec = {"t": int(time.time()), "host": plan.get("host"), "pane": plan.get("pane"), "kind": plan["kind"],
               "ok": ok, "err": err, "steps": [dict(s, text=s["text"][:200]) if "text" in s else s for s in plan.get("steps", [])]}
        with open(state_path("sends.jsonl"), "a") as f:
            f.write(json.dumps(rec) + "\n")
        print("shepr: send " + json.dumps(rec, ensure_ascii=False), file=sys.stderr, flush=True)
    except OSError:
        pass


# --------------------------------------------------------------------------------------------
# device keys. The phone holds an ECDSA P-256 key it can never export (WebCrypto, IndexedDB);
# this server holds the matching PUBLIC keys, like an authorized_keys file. Verification is plain
# Python because these hosts have no `cryptography` module and the app must stay copy-and-run.
# --------------------------------------------------------------------------------------------
_P = 0xffffffff00000001000000000000000000000000ffffffffffffffffffffffff
_N = 0xffffffff00000000ffffffffffffffffbce6faada7179e84f3b9cac2fc632551
_B = 0x5ac635d8aa3a93e7b3ebbd55769886bc651d06b0cc53b0f63bce3c3e27d2604b
_G = (0x6b17d1f2e12c4247f8bce6e563a440f277037d812deb33a0f4a13945d898c296,
      0x4fe342e2fe1a7f9b8ee7eb4a7c0f9e162bce33576b315ececbb6406837bf51f5)


def _add(p, q):
    if p is None:
        return q
    if q is None:
        return p
    (x1, y1), (x2, y2) = p, q
    if x1 == x2:
        if (y1 + y2) % _P == 0:
            return None
        lam = (3 * x1 * x1 - 3) * pow(2 * y1, -1, _P) % _P
    else:
        lam = (y2 - y1) * pow(x2 - x1, -1, _P) % _P
    x3 = (lam * lam - x1 - x2) % _P
    return x3, (lam * (x1 - x3) - y1) % _P


def _mul(k, p):
    r = None
    while k:
        if k & 1:
            r = _add(r, p)
        p = _add(p, p)
        k >>= 1
    return r


def on_curve(x, y):
    return 0 <= x < _P and 0 <= y < _P and (y * y - (x * x * x - 3 * x + _B)) % _P == 0


def ecdsa_verify(x, y, msg, sig):
    """sig is WebCrypto's raw r||s (64 bytes), not DER."""
    if len(sig) != 64 or not on_curve(x, y):
        return False
    r, s = int.from_bytes(sig[:32], "big"), int.from_bytes(sig[32:], "big")
    if not (1 <= r < _N and 1 <= s < _N):
        return False
    e = int.from_bytes(hashlib.sha256(msg).digest(), "big")
    w = pow(s, -1, _N)
    pt = _add(_mul(e * w % _N, _G), _mul(r * w % _N, (x, y)))
    return pt is not None and pt[0] % _N == r


def b64u(b):
    return base64.urlsafe_b64encode(b).rstrip(b"=").decode()


def b64u_dec(s):
    return base64.urlsafe_b64decode(s + "=" * (-len(s) % 4))


def fingerprint(x, y):
    """Shown like an OpenSSH fingerprint so it reads the same on the phone and in `shepr devices`."""
    raw = b"\x04" + x.to_bytes(32, "big") + y.to_bytes(32, "big")
    return "SHA256:" + base64.b64encode(hashlib.sha256(raw).digest()).decode().rstrip("=")


DEVICES = {}
_dev_mtime = [None]
NONCES = {}
PAIR_FAILS = []
AUTH_ERR = {"unpaired": 401, "unknown_device": 401, "bad_signature": 401, "stale": 401, "replay": 401,
            "bad_code": 403, "slow_down": 429}


def devices():
    """The authorized devices, reloaded whenever the file changes (so `shepr revoke` takes effect now)."""
    try:
        mt = os.path.getmtime(state_path("devices.json"))
    except OSError:
        mt = None
    with LOCK:
        if mt != _dev_mtime[0]:
            try:
                with open(state_path("devices.json")) as f:
                    DEVICES.clear(); DEVICES.update(json.load(f))
            except (OSError, ValueError):
                DEVICES.clear()
            _dev_mtime[0] = mt
        return DEVICES


def save_devices():
    os.makedirs(STATE_DIR, mode=0o700, exist_ok=True)
    tmp = state_path("devices.json.tmp")
    with open(tmp, "w") as f:
        json.dump(DEVICES, f, indent=1)
    os.chmod(tmp, 0o600)
    os.replace(tmp, state_path("devices.json"))
    _dev_mtime[0] = os.path.getmtime(state_path("devices.json"))


def dev_xy(d):
    return int.from_bytes(b64u_dec(d["x"]), "big"), int.from_bytes(b64u_dec(d["y"]), "big")


def dev_public(did, d):
    x, y = dev_xy(d)
    return {"id": did, "name": d["name"], "fp": fingerprint(x, y), "added": d.get("added"),
            "last_seen": d.get("last_seen")}


def verify_request(headers, method, target, body):
    """Every /api call except hello and pair carries a signature from an authorized device."""
    dev, ts, nonce, sig = (headers.get(h) for h in ("X-Shepr-Device", "X-Shepr-Ts", "X-Shepr-Nonce", "X-Shepr-Sig"))
    if not (dev and ts and nonce and sig):
        raise HerdrError("unpaired", "this device has not been paired with this host")
    d = devices().get(dev)
    if not d:
        raise HerdrError("unknown_device", "this device is not authorized here (revoked, or never paired)")
    try:
        t = int(ts) / 1000.0
        sigb = b64u_dec(sig)
    except (ValueError, TypeError):
        raise HerdrError("bad_signature", "malformed signature")
    if abs(time.time() - t) > 90:
        raise HerdrError("stale", "request is too old or the phone clock is off")
    if not 8 <= len(nonce) <= 64:
        raise HerdrError("bad_signature", "bad nonce")
    msg = f"{ts}\n{nonce}\n{method}\n{target}\n{hashlib.sha256(body).hexdigest()}".encode()
    x, y = dev_xy(d)
    if not ecdsa_verify(x, y, msg, sigb):
        raise HerdrError("bad_signature", "signature does not match this device's key")
    now = time.time()
    with LOCK:
        for k in [k for k, e in NONCES.items() if e < now]:
            del NONCES[k]
        if nonce in NONCES:
            raise HerdrError("replay", "that request was already seen")
        NONCES[nonce] = now + 300
        if now - (d.get("last_seen") or 0) > 60:
            d["last_seen"] = int(now)
            try:
                save_devices()
            except OSError:
                pass
    return dev


# ---- pairing: `shepr pair` on the host shows a QR, the app scans it, the key is registered
CODE_ALPHABET = "0123456789ABCDEFGHJKMNPQRSTVWXYZ"   # Crockford: no I L O U, so no misread codes


def norm_code(c):
    return re.sub(r"[^0-9A-Z]", "", str(c).upper().replace("O", "0").replace("I", "1").replace("L", "1"))


def pairing_path():
    return state_path("pairing.json")


def read_pairing():
    try:
        with open(pairing_path()) as f:
            return json.load(f)
    except (OSError, ValueError):
        return None


def write_pairing(d):
    os.makedirs(STATE_DIR, mode=0o700, exist_ok=True)
    tmp = pairing_path() + ".tmp"
    with open(tmp, "w") as f:
        json.dump(d, f)
    os.chmod(tmp, 0o600)
    os.replace(tmp, pairing_path())


def do_pair(body, ua):
    now = time.time()
    with LOCK:
        PAIR_FAILS[:] = [t for t in PAIR_FAILS if now - t < 60]
        if len(PAIR_FAILS) >= 5:
            raise HerdrError("slow_down", "too many wrong codes: wait a minute and run `shepr pair` again")
    pend = read_pairing()
    code = norm_code(body.get("code", ""))
    good = bool(pend) and not pend.get("used_by") and pend.get("expires", 0) > now and \
        hmac.compare_digest(pend.get("hash", ""), hashlib.sha256(code.encode()).hexdigest())
    if not good:
        with LOCK:
            PAIR_FAILS.append(now)
        raise HerdrError("bad_code", "that code is wrong, used, or expired: run `shepr pair` for a fresh QR")
    jwk = body.get("jwk") or {}
    try:
        if jwk.get("kty") != "EC" or jwk.get("crv") != "P-256":
            raise ValueError
        x, y = int.from_bytes(b64u_dec(jwk["x"]), "big"), int.from_bytes(b64u_dec(jwk["y"]), "big")
        if not on_curve(x, y):
            raise ValueError
    except (ValueError, KeyError, TypeError):
        raise HerdrError("bad_key", "that is not a P-256 public key")
    name = re.sub(r"[^\w .@'-]", "", str(body.get("name") or "iPhone"))[:40].strip() or "iPhone"
    did = hashlib.sha256(b"\x04" + x.to_bytes(32, "big") + y.to_bytes(32, "big")).hexdigest()[:16]
    with LOCK:
        devices()
        DEVICES[did] = {"name": name, "x": b64u(x.to_bytes(32, "big")), "y": b64u(y.to_bytes(32, "big")),
                        "added": int(now), "last_seen": int(now), "ua": (ua or "")[:160]}
        save_devices()
    pend["used_by"] = did
    write_pairing(pend)
    print(f"shepr: paired {name!r} {fingerprint(x, y)}", file=sys.stderr, flush=True)
    return {"device": did, "fp": fingerprint(x, y), "host": LOCAL, "t": now}


def server_info():
    try:
        with open(state_path("server.json")) as f:
            d = json.load(f)
        os.kill(d["pid"], 0)
        return d
    except (OSError, ValueError, KeyError, ProcessLookupError):
        return None


def public_url(port):
    if os.environ.get("SHEPR_URL"):
        return os.environ["SHEPR_URL"].rstrip("/")
    # The tailnet name, never the loopback aliases that are also in OWNER["names"] (a set sorts 127.0.0.1 first).
    return f"https://{OWNER['dns']}:{port}" if OWNER.get("dns") else f"http://127.0.0.1:{port}"


# --------------------------------------------------------------------------------------------
# hosts: saved herdr machines, plus a look at the rest of YOUR tailnet
# --------------------------------------------------------------------------------------------
HOST_KINDS = {"host_enable", "host_disable", "host_add", "device_revoke"}
SCAN = {"at": 0.0, "running": False, "peers": []}
LABEL_RE = re.compile(r"^[a-z][a-z0-9_-]{0,23}$")


def machine_profiles():
    try:
        return run_herdr(None, ["machine", "list", "--json"], timeout=6)
    except HerdrError:
        return []


def hub_pubkey():
    for n in ("id_ed25519.pub", "id_ecdsa.pub", "id_rsa.pub"):
        try:
            with open(os.path.expanduser("~/.ssh/" + n)) as f:
                return f.read().strip()
        except OSError:
            continue
    return None


def ssh_probe(target):
    """Can THIS host ssh to target with its key, and is herdr there? Never prompts, never trusts a
    new host key on its own (a first connect is a decision a person makes at a terminal)."""
    try:
        p = subprocess.run(["ssh", "-o", "BatchMode=yes", "-o", "ConnectTimeout=4", "-o", "StrictHostKeyChecking=yes",
                            "-o", "ControlMaster=no", "-o", "ControlPath=none", target,
                            # Plain PATH first; then the user's login shell, because macOS and most
                            # installers put herdr's directory in a login profile, not the ssh default.
                            'command -v herdr || "$SHELL" -lc "command -v herdr"'],
                           stdin=subprocess.DEVNULL, capture_output=True, text=True, timeout=14)
    except subprocess.TimeoutExpired:
        return "down", "timed out"
    # ssh prints advisory banners ("** The server may need to be upgraded", warnings) on stderr; they are
    # not the failure, so keep only the lines that are.
    err_lines = [l.strip() for l in (p.stderr or "").splitlines()
                 if l.strip() and not l.lstrip().startswith(("**", "#", "Warning:", "WARNING"))]
    err = "\n".join(err_lines)
    low = err.lower()
    found = [l.strip() for l in (p.stdout or "").splitlines() if l.strip().startswith("/")]
    if p.returncode == 0 and found:
        return "ready", found[-1]
    if p.returncode in (0, 1) and not err:
        return "noherdr", "herdr not found on PATH or in the login shell"
    if "permission denied" in low:
        return "nokey", "this host's key is not authorized there"
    if "host key verification failed" in low or "no matching host key" in low or "remote host identification" in low:
        return "hostkey", "first connect needed: run `ssh " + target + "` once and check the fingerprint"
    return "down", (err_lines or ["unreachable"])[-1][:120]


def tailnet_peers():
    d = json.loads(subprocess.run(["tailscale", "status", "--json"], stdin=subprocess.DEVNULL,
                                  capture_output=True, text=True, timeout=8).stdout)
    me = d["Self"]
    saved = {m.get("label") for m in machine_profiles()} | {m.get("target") for m in machine_profiles()}
    out = []
    for p in d.get("Peer", {}).values():
        short = p["DNSName"].split(".")[0]
        # Only nodes that belong to this tailnet user. Shared-in nodes are somebody else's machines.
        if p.get("UserID") != me["UserID"] or not p.get("Online") or p.get("OS") not in ("linux", "macOS"):
            continue
        if short in saved or short == me["DNSName"].split(".")[0]:
            continue
        out.append({"name": short, "dns": p["DNSName"].rstrip("."), "os": p["OS"],
                    "ip": (p.get("TailscaleIPs") or [""])[0], "target": short})
    return sorted(out, key=lambda x: x["name"])


def scan_tailnet():
    try:
        peers = tailnet_peers()
        with concurrent.futures.ThreadPoolExecutor(max_workers=6) as ex:
            results = list(ex.map(lambda p: ssh_probe(p["target"]), peers))
        for p, (state, detail) in zip(peers, results):
            p["state"], p["detail"] = state, detail
        with LOCK:
            SCAN.update(at=time.time(), peers=peers)
    except Exception as e:
        print(f"shepr: tailnet scan failed: {e!r}", file=sys.stderr)
    finally:
        with LOCK:
            SCAN["running"] = False


def start_scan():
    with LOCK:
        if SCAN["running"] or time.time() - SCAN["at"] < 20:
            return False
        SCAN["running"] = True
    threading.Thread(target=scan_tailnet, daemon=True).start()
    return True


def hosts_view():
    profiles = machine_profiles()
    with LOCK:
        status = {h["id"]: h for h in SNAP["hosts"]}
        scan = {"at": SCAN["at"], "running": SCAN["running"], "peers": [dict(p) for p in SCAN["peers"]]}
    saved = [{"id": LOCAL, "kind": "local", "enabled": True, "target": None,
              "status": (status.get(LOCAL) or {}).get("status"), "counts": (status.get(LOCAL) or {}).get("counts", {})}]
    for m in profiles:
        st = status.get(m.get("label")) or {}
        saved.append({"id": m.get("label"), "profile": m.get("id"), "kind": "remote", "enabled": bool(m.get("enabled")),
                      "target": m.get("target"), "status": st.get("status"), "error": st.get("error"),
                      "counts": st.get("counts", {})})
    pk = hub_pubkey()
    return {"saved": saved, "scan": scan, "hub": LOCAL, "pubkey": pk,
            "enroll": f"mkdir -p ~/.ssh && echo '{pk}' >> ~/.ssh/authorized_keys && chmod 600 ~/.ssh/authorized_keys" if pk else None}


def register_plan(plan):
    with LOCK:
        for k in [k for k, p in PLANS.items() if p["expires"] < time.time()]:
            del PLANS[k]
        PLANS[plan["nonce"]] = plan


def plan_host(body):
    kind = body["kind"]
    lines, steps, target = [], [], "Hosts"
    if kind in ("host_enable", "host_disable"):
        label = str(body.get("id", ""))
        m = next((m for m in machine_profiles() if m.get("label") == label), None)
        if not m:
            raise HerdrError("bad_host", f"no saved herdr machine called {label!r}")
        on = kind == "host_enable"
        steps = [{"op": "machine", "args": ["enable" if on else "disable", m["id"]]}]
        lines = [("Does", ("Turns ON" if on else "Turns OFF") + f" herdr access to {label}"),
                 ("Over", f"ssh {m.get('target')} (OpenSSH keeps the credentials)"),
                 ("Note", "remote herdr sessions keep running either way")]
        target = label
    elif kind == "host_add":
        name = str(body.get("name", ""))
        with LOCK:
            peer = next((dict(p) for p in SCAN["peers"] if p["name"] == name and p.get("state") == "ready"), None)
        if not peer:
            raise HerdrError("bad_host", f"{name!r} is not a host the last scan found ready: scan again")
        label = str(body.get("label") or name).lower()
        if not LABEL_RE.match(label):
            raise HerdrError("bad_label", "label: lowercase letters, digits, - and _")
        steps = [{"op": "machine", "args": ["add", peer["target"], "--label", label]}]
        lines = [("Saves", f"herdr machine {label} -> ssh {peer['target']} ({peer['ip']})"),
                 ("Note", "herdr checks the remote install and starts its server; it installs nothing without a terminal")]
        target = label
    elif kind == "device_revoke":
        did = str(body.get("id", ""))
        d = devices().get(did)
        if not d:
            raise HerdrError("bad_device", "no such device")
        steps = [{"op": "revoke", "id": did}]
        lines = [("Removes", f"{d['name']}  {dev_public(did, d)['fp']}"),
                 ("Effect", "that phone is signed out at once and must scan a new QR to come back")]
        target = d["name"]
    else:
        raise HerdrError("bad_kind", kind)
    plan = {"nonce": secrets.token_urlsafe(18), "kind": kind, "steps": steps, "expires": time.time() + NONCE_TTL_S}
    register_plan(plan)
    return {"nonce": plan["nonce"], "kind": kind, "expires_s": NONCE_TTL_S, "approves": False,
            "target": {"host": LOCAL, "pane": "", "title": target, "project": "", "status": ""},
            "lines": [{"k": k, "v": v} for k, v in lines]}


def commit_host(plan):
    step = plan["steps"][0]
    if step["op"] == "revoke":
        with LOCK:
            devices().pop(step["id"], None)
            save_devices()
        audit(plan, True, "")
        return {"ok": True, "sent": ["revoke"]}
    try:
        run_herdr(None, ["machine"] + step["args"], timeout=60, want_json=False)
    except HerdrError as e:
        audit(plan, False, f"{e.code}: {e.message}")
        raise HerdrError(e.code, f"{e.message}. A failed write may still have landed: check the Hosts tab before trying again.")
    audit(plan, True, "")
    poll_all()
    return {"ok": True, "sent": ["machine"]}


WAKE_MAX = 40
WAKE_GAP_S = 0.5


def plan_wake(body):
    """Send one message to each of several SLEEPING (idle or finished) sessions. A blocked session is a question
    waiting on a person, so it is refused here: this can never answer a dialog, let alone approve one."""
    text = body.get("text")
    if not isinstance(text, str) or not text.strip() or len(text) > 1000 or "\x00" in text or "\n" in text.strip():
        raise HerdrError("bad_text", "one line, 1 to 1000 characters")
    targets = body.get("targets")
    if not isinstance(targets, list) or not 1 <= len(targets) <= WAKE_MAX:
        raise HerdrError("bad_targets", f"pick 1 to {WAKE_MAX} sessions")
    items, seen = [], set()
    for t in targets:
        hid, pane = str(t.get("host", "")), str(t.get("pane", ""))
        if not PANE_RE.match(pane):
            raise HerdrError("bad_pane", "not a pane id")
        if (hid, pane) in seen:
            continue
        seen.add((hid, pane))
        host = need_host(hid)
        a = get_agent(host, pane)
        name = os.path.basename((a.get("cwd") or "").rstrip("/")) or pane
        if a["agent_status"] not in ("idle", "done"):
            raise HerdrError("not_sleeping", f"{name} on {hid} is {a['agent_status']}, not sleeping: only idle or "
                                             "finished sessions can be woken. Reopen the list and look again.")
        items.append({"host": hid, "pane": pane, "name": name,
                      "snap": {"status": a["agent_status"], "seq": a.get("state_change_seq"),
                               "session": (a.get("agent_session") or {}).get("value")}})
    plan = {"nonce": secrets.token_urlsafe(18), "kind": "wake", "items": items, "text": text.strip(),
            "expires": time.time() + NONCE_TTL_S}
    register_plan(plan)
    names = "\n".join(f"  {i['name']}  ({i['host']})" for i in items)
    lines = [("Wakes", f"{len(items)} sleeping session{'s' if len(items) != 1 else ''}:\n{names}"),
             ("Each gets", plan["text"]),
              ("Note", "one message each, a moment apart. Any that moved on since you looked are skipped. Nothing is approved.")]
    return {"nonce": plan["nonce"], "kind": "wake", "expires_s": NONCE_TTL_S, "approves": False,
            "target": {"host": LOCAL, "pane": "", "title": f"{len(items)} sleeping", "project": "", "status": ""},
            "lines": [{"k": k, "v": v} for k, v in lines]}


def commit_wake(plan):
    # Law 22: waking many agents starts many model turns at once. Do not do that to a machine that is already busy.
    load = os.getloadavg()[0]
    if load > (os.cpu_count() or 4):
        raise HerdrError("busy", f"this host is busy (load {load:.0f}); nothing was sent. Try again in a minute.")
    sent, skipped, failed = [], [], []
    for n, it in enumerate(plan["items"]):
        try:
            host = need_host(it["host"])
            a = get_agent(host, it["pane"])
            snap = it["snap"]
            if (a["agent_status"], a.get("state_change_seq"), (a.get("agent_session") or {}).get("value")) != \
                    (snap["status"], snap["seq"], snap["session"]):
                skipped.append(it["name"])
                continue
            run_step(host, it["pane"], {"op": "prompt", "text": plan["text"]})
            sent.append(it["name"])
            audit({"host": it["host"], "pane": it["pane"], "kind": "wake",
                   "steps": [{"op": "prompt", "text": plan["text"]}]}, True, "")
        except HerdrError as e:
            failed.append(f"{it['name']}: {e.message}")
            audit({"host": it["host"], "pane": it["pane"], "kind": "wake",
                   "steps": [{"op": "prompt", "text": plan["text"]}]}, False, f"{e.code}: {e.message}")
        if n < len(plan["items"]) - 1:
            time.sleep(WAKE_GAP_S)
    if not sent and failed:
        raise HerdrError("error", "none were woken. " + "; ".join(failed[:3]) +
                         ". A failed write may still have landed: look at the queue before trying again.")
    return {"ok": True, "woke": sent, "skipped": skipped, "failed": failed}


# --------------------------------------------------------------------------------------------
# HTTP
# --------------------------------------------------------------------------------------------
STATIC_OK = re.compile(r"^/(?:|index\.html|app\.css|app\.js|sw\.js|manifest\.webmanifest|vendor/jsQR\.js|"
                       r"icons/[A-Za-z0-9_.-]+\.(?:png|svg))$")
CSP = ("default-src 'self'; img-src 'self' data: blob:; media-src 'self' blob:; connect-src 'self'; "
       "base-uri 'none'; form-action 'none'; frame-ancestors 'none'")
PUBLIC_API = {"/api/hello", "/api/pair"}


def learn_tailnet():
    """Who owns this node and what is its name. Used to refuse other tailnet users and DNS rebinding."""
    try:
        d = json.loads(subprocess.run(["tailscale", "status", "--json"], stdin=subprocess.DEVNULL,
                                      capture_output=True, text=True, timeout=6).stdout)
        me = d["Self"]
        OWNER["dns"] = me["DNSName"].rstrip(".").lower()
        OWNER["names"].add(OWNER["dns"])
        OWNER["login"] = d["User"][str(me["UserID"])]["LoginName"].lower()
    except Exception as e:
        print(f"shepr: tailscale identity unavailable ({e!r}); tailnet requests will be refused", file=sys.stderr)
    OWNER["login"] = (os.environ.get("SHEPR_OWNER") or OWNER["login"] or "").lower() or None
    for n in filter(None, os.environ.get("SHEPR_ALLOW_HOSTS", "").lower().split(",")):
        OWNER["names"].add(n.strip())


class Handler(SimpleHTTPRequestHandler):
    server_version = "shepr"

    def log_message(self, fmt, *args):
        if args and str(args[1]) not in ("200", "304"):
            super().log_message(fmt, *args)

    def end_headers(self):
        self.send_header("X-Content-Type-Options", "nosniff")
        self.send_header("Content-Security-Policy", CSP)
        self.send_header("Referrer-Policy", "no-referrer")
        # Camera is the one device feature this app asks for (scanning the pairing QR).
        self.send_header("Permissions-Policy", "camera=(self), microphone=(), geolocation=()")
        # Static files: always revalidate (they carry Last-Modified, so this is cheap) so Safari's own cache
        # never serves an old app.js that the service worker's network-first rule would have refreshed.
        if not any(h.lower().startswith(b"cache-control") for h in getattr(self, "_headers_buffer", [])):
            self.send_header("Cache-Control", "no-cache")
        super().end_headers()

    def json_out(self, code, obj):
        body = json.dumps(obj, ensure_ascii=False).encode()
        self.send_response(code)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(body)

    def network_gate(self, post):
        """Layer 1: is this request even from the right place? Returns the tailnet login or 'local'."""
        raw = self.headers.get("Host") or ""
        host = "[::1]" if raw.startswith("[") else raw.rsplit(":", 1)[0].lower()
        if host not in OWNER["names"]:
            self.json_out(421, {"error": "bad_host", "message": "unexpected Host header"}); return None
        if self.headers.get("Tailscale-Funnel-Request"):
            self.json_out(403, {"error": "funnel", "message": "public funnel traffic is refused"}); return None
        login = (self.headers.get("Tailscale-User-Login") or "").lower()
        if login and login != OWNER["login"]:
            self.json_out(403, {"error": "not_owner", "message": "this app answers only to the node's owner"}); return None
        if post:
            origin = self.headers.get("Origin")
            if origin and urlsplit(origin).netloc.lower() != raw.lower():
                self.json_out(403, {"error": "origin", "message": "cross-origin write refused"}); return None
            if self.headers.get("X-Shepr") != "1" or \
                    not (self.headers.get("Content-Type") or "").startswith("application/json"):
                self.json_out(400, {"error": "bad_request", "message": "JSON with X-Shepr: 1 required"}); return None
        return login or "local"

    def api(self, post):
        net = self.network_gate(post)
        if net is None:
            return
        u = urlsplit(self.path)
        q = {k: v[0] for k, v in parse_qs(u.query).items()}
        try:
            raw = b""
            if post:
                n = int(self.headers.get("Content-Length") or 0)
                if not 0 < n <= 16384:
                    raise HerdrError("bad_request", "body missing or too large")
                raw = self.rfile.read(n)
            body = json.loads(raw) if post else {}
            if post and not isinstance(body, dict):
                raise HerdrError("bad_request", "body must be an object")

            if u.path == "/api/hello" and not post:
                # The one request every launch makes first: worth a journal line, it is how you see a phone arrive.
                print(f"shepr: hello from {net} build={(self.headers.get('X-Shepr-Build') or '?')[:12]} ({(self.headers.get('User-Agent') or '')[:70]})", file=sys.stderr, flush=True)
                return self.json_out(200, {"app": "shepr", "v": 1, "name": LOCAL, "t": time.time(),
                                           "paired": bool(devices()), "writes": not READONLY})
            if u.path == "/api/pair" and post:
                return self.json_out(200, do_pair(body, self.headers.get("User-Agent")))

            viewer = verify_request(self.headers, "POST" if post else "GET", self.path, raw)
            vname = devices().get(viewer, {}).get("name", viewer)

            if not post and u.path == "/api/queue":
                if q.get("fresh") == "1" and time.time() - SNAP["ts"] > 2:
                    poll_all()
                out = build_queue()
                out["viewer"], out["host"] = vname, LOCAL
                return self.json_out(200, out)
            if not post and u.path == "/api/pane":
                host = need_host(q.get("host", ""))
                pane = q.get("pane", "")
                if not PANE_RE.match(pane):
                    raise HerdrError("bad_pane", "not a pane id")
                n = max(5, min(200, int(q.get("lines", "40"))))
                a = get_agent(host, pane)
                text = read_tail(host, pane, n)
                return self.json_out(200, {"text": text, "lines": n, "menu": parse_menu(read_tail(host, pane, 80))
                                           if a["agent_status"] == "blocked" else None,
                                           "agent": shape_agent(host, a, {}), "at": time.time()})
            if not post and u.path == "/api/hosts":
                out = hosts_view()
                out["devices"] = [dict(dev_public(i, d), you=(i == viewer)) for i, d in devices().items()]
                out["writes"] = not READONLY
                return self.json_out(200, out)
            if post and u.path == "/api/hosts/scan":
                return self.json_out(200, {"started": start_scan()})
            if post and u.path == "/api/send/prepare":
                return self.json_out(200, build_plan(body))
            if post and u.path == "/api/send/commit":
                if READONLY:
                    raise HerdrError("read_only", "read-only server")
                return self.json_out(200, commit_plan(body.get("nonce")))
            return self.json_out(404, {"error": "not_found", "message": u.path})
        except HerdrError as e:
            code = AUTH_ERR.get(e.code) or {"moved_on": 409, "expired": 410, "read_only": 403, "bad_host": 404}.get(
                e.code, 502 if e.code in ("timeout", "error", "bad_json", "no_herdr", "agent_blocked", "agent_not_ready") else 400)
            return self.json_out(code, {"error": e.code, "message": e.message})
        except (ValueError, KeyError) as e:
            return self.json_out(400, {"error": "bad_request", "message": str(e)})

    def do_GET(self):
        if urlsplit(self.path).path.startswith("/api/"):
            return self.api(False)
        super().do_GET()

    def do_HEAD(self):
        super().do_HEAD()

    def do_POST(self):
        if urlsplit(self.path).path.startswith("/api/"):
            return self.api(True)
        self.send_error(405)

    def do_OPTIONS(self):
        # Never answer a CORS preflight: a cross-origin page must not be able to reach /api.
        self.send_error(405)

    def send_head(self):
        path = unquote(urlsplit(self.path).path)

        # WHY: app.js asks /ping to find out whether home is reachable. A bare static
        # server 404s it, and the app then shows "can't reach home" on its very first run.
        # no-store because a cached 200 would tell the user a dead host is alive.
        if path == "/ping":
            body = b"ok\n"
            self.send_response(200)
            self.send_header("Content-Type", "text/plain")
            self.send_header("Content-Length", str(len(body)))
            self.send_header("Cache-Control", "no-store")
            self.end_headers()
            return io.BytesIO(body)

        # WHY: the template 404s dotfiles and itself; this app is stricter and serves an allowlist,
        # because the folder also holds tests, docs and the server source, and /api can send keys.
        if not STATIC_OK.match(path):
            self.send_error(404)
            return None
        return super().send_head()


# --------------------------------------------------------------------------------------------
# command line: `shepr pair | devices | revoke`, and (default) serve
# --------------------------------------------------------------------------------------------
def cli_pair(a):
    info = server_info()
    if not info:
        sys.exit("shepr: the server is not running here. Start it first: systemctl --user start nixweb-herder.remote.iphone")
    code = "".join(secrets.choice(CODE_ALPHABET) for _ in range(12))
    shown = "-".join(code[i:i + 4] for i in range(0, 12, 4))
    ttl = max(30, min(900, a.ttl))
    write_pairing({"hash": hashlib.sha256(code.encode()).hexdigest(), "expires": time.time() + ttl,
                   "created": int(time.time()), "used_by": None})
    url = f"{info['url']}/#shepr-pair={shown}"
    if a.png:
        subprocess.run(["qrencode", "-o", a.png, "-s", "10", "-m", "4", "-l", "M", url], check=True)
    if a.json:
        print(json.dumps({"url": url, "code": shown, "expires": int(time.time() + ttl), "png": a.png}), flush=True)
    else:
        print(f"\n  \033[1;36mSHEPR\033[0m  pair a phone with \033[1m{LOCAL}\033[0m\n")
        subprocess.run(["qrencode", "-t", "ANSIUTF8", "-m", "2", "-l", "M", url], check=False)
        print(f"\n  1. Open \033[1mShepr\033[0m on the iPhone and tap \033[1mScan\033[0m")
        print(f"  2. Point it at the code above")
        print(f"  or type the code by hand: \033[1;33m{shown}\033[0m")
        print(f"\n  {url}\n  Valid for {ttl}s, works once. Ctrl-C cancels.\n", flush=True)
    if a.no_wait:
        return 0
    t_end = time.time() + ttl
    try:
        while time.time() < t_end:
            p = read_pairing()
            if p and p.get("used_by"):
                d = devices().get(p["used_by"]) or {}
                x, y = dev_xy(d) if d else (0, 0)
                print(f"  \033[1;32m✓ paired\033[0m  {d.get('name', '?')}  {fingerprint(x, y)}\n")
                os.remove(pairing_path())
                return 0
            if not a.json:
                print(f"\r  waiting… {int(t_end - time.time()):>3}s ", end="", flush=True)
            time.sleep(0.5)
    except KeyboardInterrupt:
        pass
    try:
        os.remove(pairing_path())
    except OSError:
        pass
    print("\n  pairing code expired or cancelled; nothing was paired.")
    return 1


def cli_devices(a):
    devs = devices()
    if not devs:
        print("no devices paired. Run: shepr pair")
    for did, d in devs.items():
        seen = time.strftime("%Y-%m-%d %H:%M", time.localtime(d["last_seen"])) if d.get("last_seen") else "never"
        print(f"{did}  {d['name']:<20} {dev_public(did, d)['fp']}  last seen {seen}")
    return 0


def cli_revoke(a):
    devs = devices()
    hit = [i for i, d in devs.items() if a.who in (i, d["name"]) or i.startswith(a.who)]
    if len(hit) != 1:
        sys.exit(f"shepr: {'no' if not hit else 'more than one'} device matches {a.who!r}; see: shepr devices")
    name = devs[hit[0]]["name"]
    del devs[hit[0]]
    save_devices()
    print(f"revoked {name} ({hit[0]}). That phone is signed out now.")
    return 0


def main():
    if len(sys.argv) > 1 and sys.argv[1] in ("pair", "devices", "revoke"):
        ap = argparse.ArgumentParser(prog="shepr")
        sub = ap.add_subparsers(dest="cmd", required=True)
        p = sub.add_parser("pair", help="show a QR that pairs one phone, then wait for it")
        p.add_argument("--ttl", type=int, default=180); p.add_argument("--png"); p.add_argument("--json", action="store_true")
        p.add_argument("--no-wait", action="store_true")
        sub.add_parser("devices", help="list paired phones")
        r = sub.add_parser("revoke", help="sign a phone out"); r.add_argument("who")
        a = ap.parse_args()
        learn_tailnet()
        sys.exit({"pair": cli_pair, "devices": cli_devices, "revoke": cli_revoke}[a.cmd](a))

    ap = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    ap.add_argument("port", nargs="?", type=int, default=8742)
    ap.add_argument("--bind", default="127.0.0.1")
    a = ap.parse_args()
    try:
        os.nice(5)  # Law 22: background work never competes with Fred's typing
    except OSError:
        pass
    learn_tailnet()
    os.makedirs(STATE_DIR, mode=0o700, exist_ok=True)
    with open(state_path("server.json"), "w") as f:
        json.dump({"pid": os.getpid(), "port": a.port, "url": public_url(a.port), "started": int(time.time())}, f)
    devices()
    threading.Thread(target=poller, daemon=True).start()
    handler = functools.partial(Handler, directory=HERE)
    srv = ThreadingHTTPServer((a.bind, a.port), handler)
    print(f"shepr: serving {HERE} on http://{a.bind}:{a.port} as {LOCAL} "
          f"(owner={OWNER['login']}, devices={len(DEVICES)}, writes={'off' if READONLY else 'on, confirm-first'})",
          file=sys.stderr, flush=True)
    try:
        srv.serve_forever()
    except KeyboardInterrupt:
        pass


if __name__ == "__main__":
    main()
