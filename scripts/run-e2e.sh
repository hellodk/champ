#!/usr/bin/env bash
# scripts/run-e2e.sh — comprehensive Champ E2E test suite
#
# Every gating step records pass/fail; the full summary is always printed at
# the end and the script exits non-zero if any step failed.
#
# (#112) Previously every step ran as `cmd && echo PASSED || echo FAILED`
# under `set -e`, so a red suite still exited 0 — failures were swallowed by
# the fallback echo. Steps now route through run_step, which captures the
# real exit code without tripping errexit.
set -eu

cd "$(dirname "$0")/.."

echo "=== Champ E2E Test Suite ==="
mkdir -p test-reports

FAILED_STEPS=()

# run_step <label> <command...> — runs the command, records its exit code.
run_step() {
  local label="$1"
  shift
  if "$@"; then
    echo "✓ PASSED: $label"
  else
    echo "✗ FAILED: $label"
    FAILED_STEPS+=("$label")
  fi
}

# ── 1. Unit tests ─────────────────────────────────────────────────────────────
echo ""
echo "[1/6] Running unit tests..."
run_step "Unit tests" \
  npx vitest run --reporter=json --outputFile=test-reports/unit.json

# ── 2. E2E tests ──────────────────────────────────────────────────────────────
echo ""
echo "[2/6] Running E2E tests..."
run_step "E2E tests" \
  npx vitest run --config vitest.e2e.config.ts --reporter=json \
  --outputFile=test-reports/e2e.json

# ── 3. Type check ─────────────────────────────────────────────────────────────
echo ""
echo "[3/6] TypeScript type check..."
# bash -c keeps the stderr redirection scoped to tsc, not to run_step itself
run_step "TypeScript type check" \
  bash -c 'npx tsc --noEmit 2>test-reports/typecheck.txt'

# ── 4. Bundle validation ──────────────────────────────────────────────────────
echo ""
echo "[4/6] Bundle validation..."
run_step "Bundle syntax check webview-ui/dist/main.js" \
  node --check webview-ui/dist/main.js
run_step "Bundle syntax check webview-ui/dist/components.js" \
  node --check webview-ui/dist/components.js
run_step "Bundle syntax check dist/extension.js" \
  node --check dist/extension.js

# ── 5. Package analysis (informational — never gates the exit code) ──────────
echo ""
echo "[5/6] Package analysis..."
npx @vscode/vsce ls --no-dependencies 2>/dev/null | tail -5 \
  || echo "(vsce ls skipped)"
ls -lh champ-*.vsix 2>/dev/null | tail -1 || echo "(no .vsix found)"

# ── 6. Quick security scan (informational counts — reported, not gated) ──────
echo ""
echo "[6/6] Quick security scan..."
EVAL_COUNT=$(grep -rn "eval(" src/ --include="*.ts" 2>/dev/null | grep -v "\.test\." | grep -v "__tests__" | wc -l)
INNERHTML_COUNT=$(grep -rn "innerHTML.*msg\|innerHTML.*user" src/ --include="*.ts" 2>/dev/null | grep -v "\.test\." | grep -v "__tests__" | wc -l)
CLIPBOARD_COUNT=$(grep -n "navigator.clipboard" webview-ui/dist/main.js 2>/dev/null | wc -l)

{
  echo "eval() usages (non-test): $EVAL_COUNT"
  echo "innerHTML with user/msg data (non-test): $INNERHTML_COUNT"
  echo "navigator.clipboard usages in bundle: $CLIPBOARD_COUNT"
} | tee test-reports/security-concerns.txt

# ── Summary ───────────────────────────────────────────────────────────────────
echo ""
echo "=== Summary ==="
if [ "${#FAILED_STEPS[@]}" -eq 0 ]; then
  echo "All gating checks passed."
else
  echo "${#FAILED_STEPS[@]} step(s) failed:"
  for step in "${FAILED_STEPS[@]}"; do
    echo "  ✗ $step"
  done
fi

echo ""
echo "=== Test Reports written to test-reports/ ==="
ls -la test-reports/

if [ "${#FAILED_STEPS[@]}" -ne 0 ]; then
  exit 1
fi
