# Shepr

**Herd your agents from your phone.** An iPhone home-screen app that shows which agent sessions, on
which hosts, are waiting on you, longest blocked first. Tap one, read the last 40 lines, answer it.
Sends confirm first, and it never approves anything by itself.

Built with the [nixweb.app](../nixweb.app) method: a web page on the tailnet, no Xcode, no App Store,
no build step, no framework, no npm. Idea #2 in nixweb's `IDEAS.md`, "the killer one".

```
iPhone ──HTTPS (tailscale serve)──> gus: server.py ──herdr CLI──> local agents
                                                     └─herdr --machine (ssh)──> vic, max, red ...
```

## Use it

```bash
# once, on the host (gus):
~/Projects/nixweb.app/bin/nixweb install herder.remote.iphone 8742   # systemd --user unit + tailscale serve
shepr pair                                                           # shows a QR code
```

On the iPhone, in **Safari**: open `https://gus.tail0940f.ts.net:8742`, Share, **Add to Home Screen**.
Open **Shepr** from the Home Screen, tap **Scan QR**, point it at the code in your terminal, tap **Pair**.
Done: the phone now holds a key the host trusts.

It is HTTPS because it has to be: iOS refuses WebCrypto (the phone's key), the camera (the QR scan) and
service workers on plain `http://`. `tailscale serve` supplies a real certificate on the tailnet name.

## What is on screen

| Tab | What |
|---|---|
| **Queue** | Sessions waiting on you (blocked), longest first, then finished-but-unseen. Badge shows the count. |
| **Herd** | Every session on every host, grouped by host. |
| **Go** | Search every session by project, title or host. Waiting first, then recent. |
| **Hosts** | Hosts herdr can reach (turn saved ones on or off) and a tailnet scan for more. |
| **Keys** | This phone's key, the phones the host trusts (revoke), pair another. |

### Moving around (tap, double-tap, hold: none of them ever sends)

| Where | Tap | Double-tap | Hold |
|---|---|---|---|
| Queue row | open | n/a | peek at the last 14 lines |
| Session title | Go To | next waiting | previous session |
| ◀ ▶ | step | n/a | first / last |
| Tab | switch | refresh | Go To |
| Host chip | filter | clear | only this host |

## Sending

A send is two requests. `prepare` returns exactly what will happen (the keys, the text, which agent,
what state it is in) plus a one-use nonce. `commit` runs it. The preview is bound to the agent's
`state_change_seq`: if the agent moved on while you looked, nothing is sent. A failed send is reported
and never retried; a failed write may still have landed, and the message says so.

- A blocked agent gets keys, not prompts: option buttons (it works out the ↓ presses from the screen),
  an arrow/Enter/Esc pad, or a typed line. Options that read like approvals are marked amber and the
  confirm sheet says so.
- An idle agent gets a normal prompt. A working agent only accepts `Esc` (interrupt) or a queued prompt.
- No ctrl-chords from a phone.
- `SHEPR_READONLY=1` turns every write off.

## Pairing and keys

The phone makes an ECDSA P-256 key with `extractable: false`; it can sign with it and nothing can read
it back. `shepr pair` writes a one-time code (60 bits, 3 minutes, single use, stored hashed) and prints
a QR of `https://<host>:8742/#shepr-pair=XXXX-XXXX-XXXX`. The app scans it, sends its **public** key with
the code, and the host files it in `~/.local/state/shepr/devices.json`, like an `authorized_keys` entry.

Every later request is signed over `time, nonce, method, path, sha256(body)`. The host refuses a replay,
a changed path or method, an old timestamp, an unknown or revoked key. Five wrong codes in a minute
locks pairing for a minute.

```
shepr pair [--ttl 180] [--png qr.png] [--json] [--no-wait]
shepr devices            # list paired phones with SSH-style SHA256 fingerprints
shepr revoke <name|id>   # sign a phone out now
```

**This is not an SSH key.** A home-screen web app cannot speak SSH or hold an OpenSSH key; WebCrypto can.
The device key authenticates the phone to Shepr. Hops from the host to other machines use ordinary SSH
keys through herdr's saved machines.

On top of that, every request must come through tailscale from the node owner's login, with the right
`Host` header; public funnel traffic, other tailnet users and cross-origin posts are refused. Nothing
listens beyond `127.0.0.1`.

## More hosts

The phone talks to one Shepr. That host reaches the rest with `herdr --machine <label>` over SSH.

**Hosts > Scan tailnet** tries `ssh` with this host's key, never prompting, to the online machines that
**belong to you** (nodes shared in from another user are never touched), and reports each as
`ready` (herdr found: **Add**), `needs key` (**Copy key** gives a one-line command that appends this
host's public key to `authorized_keys`; run it once there, scan again), `first connect` (run `ssh host`
once and check the fingerprint; Shepr never trusts a new host key on its own), `no herdr`, or `unreachable`.
Add and on/off go through the same preview-and-confirm sheet and run `herdr machine add|enable|disable`.

## Honest limits

- "Blocked for" is measured: herdr gives an event counter, not a clock. The host polls herdr every 15 s
  and remembers when it first saw each blocked state; for local Claude sessions that were already blocked
  it uses the transcript's last-write time. A leading `≥` means it was already blocked when watching began.
- Verified here: the server, the signing scheme (WebCrypto signatures checked by the pure-Python verifier),
  QR generation and scanning (fake camera feed through jsQR), gestures, layout at iPhone 14 size, and the
  real tailnet scan. **Not verified on a physical iPhone**: camera permission in a Home Screen app,
  keyboard behaviour, and the launch images. `tests/` covers everything else.
- Sending to an idle agent via `herdr agent prompt` could not be exercised against a real agent in the
  isolated test session (it refuses a fake agent that is not the pane's foreground process).
- iOS may delete a Home Screen app's storage if it is removed; the key goes with it. Pair again.
- One Shepr per phone install: the app is served from one origin.

## Layout

```
server.py            static files, /ping, /api, and the shepr CLI (pair|devices|revoke). Standard library only.
index.html app.css app.js sw.js manifest.webmanifest
icons/               logo.svg, app icons, launch images (iOS shows these before any code runs)
vendor/jsQR.js       the one third-party file: Safari has no BarcodeDetector. Apache-2.0, see vendor/README.md
tests/               ui.mjs (Playwright, iPhone 14), pair_cli_test.py, fake-session.sh (isolated herdr session)
```

State: `~/.local/state/shepr/` (`devices.json`, `seen.json`, `pairing.json`, `sends.jsonl` audit log), mode 0600.
Logs: `journalctl --user -u nixweb-herder.remote.iphone -f`.

## Testing without touching real agents

```bash
tests/fake-session.sh up                       # isolated herdr session "hrtest" with fake agents
eval "$(tests/fake-session.sh env)"; SHEPR_URL=http://localhost:8743 python3 server.py 8743 &
node tests/ui.mjs; python3 tests/pair_cli_test.py
tests/fake-session.sh down
```
