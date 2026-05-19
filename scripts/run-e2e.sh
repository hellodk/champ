#!/usr/bin/env bash
# scripts/run-e2e.sh — comprehensive Champ E2E test suite
set -e

cd "$(dirname "$0")/.."

echo "=== Champ E2E Test Suite ==="
mkdir -p test-reports

# ── 1. Unit tests ─────────────────────────────────────────────────────────────
echo ""
echo "[1/6] Running unit tests..."
npx vitest run --reporter=json --outputFile=test-reports/unit.json 2>&1 && echo "Unit tests PASSED" || echo "Unit tests FAILED — see test-reports/unit.json"

# ── 2. E2E tests ──────────────────────────────────────────────────────────────
echo ""
echo "[2/6] Running E2E tests..."
npx vitest run --config vitest.e2e.config.ts --reporter=json --outputFile=test-reports/e2e.json 2>&1 && echo "E2E tests PASSED" || echo "E2E tests FAILED — see test-reports/e2e.json"

# ── 3. Type check ─────────────────────────────────────────────────────────────
echo ""
echo "[3/6] TypeScript type check..."
npx tsc --noEmit 2>test-reports/typecheck.txt && echo "TypeScript OK" || echo "TypeScript ERRORS — see test-reports/typecheck.txt"

# ── 4. Bundle validation ──────────────────────────────────────────────────────
echo ""
echo "[4/6] Bundle validation..."
node --check webview-ui/dist/main.js 2>&1 && echo "main.js OK" || echo "main.js ERRORS (may not be built yet)"
node --check webview-ui/dist/components.js 2>&1 && echo "components.js OK" || echo "components.js ERRORS (may not be built yet)"
node --check dist/extension.js 2>&1 && echo "extension.js OK" || echo "extension.js ERRORS (may not be built yet)"

# ── 5. Package analysis ───────────────────────────────────────────────────────
echo ""
echo "[5/6] Package analysis..."
npx @vscode/vsce ls --no-dependencies 2>/dev/null | tail -5 || echo "(vsce ls skipped)"
ls -lh champ-*.vsix 2>/dev/null | tail -1 || echo "(no .vsix found)"

# ── 6. Quick security scan ────────────────────────────────────────────────────
echo ""
echo "[6/6] Quick security scan..."
EVAL_COUNT=$(grep -rn "eval(" src/ --include="*.ts" 2>/dev/null | grep -v "\.test\." | grep -v "__tests__" | wc -l || echo 0)
INNERHTML_COUNT=$(grep -rn "innerHTML.*msg\|innerHTML.*user" src/ --include="*.ts" 2>/dev/null | grep -v "\.test\." | grep -v "__tests__" | wc -l || echo 0)
CLIPBOARD_COUNT=$(grep -rn "navigator.clipboard" webview-ui/dist/main.js 2>/dev/null | wc -l || echo 0)

{
  echo "eval() usages (non-test): $EVAL_COUNT"
  echo "innerHTML with user/msg data (non-test): $INNERHTML_COUNT"
  echo "navigator.clipboard usages in bundle: $CLIPBOARD_COUNT"
} | tee test-reports/security-concerns.txt

echo ""
echo "=== Test Reports written to test-reports/ ==="
ls -la test-reports/
