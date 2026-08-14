#!/usr/bin/env bash
#
# ayin — one-command setup. macOS and Linux.
#
#   git clone --recursive https://github.com/minorusan/ayin.git && cd ayin && ./install.sh
#
# Safe to re-run: every step is idempotent, and it verifies its own result rather than assuming the last
# command worked. It does NOT ask for a model — `ayin` does that itself on first launch, and it verifies
# what you give it, so there is no second place for that logic to drift.
#
# Flags:
#   --dir <path>   clone into <path> when run outside a checkout (default: ./ayin)
#   --no-link      build only; do not touch the global `ayin` command
#   --replace-system-bin   also delete a root-owned `ayin` that npm does not manage (asks sudo)
#
set -euo pipefail

REPO_URL="${AYIN_REPO_URL:-https://github.com/minorusan/ayin.git}"
TARGET=""
DO_LINK=1
REPLACE_SYSTEM_BIN=0

while [ $# -gt 0 ]; do
  case "$1" in
    --dir) TARGET="${2:-}"; shift 2 ;;
    --no-link) DO_LINK=0; shift ;;
    --replace-system-bin) REPLACE_SYSTEM_BIN=1; shift ;;
    -h|--help) sed -n '2,20p' "$0"; exit 0 ;;
    *) echo "unknown flag: $1" >&2; exit 2 ;;
  esac
done

say()  { printf '\033[1m%s\033[0m\n' "$*"; }
info() { printf '  %s\n' "$*"; }
warn() { printf '  \033[33m! %s\033[0m\n' "$*"; }
die()  { printf '\033[31mx %s\033[0m\n' "$*" >&2; exit 1; }

# ── 1. Prerequisites ────────────────────────────────────────────────────────────
say "Checking prerequisites"

command -v git >/dev/null 2>&1 || die "git is not installed."
command -v node >/dev/null 2>&1 || die "Node is not installed. Install Node 18+ (https://nodejs.org) and re-run."
command -v npm >/dev/null 2>&1 || die "npm is not installed (it ships with Node)."

NODE_MAJOR="$(node -p 'process.versions.node.split(".")[0]')"
[ "$NODE_MAJOR" -ge 18 ] || die "Node $(node -v) is too old — ayin needs 18+ for global fetch and AbortSignal.timeout."
info "node $(node -v) · npm $(npm -v) · git $(git --version | awk '{print $3}')"

# ── 2. Find or create the checkout ──────────────────────────────────────────────
# Run from inside a clone, and that clone is what gets set up. Run from anywhere else and it clones —
# so `./install.sh` after a manual clone and a bare bootstrap both work with no separate instructions.
HERE="$(cd "$(dirname "$0")" && pwd)"
if [ -f "$HERE/package.json" ] && node -e "process.exit(require('$HERE/package.json').name === 'ayin' ? 0 : 1)" 2>/dev/null; then
  ROOT="$HERE"
  say "Using this checkout"
else
  ROOT="${TARGET:-$PWD/ayin}"
  if [ -d "$ROOT/.git" ]; then
    say "Using existing checkout at $ROOT"
  else
    say "Cloning into $ROOT"
    git clone --recursive "$REPO_URL" "$ROOT"
  fi
fi
cd "$ROOT"
info "$ROOT"

# The diagram renderer is a submodule. Absent, everything works except drawing pictures — so this is a
# note, never a failure.
if [ -f .gitmodules ]; then
  git submodule update --init --recursive >/dev/null 2>&1 \
    || warn "submodule init failed — /naama rendering will be unavailable; everything else works."
fi

# ── 3. Unregister every existing ayin ───────────────────────────────────────────
# UNCONDITIONALLY, before anything else touches PATH. Two ayins on PATH is the failure that makes every
# later symptom unexplainable: PATH order decides which one runs, so a rebuild appears to do nothing and
# `ayin version` (which reads package.json) confirms the version you expected. Seen for real.
#
# `npm rm -g` covers both a published install and an `npm link`, since a link is just a global package
# whose contents are a symlink. A hand-written launcher script that npm never owned is reported and
# removed separately, because npm cannot see it at all.
if [ "$DO_LINK" -eq 1 ]; then
  say "Removing any existing ayin registration"
  BEFORE="$(type -aP ayin 2>/dev/null || true)"
  if [ -n "$BEFORE" ]; then
    printf '%s\n' "$BEFORE" | while IFS= read -r p; do [ -n "$p" ] && info "found: $p"; done
  else
    info "none registered"
  fi

  npm rm -g ayin >/dev/null 2>&1 || sudo -n npm rm -g ayin >/dev/null 2>&1 || true

  # Anything still answering was not installed by npm: a launcher script someone dropped into a bin
  # directory. Every one of them is handled, not just the first.
  #
  # A ROOT-OWNED ONE IS REPORTED, NOT DELETED — learned the hard way. An earlier version of this script
  # sudo-removed it, and on a machine with passwordless sudo that silently deleted a hand-written
  # launcher which was the deliberate, working setup on that host. A file this script did not create,
  # owned by another user, is not its to delete: it prints the one command that removes it and carries on.
  # `--replace-system-bin` opts in when you do mean it.
  for STRAY in $(type -aP ayin 2>/dev/null || true); do
    STRAY_REAL="$( { readlink -f "$STRAY" 2>/dev/null || python3 -c 'import os,sys;print(os.path.realpath(sys.argv[1]))' "$STRAY"; } || true)"
    case "$STRAY_REAL" in
      "$ROOT"/*) info "existing link already points here — re-pointed below"; continue ;;
    esac
    if [ -w "$STRAY" ] || [ "$REPLACE_SYSTEM_BIN" -eq 1 ]; then
      info "removing $STRAY (not managed by npm)"
      rm -f "$STRAY" 2>/dev/null \
        || { [ "$REPLACE_SYSTEM_BIN" -eq 1 ] && sudo rm -f "$STRAY" 2>/dev/null; } \
        || warn "could not remove $STRAY — PATH order may keep serving it."
    else
      warn "$STRAY is not yours to delete (owned by $(ls -ld "$STRAY" | awk '{print $3}'))."
      info "It is not managed by npm, and it may be a deliberate launcher on this host."
      info "If it should go:  sudo rm $STRAY      (or re-run with --replace-system-bin)"
      info "Until then, PATH order decides which ayin runs."
    fi
  done
fi

# ── 4. Pull the latest ──────────────────────────────────────────────────────────
# A setup script that builds whatever happens to be checked out is a setup script that installs a stale
# build. A dirty tree is left alone: uncommitted work is not this script's to discard.
if [ -d .git ] && git remote get-url origin >/dev/null 2>&1; then
  say "Pulling the latest"
  BRANCH="$(git rev-parse --abbrev-ref HEAD)"
  if [ "$BRANCH" = "HEAD" ]; then
    warn "detached HEAD — not pulling. \`git checkout main\` if you want the latest."
  elif [ -n "$(git status --porcelain)" ]; then
    warn "uncommitted changes here — not pulling, building what you have."
  else
    git fetch --quiet || warn "fetch failed — building the current checkout."
    if git pull --ff-only --quiet 2>/dev/null; then
      info "$BRANCH at $(git rev-parse --short HEAD) — $(git log -1 --pretty=%s | cut -c1-60)"
    else
      warn "could not fast-forward $BRANCH — building the current checkout."
    fi
  fi
fi

# ── 5. Dependencies ─────────────────────────────────────────────────────────────
say "Installing dependencies"
# `npm ci` is reproducible but insists the lockfile matches package.json exactly; fall back rather than
# failing a setup over a lockfile drift nobody asked about.
if [ -f package-lock.json ] && npm ci >/dev/null 2>&1; then
  info "npm ci (from the lockfile)"
else
  npm install >/dev/null || die "npm install failed. Run it directly to see why: (cd $ROOT && npm install)"
  info "npm install"
fi

# ── 6. Build ────────────────────────────────────────────────────────────────────
say "Building"
npm run build >/dev/null || die "build failed. Run it directly to see why: (cd $ROOT && npm run build)"
[ -f dist/index.js ] || die "build reported success but dist/index.js is missing."
info "dist/ built"

# ── 7. Put `ayin` on PATH (the pointer) ───────────────────────────────────────────────────────
if [ "$DO_LINK" -eq 1 ]; then
  say "Linking the \`ayin\` command"
  LINKED=0
  if npm link >/dev/null 2>&1; then
    LINKED=1
  elif sudo -n true 2>/dev/null && sudo npm link >/dev/null 2>&1; then
    LINKED=1
    info "(needed sudo — the global npm prefix is root-owned)"
  fi
  if [ "$LINKED" -eq 1 ]; then
    info "ayin -> $ROOT/dist/index.js"
  else
    warn "npm link failed (the global prefix is probably not writable)."
    info "Either:  sudo npm link --prefix $ROOT"
    info "Or point npm at a user-owned prefix once:"
    info "    npm config set prefix ~/.local && npm link"
    info "    export PATH=\"\$HOME/.local/bin:\$PATH\"   # add to your shell profile"
  fi
fi

# ── 8. Verify, out loud ─────────────────────────────────────────────────────────
# Verified rather than assumed: the failure this catches is a second `ayin` earlier on PATH, which makes
# every later "I updated and nothing changed" impossible to diagnose.
say "Verifying"
if command -v ayin >/dev/null 2>&1; then
  RESOLVED="$( { readlink -f "$(command -v ayin)" 2>/dev/null || python3 -c 'import os,sys;print(os.path.realpath(sys.argv[1]))' "$(command -v ayin)"; } || true)"
  case "$RESOLVED" in
    "$ROOT"/*) info "\`ayin\` runs this checkout ($(node -p "require('$ROOT/package.json').version")) ✓" ;;
    *) warn "\`ayin\` on PATH resolves to $RESOLVED — NOT this checkout."
       info "Remove that one, or run this build directly: node $ROOT/dist/index.js" ;;
  esac
  COUNT="$(type -aP ayin 2>/dev/null | wc -l | tr -d ' ')"
  [ "${COUNT:-1}" -gt 1 ] && warn "$COUNT \`ayin\` commands are on PATH — PATH order decides which you get."
else
  info "not on PATH — run it directly: node $ROOT/dist/index.js"
fi

echo
say "Done."
info "Start it:  ayin"
echo
info "On first launch ayin asks for a model — a local Ollama it finds, an OpenAI key, or an endpoint."
info "It verifies whatever you give it, so it will not open onto a model that cannot answer."
echo
info "Optional, once inside:"
info "  /openai sk-…                    store an OpenAI key (verified, then saved 0600)"
info "  /jira-auth <token> <email> <site>   your current sprint via /jira"
info "  /sentry-auth <token> org: <slug>    production errors via /sentry"
info "  ayin update                     pull this checkout, rebuild, re-link"
