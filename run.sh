#!/usr/bin/env bash
# FactRadar — local service manager. Starts/stops the three services:
#   core   : factradar-core   (Python/FastAPI/uvicorn)  http://localhost:41820
#   ingest : factradar-ingest (Node, public site)       http://localhost:41734
#   admin  : factradar-admin  (Node, dashboard)         http://localhost:41900
#
# Usage:
#   ./run.sh start      # start all three (background, logs in .logs/)
#   ./run.sh stop       # stop all three
#   ./run.sh restart    # stop then start
#   ./run.sh status     # show which are running
#   ./run.sh logs core  # tail a service log (core|ingest|admin)
#
# Works in Git Bash/WSL on Windows and on Linux/macOS.

set -u
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
LOGDIR="$ROOT/.logs"
PIDDIR="$ROOT/.pids"
mkdir -p "$LOGDIR" "$PIDDIR"

# Python venv bin dir differs by OS: Windows uses Scripts/, *nix uses bin/.
if [ -d "$ROOT/factradar-core/.venv/Scripts" ]; then
  VBIN="$ROOT/factradar-core/.venv/Scripts"
else
  VBIN="$ROOT/factradar-core/.venv/bin"
fi

is_win() { case "$(uname -s)" in MINGW*|MSYS*|CYGWIN*) return 0 ;; *) return 1 ;; esac; }

port_busy() {
  local port="$1"
  if is_win; then
    netstat -ano 2>/dev/null | grep LISTENING | grep -qE "[:.]$port[[:space:]]"
  else
    lsof -ti tcp:"$port" >/dev/null 2>&1
  fi
}

kill_port() {
  local port="$1"
  if is_win; then
    local pids
    pids="$(netstat -ano 2>/dev/null | grep LISTENING | grep -E "[:.]$port[[:space:]]" | awk '{print $NF}' | sort -u)"
    for pid in $pids; do
      taskkill //PID "$pid" //F >/dev/null 2>&1 && echo "  stopped pid $pid (:$port)"
    done
  else
    local pids
    pids="$(lsof -ti tcp:"$port" 2>/dev/null || true)"
    if [ -n "$pids" ]; then kill $pids 2>/dev/null && echo "  stopped $pids (:$port)"; fi
  fi
}

start_one() {
  local name="$1" dir="$2" port="$3"; shift 3
  if port_busy "$port"; then echo "$name already running (:$port)"; return; fi
  ( cd "$ROOT/$dir" && exec "$@" ) >"$LOGDIR/$name.log" 2>&1 &
  echo $! > "$PIDDIR/$name.pid"
  echo "started $name (:$port)  ->  .logs/$name.log"
}

case "${1:-}" in
  start)
    start_one core   factradar-core   41820 "$VBIN/uvicorn" main:app --port 41820 --env-file .env
    start_one ingest factradar-ingest 41734 npm start
    start_one admin  factradar-admin  41900 npm start
    echo ""
    echo "site:  http://localhost:41734"
    echo "admin: http://localhost:41900"
    ;;
  stop)
    echo "stopping services..."
    kill_port 41820
    kill_port 41734
    kill_port 41900
    rm -f "$PIDDIR"/*.pid 2>/dev/null || true
    echo "done"
    ;;
  restart)
    "$0" stop
    sleep 2
    "$0" start
    ;;
  status)
    for pair in "core:41820" "ingest:41734" "admin:41900"; do
      n="${pair%%:*}"; p="${pair##*:}"
      if port_busy "$p"; then echo "$n:   running (:$p)"; else echo "$n:   stopped (:$p)"; fi
    done
    ;;
  logs)
    svc="${2:-}"
    case "$svc" in
      core|ingest|admin) tail -n 100 -f "$LOGDIR/$svc.log" ;;
      *) echo "Usage: $0 logs {core|ingest|admin}"; exit 1 ;;
    esac
    ;;
  *)
    echo "Usage: $0 {start|stop|restart|status|logs <svc>}"
    exit 1
    ;;
esac
