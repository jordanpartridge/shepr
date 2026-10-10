#!/usr/bin/env python3
"""`shepr pair` in WAIT mode: shows a code, waits, and reports the device that redeems it.
Needs a running test server (see tests/ui.mjs header). Generates a real P-256 key with openssl."""
import json, os, subprocess, sys, tempfile, time, urllib.request, base64
HERE = os.path.dirname(os.path.abspath(__file__))
SERVER = os.path.join(HERE, "..", "server.py")
ENV = dict(os.environ, SHEPR_STATE=os.environ.get("SHEPR_STATE", "/tmp/claude-1000/shepr-state"), SHEPR_URL="http://localhost:8743")
# Regression (2026-10-08): the QR must carry the tailnet name, not 127.0.0.1. Run WITHOUT SHEPR_URL, which is what masked it.
import importlib.util
os.environ.pop("SHEPR_URL", None)
spec = importlib.util.spec_from_file_location("shepr_server", SERVER); m = importlib.util.module_from_spec(spec); spec.loader.exec_module(m)
m.learn_tailnet()
url = m.public_url(8742)
good = url.startswith("https://") and "127.0.0.1" not in url and ".ts.net:8742" in url
print(("PASS" if good else "FAIL"), "pairing URL uses the tailnet name:", url)

# CLI wait-mode needs a running test server on :8743 (see tests/ui.mjs header); skip cleanly without one.
try:
    urllib.request.urlopen("http://localhost:8743/api/hello", timeout=2)
    have_server = True
except Exception:
    have_server = False
if not have_server:
    print("SKIP pair CLI wait-mode test: no test server on :8743")
    sys.exit(0 if good else 1)

d = tempfile.mkdtemp()
subprocess.run(["openssl", "ecparam", "-name", "prime256v1", "-genkey", "-noout", "-out", d + "/k.pem"], check=True, capture_output=True)
raw = subprocess.run(["openssl", "ec", "-in", d + "/k.pem", "-pubout", "-outform", "DER"], check=True, capture_output=True).stdout[-64:]
b64u = lambda b: base64.urlsafe_b64encode(b).rstrip(b"=").decode()
jwk = {"kty": "EC", "crv": "P-256", "x": b64u(raw[:32]), "y": b64u(raw[32:])}

p = subprocess.Popen([sys.executable, SERVER, "pair", "--json", "--ttl", "60"], env=ENV, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
info = json.loads(p.stdout.readline())
req = urllib.request.Request("http://localhost:8743/api/pair", method="POST", headers={"Content-Type": "application/json", "X-Shepr": "1"},
                             data=json.dumps({"code": info["code"], "jwk": jwk, "name": "cli-test"}).encode())
res = json.load(urllib.request.urlopen(req))
out, err = p.communicate(timeout=10)
ok = p.returncode == 0 and "paired" in out and "cli-test" in out and res["fp"] in out
print(("PASS" if ok else "FAIL"), "pair CLI waits, then reports the paired device:", out.strip().splitlines()[-1] if out.strip() else err)
sys.exit(0 if good and (not have_server or ok) else 1)
