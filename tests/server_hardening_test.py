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
         "snap": {"status": "blocked", "seq": 7, "session": "s1"}, "expires": time.time() + 60, "made": time.time()}
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

# ---- a multi-step dialog is ONE blocked state: ticks, then Review, then Submit all share herdr's counter (seq 7).
# A preview made AFTER the previous answer must work; only a preview made BEFORE it is dead. (Regression: Fred's phone could
# not press "Submit answers" on the Review screen because the whole state counted as "already answered".)
sent.clear()
time.sleep(0.05); mkplan(3)                      # made after the answer above, same seq 7
out3 = []
try: out3.append(srv.commit_plan("n3")["ok"])
except srv.HerdrError as e: out3.append(e.code)
check("multi-step: a fresh preview after an answer is accepted although the state counter has not moved", out3 == [True] and len(sent) == 1)
time.sleep(0.05); mkplan(4); mkplan(5)           # two phones look at the Review screen together
out45 = []
def c45(n):
    try: out45.append(srv.commit_plan(f"n{n}")["ok"])
    except srv.HerdrError as e: out45.append(e.code)
ts = [threading.Thread(target=c45, args=(n,)) for n in (4, 5)]
[t.start() for t in ts]; [t.join() for t in ts]
check("multi-step: two phones on the same Review screen still answer it only once", sorted(map(str, out45)) == ["True", "moved_on"])

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

# ---- uploads from the phone: what a file really is, where it is stored, and how it is cleaned up
PNG = b"\x89PNG\r\n\x1a\n" + b"x" * 50
check("upload: a PNG, JPEG, GIF, WEBP and PDF are recognised by their first bytes, whatever the phone calls them",
      [srv.sniff_upload(b, "exe") for b in (PNG, b"\xff\xd8\xff\xe0" + b"x" * 9, b"GIF89a" + b"x" * 9, b"RIFF\0\0\0\0WEBPx", b"%PDF-1.7 x")] == ["png", "jpg", "gif", "webp", "pdf"])
check("upload: an executable, a script and unknown bytes are refused", all(srv.sniff_upload(b, e) is None for b, e in ((b"MZ\x90\x00" + b"x" * 20, "exe"), (b"#!/bin/sh\nrm -rf x", "sh"), (b"\x7fELF" + b"x" * 9, "bin"))))
check("upload: plain text is accepted only with a text extension, and not with a NUL or bad UTF-8",
      srv.sniff_upload(b"hello", "txt") == "txt" and srv.sniff_upload(b"hello", "sh") is None and srv.sniff_upload(b"a\x00b", "txt") is None and srv.sniff_upload(b"\xff\xfe\xfa", "txt") is None)
r = srv.save_upload(PNG, "png", "dev1")
st = os.stat(r["path"]); dst = os.stat(os.path.dirname(r["path"]))
check("upload: stored under the state dir, mode 0600 in a 0700 folder, with a random name", r["path"].startswith(srv.upload_dir()) and st.st_mode & 0o777 == 0o600 and dst.st_mode & 0o777 == 0o700 and r["kind"] == "png" and open(r["path"], "rb").read() == PNG)
for bad, why in ((b"", "empty"), (b"x" * (srv.UPLOAD_MAX + 1), "too big")):
    try: srv.save_upload(bad, "txt", "dev1"); refused = False
    except srv.HerdrError as e: refused = e.code in ("too_big", "bad_type")
    check(f"upload: a {why} file is refused", refused)
os.utime(r["path"], (time.time() - 8 * 86400,) * 2)
r2 = srv.save_upload(PNG, "png", "dev1")
check("upload: files older than a week are deleted on the next upload", not os.path.exists(r["path"]) and os.path.exists(r2["path"]))
srv.UPLOAD_DIR_CAP = 120
paths = [srv.save_upload(PNG + bytes([i]), "png", "dev1")["path"] for i in range(5)]
check("upload: the folder is kept under its size cap by dropping the oldest first", sum(os.path.getsize(p) for p in paths if os.path.exists(p)) <= 120 and os.path.exists(paths[-1]))

sys.exit(0 if ok else 1)
