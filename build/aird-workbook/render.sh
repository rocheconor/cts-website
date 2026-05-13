#!/usr/bin/env bash
# Render the AIRD workbook PDF.
# Usage: ./build/aird-workbook/render.sh
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
cd "$ROOT/build/aird-workbook"
node render.js
