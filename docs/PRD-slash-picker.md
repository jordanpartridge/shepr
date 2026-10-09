# PRD: slash-command and skill options in the compose box (PARKED, 2026-10-08 23:5x)

Status: **DECIDED, not built.** Requested after the 11 PM park-it cutoff, so it waits until Fred has slept.
**Decision (Fred, 2026-10-09 ~00:05): A, shaped as: a tappable row of the LAST 6 skills he used, plus search over all of them behind a MORE button.**
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

## Decided shape (Fred's words: "a tappable skill list of the last 6 ones I use and searchable for all of them with a MORE button")

- In a session's compose box, typing `/` (or a **/** button next to the box) shows ONE row: the last 6 skills/commands he
  actually used, most recent first. Tap = fills the box with `/name ` (never sends).
- **MORE** opens a searchable sheet of every skill and command on the host (name + one-line description), filtered as
  you type; tap fills the box and closes it.
- "Last 6 used" comes from the host: scan the recent session transcripts / prompt history for `/name` invocations
  (cheap, local) and fall back to the phone's own recent picks until that exists. Remember per host.
- Sending still goes through the normal preview-and-confirm sheet. A blocked session at a dialog gets no slash row.

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
