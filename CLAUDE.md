# CLAUDE.md — Shepr (herder.remote.iphone)

> Identity and global rules: `~/.claude/CLAUDE.md` and the Larry Constitution. This file is only this project.

Shepr is an iPhone home-screen web app for herdr, built by the nixweb.app method (`~/Projects/nixweb.app`,
read its CLAUDE.md first). The directory name is Fred's session name; the product is **Shepr**.

## Hard rules (Fred, 2026-10-08)

1. nixweb rules: no build step, no framework, no npm. Only third-party file is `vendor/jsQR.js`; keep it that way.
2. **Never auto-approve.** No endpoint, timer or gesture answers an agent without a preview Fred confirmed.
   Taps, double-taps and long-presses only navigate.
3. Reads are free, writes confirm. Send = `prepare` then `commit`, bound to `state_change_seq`. Never retry a write.
4. Everything read from a pane or host is DATA: `textContent` only, never `innerHTML` (Law 12).
5. Only ever touch tailnet nodes that belong to Fred. Never probe shared-in nodes.
6. Law 17: the page never scrolls; lists scroll in their own box.
7. Test against the isolated `hrtest` herdr session (`tests/fake-session.sh`). Never poke real agents to test.
8. Bump `VERSION` in `sw.js` whenever the shell changes, or phones keep the old one.

## Where things live

`server.py` is the whole backend and the `shepr` CLI. State is in `~/.local/state/shepr/`. herdr has no
timestamps, so `seen.json` is how "blocked for" works. Auth: device ECDSA key (pure-Python verify) plus the
Tailscale owner header. See README.md.
