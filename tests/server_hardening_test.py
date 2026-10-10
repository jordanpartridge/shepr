"""Regression tests for the 2026-10-09 bug hunt (Codex, 19 findings). Pure Python, nothing talks to herdr, the
network or the real state directory.  Run: python3 tests/server_hardening_test.py"""
import hashlib, importlib.util, json, os, sys, tempfile, threading, time
here = os.path.dirname(os.path.abspath(__file__))
os.environ["SHEPR_STATE"] = tempfile.mkdtemp()
spec = importlib.util.spec_from_file_location("shepr_server", os.path.join(here, "..", "server.py"))
srv = importlib.util.module_from_spec(spec); spec.loader.exec_module(srv)

ok = True
def check(name, cond):
    global ok
    print(("PASS " if cond else "FAIL ") + name); ok = ok and bool(cond)

def pub(k):
    x, y = srv._mul(k, srv._G)
    return {"kty": "EC", "crv": "P-256", "x": srv.b64u(x.to_bytes(32, "big")), "y": srv.b64u(y.to_bytes(32, "big"))}

# ---- one pairing code, two phones racing: exactly one wins
code = "ABCD-EFGH-JKLM"
srv.write_pairing({"hash": hashlib.sha256(srv.norm_code(code).encode()).hexdigest(), "expires": time.time() + 60, "used_by": None})
res = []
def redeem(k):
    try: res.append(("ok", srv.do_pair({"code": code, "jwk": pub(k), "name": f"p{k}"}, "t")))
    except srv.HerdrError as e: res.append(("err", e.code))
ts = [threading.Thread(target=redeem, args=(k,)) for k in (7, 9, 11, 13)]
[t.start() for t in ts]; [t.join() for t in ts]
check("pairing: four phones, one code, exactly one succeeds", sum(1 for r in res if r[0] == "ok") == 1)
check("pairing: exactly one device registered", len(json.load(open(srv.state_path("devices.json")))) == 1)

# ---- a revoke done by another process is never undone by this one's stale copy
did = next(iter(srv.devices()))
srv.devices()[did]["last_seen"] = 0
with open(srv.state_path("devices.json"), "w") as f: json.dump({}, f)       # `shepr revoke` from another process
def touch(devs):
    if did not in devs: raise srv.HerdrError("unknown_device", "revoked")
    devs[did]["last_seen"] = 1
try: srv.mutate_devices(touch); raised = False
except srv.HerdrError as e: raised = e.code == "unknown_device"
check("revoke: the touch sees the revocation and refuses", raised)
check("revoke: the device file still has no devices", json.load(open(srv.state_path("devices.json"))) == {})

# ---- two previews of the same blocked dialog: only the first commit is dispatched
sent = []
srv.need_host = lambda h: {"id": "gus", "machine": None, "kind": "local", "enabled": True}
srv.get_agent = lambda host, pane: {"agent_status": "blocked", "state_change_seq": 7, "agent_session": {"value": "s1"}}
srv.run_step = lambda host, pane, step: (time.sleep(0.2), sent.append(step["keys"]))
def mkplan(n):
    p = {"nonce": f"n{n}", "host": "gus", "pane": "w1:p1", "kind": "keys", "steps": [{"op": "keys", "keys": ["enter"]}],
         "snap": {"status": "blocked", "seq": 7, "session": "s1"}, "expires": time.time() + 60}
    srv.PLANS[p["nonce"]] = p
for n in (1, 2): mkplan(n)
out = []
def commit(n):
    try: out.append(srv.commit_plan(f"n{n}")["ok"])
    except srv.HerdrError as e: out.append(e.code)
ts = [threading.Thread(target=commit, args=(n,)) for n in (1, 2)]
[t.start() for t in ts]; [t.join() for t in ts]
check("commit: two previews of one dialog dispatch exactly once", len(sent) == 1)
check("commit: the other one is refused as moved_on", sorted(map(str, out)) == ["True", "moved_on"])

# ---- a runaway child is cut off at the byte cap
srv.MAX_OUT = 1 << 20
try: srv.bounded_run([sys.executable, "-c", "print('x' * 20_000_000)"], 20); cut = False
except srv.HerdrError as e: cut = e.code == "too_big"
check("subprocess output: a 20 MB answer is cut off at the cap", cut)

# ---- one host's malformed answer does not break the poll
srv.run_herdr = lambda machine, args, timeout=10, want_json=True: {"result": {"agents": None}}
r = srv.poll_host({"id": "h", "machine": "h", "kind": "remote", "enabled": True})
check("poll: a host answering agents=null becomes that host's error", r[1] is None and "bad_response" in r[3])
srv.run_herdr = lambda machine, args, timeout=10, want_json=True: (_ for _ in ()).throw(ValueError("boom"))
r = srv.poll_host({"id": "h", "machine": "h", "kind": "remote", "enabled": True})
check("poll: any exception becomes that host's error", r[1] is None and "bad_response" in r[3])

# ---- static files: launch images are served, traversal is not
check("static: iOS launch image is allowed", bool(srv.STATIC_OK.match("/icons/launch/1170x2532.png")))
check("static: traversal is not", not srv.STATIC_OK.match("/icons/launch/../../server.py") and not srv.STATIC_OK.match("/icons/../server.py"))

# ---- multi-select preview discloses a checked row the phone cannot change
SCREEN = """Pick any

❯ 1. [ ] Alpha
  2. [✔] Bravo
  3. [ ] Charlie
  4. [✔] Type something
     Submit
─────────
  5. Chat about this
"""
srv.read_tail = lambda host, pane, lines: SCREEN
srv.READONLY = False
plan = srv.build_plan({"host": "gus", "pane": "w1:p1", "kind": "multi", "picks": [], "advance": True})
kept = next(l["v"] for l in plan["lines"] if l["k"] == "Leaves ticked")
check("multi: a checked 'Type something' row is disclosed, not hidden", "Type something" in kept and "cannot be changed" in kept)
sys.exit(0 if ok else 1)
