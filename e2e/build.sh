#!/usr/bin/env bash
# Builds both sites against a mock Supabase so the browser tests can run without real accounts.
#   e2e/.dist          founder site (CardDesk)
#   e2e/.dist-tyche    public product (Tyche Cards)
set -euo pipefail
cd "$(dirname "$0")/.."
export VITE_SUPABASE_URL=https://mockproj.supabase.co VITE_SUPABASE_ANON_KEY=anon
npx vite build --outDir e2e/.dist --emptyOutDir >/dev/null
VITE_BRAND=tyche npx vite build --outDir e2e/.dist-tyche --emptyOutDir >/dev/null
echo "built e2e/.dist and e2e/.dist-tyche"
