#!/usr/bin/env bash
# Ad-hoc driver for the aobot verify stack: the same compose project, files and ports as `vp run verify`
# (verify/stack.ts, verify/compose.yml), kept running so an agent can drive it by hand.
# Usage: .claude/skills/verify-aobot/scripts/stack.sh <up|doctor|script|requests|audit|trace|ab|answers|wait-answer|shot|snap|logs|down> [args]
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/../../../.." && pwd)"
cd "$ROOT"

PROJECT=aobot-verify
COMPUTER="${PROJECT}-computer"
SESSION=aobot-adhoc
BASE=http://localhost:3100
GRAFANA=http://localhost:3400
MOCK=http://localhost:4110
EVIDENCE_ROOT="$ROOT/.verify-evidence"

compose() { docker compose --project-name "$PROJECT" --file docker-compose.yml --file verify/compose.yml "$@"; }
ab() { agent-browser --session "$SESSION" "$@"; }

# The run's evidence folder: $EVIDENCE, or the newest one, or a fresh one.
evidence_dir() {
  if [[ -n "${EVIDENCE:-}" ]]; then mkdir -p "$EVIDENCE"; echo "$EVIDENCE"; return; fi
  local latest
  latest="$(ls -1d "$EVIDENCE_ROOT"/*/ 2>/dev/null | sort | tail -1 || true)"
  if [[ -n "$latest" ]]; then echo "${latest%/}"; return; fi
  local fresh="$EVIDENCE_ROOT/$(date +%Y%m%d-%H%M%S)"
  mkdir -p "$fresh"; echo "$fresh"
}

cmd="${1:-}"; shift || true

case "$cmd" in
  up)
    if compose ps --quiet server 2>/dev/null | grep -q .; then
      echo "stack.sh: $PROJECT is already running. Run 'doctor', or 'down' first. Not starting a second one." >&2
      exit 1
    fi
    for port in 3100 3400 4110; do
      if lsof -nP -iTCP:$port -sTCP:LISTEN >/dev/null 2>&1; then
        echo "stack.sh: port $port is taken by something else (lsof -nP -iTCP:$port). Not starting." >&2
        exit 1
      fi
    done
    docker rm --force "$COMPUTER" >/dev/null 2>&1 || true
    compose up --build --detach --wait
    dir="$EVIDENCE_ROOT/$(date +%Y%m%d-%H%M%S)"
    mkdir -p "$dir"
    echo "ready: app $BASE · grafana $GRAFANA · mock model $MOCK"
    echo "evidence: $dir"
    ;;

  doctor)
    ok=0
    echo "== containers ($PROJECT)"
    compose ps --format '{{.Service}}	{{.State}}	{{.Health}}' || ok=1
    echo "== server answers on $BASE"
    code="$(curl -s -o /dev/null -w '%{http_code}' "$BASE/" || true)"; echo "HTTP $code"; [[ "$code" == 200 ]] || ok=1
    echo "== port 3100 is ours (docker proxy, not a host server like dev:acp)"
    lsof -nP -iTCP:3100 -sTCP:LISTEN 2>/dev/null | awk 'NR>1{print $1, $2}' | sort -u
    lsof -nP -iTCP:3100 -sTCP:LISTEN 2>/dev/null | grep -qiE 'docker|com\.docke|vpnkit' || { echo "not a docker port"; ok=1; }
    echo "== mock model on $MOCK"
    curl -sf "$MOCK/mock/requests" >/dev/null && echo "answers" || { echo "no answer"; ok=1; }
    echo "== server image built from HEAD $(git rev-parse --short HEAD)?"
    created="$(docker image inspect "${PROJECT}-server" --format '{{.Created}}' 2>/dev/null || echo none)"
    echo "server image created: $created (rebuild with 'down' + 'up' if you changed code since)"
    echo "== computer container"
    docker ps --filter "name=^${COMPUTER}$" --format '{{.Names}} {{.Status}}' | grep . || echo "none yet (the server starts it on the Bot's first computer action)"
    [[ $ok == 0 ]] && echo "doctor: OK" || { echo "doctor: NOT OK"; exit 1; }
    ;;

  script)
    # Body is a ModelScript as JSON (apps/server/src/features/agent/testing/model-script.ts), from a file or stdin.
    src="${1:--}"
    body="$(if [[ "$src" == - ]]; then cat; else cat "$src"; fi)"
    curl -sf -X PUT --data "$body" "$MOCK/mock/script" -o /dev/null -w 'mock script set: HTTP %{http_code}\n'
    ;;

  requests)
    out="$(curl -sf "$MOCK/mock/requests")"
    echo "$out"
    if [[ "${1:-}" == --save ]]; then dir="$(evidence_dir)"; echo "$out" > "$dir/model-requests.json"; echo "saved $dir/model-requests.json" >&2; fi
    ;;

  trace)
    # Span names of one trace (trace_id from an audit row), from Tempo through Grafana.
    id="${1:?usage: stack.sh trace <trace_id> [--save]}"
    out="$(curl -sf "$GRAFANA/api/datasources/proxy/uid/tempo/api/v2/traces/$id")"
    if [[ "${2:-}" == --save ]]; then dir="$(evidence_dir)"; echo "$out" > "$dir/trace-$id.json"; echo "saved $dir/trace-$id.json" >&2; fi
    echo "$out" | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{const t=JSON.parse(s).trace;for(const r of t.resourceSpans)for(const sc of r.scopeSpans)for(const sp of sc.spans)console.log(sp.name+((sp.events??[]).length?"  events: "+sp.events.map(e=>e.name).join(","):""))})'
    ;;

  audit)
    out="$(compose exec -T server node -e 'const { DatabaseSync } = require("node:sqlite");
const rows = new DatabaseSync("/data/aobot.db").prepare("SELECT seq, decision, action, trace_id, detail FROM audit_rows ORDER BY seq").all();
console.log(JSON.stringify(rows, null, 2));')"
    echo "$out"
    if [[ "${1:-}" == --save ]]; then dir="$(evidence_dir)"; echo "$out" > "$dir/audit.json"; echo "saved $dir/audit.json" >&2; fi
    ;;

  shot)
    name="${1:?usage: stack.sh shot <name>}"
    dir="$(evidence_dir)"
    ab screenshot "$dir/$name.png" >/dev/null
    echo "$dir/$name.png"
    ;;

  snap)
    name="${1:?usage: stack.sh snap <name>}"
    dir="$(evidence_dir)"
    ab snapshot -i > "$dir/$name.snapshot.txt"
    echo "$dir/$name.snapshot.txt"
    ;;

  ab)
    # Any agent-browser command in this skill's session, e.g. `stack.sh ab open http://localhost:3100`.
    ab "$@"
    ;;

  answers)
    ab eval "[...document.querySelectorAll('.bubble--assistant .bubble__text')].map(n => n.textContent).filter(t => t !== '')"
    ;;

  wait-answer)
    # Wait until answer number <n> (1-based) reads exactly <text>, or fail after <seconds> (default 60).
    n="${1:?usage: stack.sh wait-answer <n> <text> [seconds]}"; want="${2:?}"; limit="${3:-60}"
    js="[...document.querySelectorAll('.bubble--assistant .bubble__text')].map(n => n.textContent).filter(t => t !== '')[$((n - 1))] ?? ''"
    deadline=$((SECONDS + limit))
    while (( SECONDS < deadline )); do
      got="$(ab eval "$js")"
      if [[ "$got" == "\"$want\"" ]]; then echo "answer $n: $want"; exit 0; fi
      sleep 0.5
    done
    echo "stack.sh: timed out after ${limit}s waiting for answer $n to read '$want' (last: $got)" >&2
    exit 1
    ;;

  logs)
    compose logs server --tail "${1:-80}"
    ;;

  down)
    dir="$(evidence_dir)"
    compose logs server --no-color > "$dir/server.log" 2>&1 || true
    ab close >/dev/null 2>&1 || true
    docker rm --force "$COMPUTER" >/dev/null 2>&1 || true
    compose down --volumes
    echo "stack down. evidence kept in $dir"
    ;;

  *)
    sed -n '2,4p' "$0"; exit 2
    ;;
esac
