#!/usr/bin/env bash
# One-shot installer: sets up .env, installs deps, and compiles the server.
set -euo pipefail

DIR="$(cd "$(dirname "$0")/.." && pwd)"
cd "$DIR"

if [[ ! -f .env ]]; then
  cp .env.example .env
  echo "Created .env from .env.example — edit it with your CleverTap credentials."
fi

if ! command -v node >/dev/null 2>&1; then
  echo "ERROR: Node.js 18+ not found. Install it first: brew install node"
  exit 1
fi

echo "Installing npm dependencies…"
npm install

echo "Compiling TypeScript…"
npm run build

echo
echo "Done. Run:    node --env-file=.env dist/index.js"
echo "Or wire into Claude Desktop per README.md"
