#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

echo "[1/3] Running backend tests"
cd "$ROOT_DIR/backend"
npm test

echo "[2/3] Running frontend tests"
cd "$ROOT_DIR/frontend"
npm test

echo "[3/3] Running ml-service tests"
cd "$ROOT_DIR/ml-service"
./venv/bin/python -m pytest tests

echo "All test suites passed."
