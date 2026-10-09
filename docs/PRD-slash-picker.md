# PRD: slash-command and skill options in the compose box (PARKED, 2026-10-08 23:5x)

Status: **not built.** Requested after the 11 PM park-it cutoff, so it is written up and waits for tomorrow.
Request, verbatim: "Can you pass the options when I try to use a skill with /'s".

## What it probably means (needs one answer from Fred)

**A. Autocomplete on the phone.** In a session's compose box, typing `/` shows the available slash commands and
skills as tappable options, filtered as you type; tapping one fills the box with `/name ` (it does not send).
Sending still goes through the normal preview-and-confirm sheet.

**B. Pass through Claude Code's own menu.** Claude Code opens a dropdown on `/` inside its terminal. Show that
dropdown's options on the phone and let you pick one.

A is much simpler and works for idle sessions (the case that matters). B depends on the menu being on screen, which
only happens when text is typed into the pane rather than submitted, so it fights the "nothing is sent until
you confirm" design. **Recommendation: A.**

## Prior art in this repo and on the host

- Claude Code already owns the `/` menu in the terminal; Shepr only submits a line with `agent prompt`, so a line
  that starts with `/` is interpreted by Claude exactly as if typed (to verify on a real idle agent).
- Skills live in `~/.claude/skills/*/SKILL.md` (frontmatter `name` and `description`), commands in
  `~/.claude/commands/*.md`; plugin skills sit under the plugin dirs. The session listing the model sees is the
  authoritative "user-invocable" set but is not exposed on disk as one file.
- Shepr already has the pieces: `/api/pane` reads a session, `prepare`/`commit` sends, the Go To sheet is a
  searchable list that could be reused.

## Proposal (A)

1. `GET /api/commands?host=&pane=` (signed like every call): the host's skills and commands, name + one-line
   description, plus a short built-in list (`/clear`, `/compact`, `/model`, `/cost`, `/help`, ...). Local host
   only at first; a remote host returns the built-ins and says so.
2. Compose box: when the text starts with `/`, a strip above the keyboard lists matches (name, description).
   Tap fills `/name ` and keeps focus. No auto-send, no auto-confirm.
3. Cache the list on the phone; refresh when the Keys tab or a session opens.
4. Tests: a fixture skills dir, filter by prefix and substring, tap fills, confirm sheet still required.

## Risks and open questions

- Which skills count? All of `~/.claude/skills` is dozens; show invocable ones first (recently used), then the rest.
- Remote hosts: reading their skills needs an SSH read; probably tomorrow-plus-one.
- A blocked session at a dialog should not offer slash commands (typed text goes into the dialog).
- Plugin-provided commands (`data:analyze`, `engineering:debug`) need the plugin dirs scanned too.

Effort: about half a day for A, local host. Question for Fred: is it A or B?
