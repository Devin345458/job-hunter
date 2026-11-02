#!/usr/bin/env bash
# Orca worktree setup for job-hunter, run from orca.yaml when Orca creates a worktree.
# Gives the worktree its own .env, its own dev server port, and its own copy of the
# SQLite database, then installs dependencies. Nothing runs in docker and everything
# lands inside the worktree directory, so removing the worktree is the whole teardown.
set -euo pipefail

ROOT="${ORCA_ROOT_PATH:?run via the Orca setup hook, or set ORCA_ROOT_PATH to the main checkout}"
WT="${ORCA_WORKTREE_PATH:-$PWD}"
cd "$WT"
WT="$(pwd -P)"

if [ "$(cd "$ROOT" && pwd -P)" = "$WT" ]; then
  echo "This is the main checkout. The setup script only runs in a worktree." >&2
  exit 1
fi

# The hook shell skips ~/.zshrc, so PATH is bare. Use the nvm node the interactive shell uses:
# Homebrew's newer node can sit on PATH, and better-sqlite3 has no build for it.
export PATH="$PATH:/usr/bin:/bin:/usr/sbin:/sbin:/usr/local/bin:/opt/homebrew/bin"
export NVM_DIR="${NVM_DIR:-$HOME/.nvm}"
if [ -s "$NVM_DIR/nvm.sh" ]; then
  set +eu
  . "$NVM_DIR/nvm.sh"
  nvm use --silent >/dev/null 2>&1 || nvm use --silent default >/dev/null 2>&1
  set -eu
fi
command -v npm >/dev/null 2>&1 || { echo "npm not found on PATH. Install node, then re-run this script." >&2; exit 1; }
echo "Using node $(node -v) from $(command -v node)"

env_value() { # env_value <file> <KEY>
  [ -f "$1" ] || return 0
  sed -n "s/^$2=//p" "$1" | tail -1
}

# .env: start from the main checkout's copy (it holds the API keys).
if [ -f .env ]; then
  echo ".env already exists, keeping it."
else
  if [ -f "$ROOT/.env" ]; then
    cp "$ROOT/.env" .env
  else
    cp .env.example .env
    echo "WARNING: $ROOT/.env is missing, so .env was copied from .env.example. Add the API keys to $WT/.env." >&2
  fi
  # Never inherit the main checkout's port or database location.
  sed -i '' -e '/^NUXT_PORT=/d' -e '/^NUXT_DATABASE_PATH=/d' .env
  printf '\nNUXT_DATABASE_PATH=./data/job-hunter.db\n' >>.env
fi
# A worktree never runs the pipeline on its own schedule: its copy would call Claude and open real
# employer forms every 3 hours. Manual runs (Settings, /api/pipeline/run) still work.
grep -q '^NUXT_SCHEDULER_ENABLED=' .env || printf 'NUXT_SCHEDULER_ENABLED=false\n' >>.env

# Port: 3000 belongs to the main checkout. Skip ports another checkout has claimed or something is listening on.
PORT="$(env_value .env NUXT_PORT)"
if [ -z "$PORT" ]; then
  CLAIMED=" 3000 "
  while IFS= read -r path; do
    [ -n "$path" ] && [ "$path" != "$WT" ] || continue
    p="$(env_value "$path/.env" NUXT_PORT)"
    if [ -n "$p" ]; then CLAIMED="$CLAIMED$p "; fi
  done <<EOF
$(git -C "$ROOT" worktree list --porcelain | sed -n 's/^worktree //p')
EOF
  PORT=3100
  while case "$CLAIMED" in *" $PORT "*) true ;; *) false ;; esac || lsof -nP -iTCP:"$PORT" -sTCP:LISTEN >/dev/null 2>&1; do
    PORT=$((PORT + 1))
    [ "$PORT" -le 3999 ] || { echo "No free port between 3100 and 3999." >&2; exit 1; }
  done
  printf 'NUXT_PORT=%s\n' "$PORT" >>.env
fi

# Database: a private copy of the main checkout's data. sqlite3 .backup is safe while the main app is running in WAL mode.
SRC_DB="$(env_value "$ROOT/.env" NUXT_DATABASE_PATH)"
SRC_DB="${SRC_DB:-./data/job-hunter.db}"
case "$SRC_DB" in /*) ;; *) SRC_DB="$ROOT/${SRC_DB#./}" ;; esac
mkdir -p data/resumes
if [ -f data/job-hunter.db ]; then
  echo "data/job-hunter.db already exists, keeping it."
elif [ -f "$SRC_DB" ]; then
  sqlite3 "$SRC_DB" ".backup '$WT/data/job-hunter.db'"
  if [ -d "$ROOT/data/resumes" ]; then cp -R "$ROOT/data/resumes/." data/resumes/; fi
  echo "Copied the main checkout's database into data/job-hunter.db."
else
  echo "No database in the main checkout. The app creates and migrates one on the first request."
fi

echo "Installing dependencies..."
npm ci --no-audit --no-fund </dev/null

echo
echo "Ready. Start the dev server with: npm run dev"
echo "It serves http://localhost:${PORT}"
