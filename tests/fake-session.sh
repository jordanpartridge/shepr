#!/usr/bin/env bash
# Builds an ISOLATED herdr session ("hrtest") with fake blocked/working/idle agents so the app can be
# exercised without ever touching a real agent. Nothing here talks to the default session.
#
#   tests/fake-session.sh up        start the isolated server and populate it
#   tests/fake-session.sh down      stop ONLY the hrtest session
#   tests/fake-session.sh env       print the env to run server.py against it
#
# Then:  eval "$(tests/fake-session.sh env)"; python3 server.py 8743 &
#        node tests/ui.mjs            (needs playwright; paths at the top of the file)
set -euo pipefail
SOCK="$HOME/.config/herdr/sessions/hrtest/herdr.sock"
H(){ env -u HERDR_PANE_ID -u HERDR_WORKSPACE_ID -u HERDR_TAB_ID HERDR_SOCKET_PATH="$SOCK" herdr "$@" < /dev/null; }
mk(){ # label cwd state [agent] [title] [file-to-show]
  local p; p=$(H workspace create --label "$1" --cwd "$2" | python3 -c 'import json,sys;print(json.load(sys.stdin)["result"]["root_pane"]["pane_id"])')
  local show
  # herdr reads the TERMINAL title (what Claude Code sets to a summary of the session), so set it the same way
  local ttl="printf '\\033]0;✳ %s\\007' '${5:-$1}'"
  if [ -n "${6:-}" ]; then show="clear; cat '$6'"
  else show="clear; printf '%s\n' 'Working on $1' 'Do you want to proceed?' '❯ 1. Yes' '  2. Yes, and do not ask again' '  3. No' '' 'Esc to cancel'"; fi
  H pane run "$p" "cd $2; $ttl; $show; sleep 100000" >/dev/null
  sleep .6
  # report-agent fakes the state herdr would detect; "done" is not a state you can fake.
  H pane report-agent "$p" --source hrtest:fake --agent "${4:-claude}" --state "$3" >/dev/null
  echo "$1 $p $3"
}
case "${1:-}" in
  up)
    (setsid nohup herdr --session hrtest server >/dev/null 2>&1 < /dev/null &); sleep 3
    HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
    mk burnbar "$HOME/Projects/burnbar" blocked claude "PR Hunter burnbar"
    mk clarity "$HOME/Projects/clarity" blocked claude "Bug fixes and pull requests"
    mk blip "$HOME/Projects/blip" working codex "Release notes draft"
    mk infomarchy "$HOME/Projects/infomarchy" idle claude "Herdr project list sort order" "$HERE/sample-pane.txt"
    mk clarity "$HOME/Projects/clarity" blocked claude "Herder workflow automation" ;;
  multi) H workspace list | python3 -c 'import json,sys;[print(w["workspace_id"]) for w in json.load(sys.stdin)["result"]["workspaces"] if w["label"]=="multi"]' | while read w; do H workspace close "$w" >/dev/null; done
    HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
    mk multi "$HOME/Projects/whats-next" blocked claude "Project customization walkthrough" "$HERE/sample-multi.txt" ;;
  multi-rm) H workspace list | python3 -c 'import json,sys;[print(w["workspace_id"]) for w in json.load(sys.stdin)["result"]["workspaces"] if w["label"]=="multi"]' | while read w; do H workspace close "$w" >/dev/null; done ;;
  down) herdr session stop hrtest < /dev/null ;;
  env) echo "export HERDR_SOCKET_PATH=$SOCK SHEPR_STATE=/tmp/shepr-test-state SHEPR_POLL=3" ;;
  *) sed -n '2,12p' "$0"; exit 1 ;;
esac
