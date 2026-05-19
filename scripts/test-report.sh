#!/usr/bin/env bash
# scripts/test-report.sh — run all test suites and produce test-reports/summary.json
set -euo pipefail

cd "$(dirname "$0")/.."
mkdir -p test-reports

UNIT_JSON="test-reports/unit.json"
INTEGRATION_JSON="test-reports/integration.json"
TYPECHECK_TXT="test-reports/typecheck.txt"
BUNDLE_TXT="test-reports/bundle-validation.txt"
SUMMARY_JSON="test-reports/summary.json"

# ── 1. Unit tests ─────────────────────────────────────────────────────────────
echo "[1/5] Running unit tests..."
UNIT_PASS=0
UNIT_FAIL=0
UNIT_SKIP=0
UNIT_STATUS="ok"

if npx vitest run --reporter=json --outputFile="$UNIT_JSON" 2>&1; then
  echo "  Unit tests PASSED"
else
  UNIT_STATUS="failed"
  echo "  Unit tests FAILED (see $UNIT_JSON)"
fi

# Parse counts from JSON if available
if [ -f "$UNIT_JSON" ]; then
  UNIT_PASS=$(node -e "try{const r=require('./$UNIT_JSON');console.log(r.numPassedTests||0)}catch{console.log(0)}" 2>/dev/null || echo 0)
  UNIT_FAIL=$(node -e "try{const r=require('./$UNIT_JSON');console.log(r.numFailedTests||0)}catch{console.log(0)}" 2>/dev/null || echo 0)
  UNIT_SKIP=$(node -e "try{const r=require('./$UNIT_JSON');console.log(r.numPendingTests||0)}catch{console.log(0)}" 2>/dev/null || echo 0)
fi

# ── 2. Integration tests (if config exists) ───────────────────────────────────
echo "[2/5] Running integration tests..."
INT_PASS=0
INT_FAIL=0
INT_SKIP=0
INT_STATUS="skipped"

if [ -f "vitest.integration.config.ts" ]; then
  if npx vitest run --config vitest.integration.config.ts --reporter=json --outputFile="$INTEGRATION_JSON" 2>&1; then
    INT_STATUS="ok"
    echo "  Integration tests PASSED"
  else
    INT_STATUS="failed"
    echo "  Integration tests FAILED (see $INTEGRATION_JSON)"
  fi

  if [ -f "$INTEGRATION_JSON" ]; then
    INT_PASS=$(node -e "try{const r=require('./$INTEGRATION_JSON');console.log(r.numPassedTests||0)}catch{console.log(0)}" 2>/dev/null || echo 0)
    INT_FAIL=$(node -e "try{const r=require('./$INTEGRATION_JSON');console.log(r.numFailedTests||0)}catch{console.log(0)}" 2>/dev/null || echo 0)
    INT_SKIP=$(node -e "try{const r=require('./$INTEGRATION_JSON');console.log(r.numPendingTests||0)}catch{console.log(0)}" 2>/dev/null || echo 0)
  fi
else
  echo "  No vitest.integration.config.ts found — skipping"
fi

# ── 3. TypeScript type check ──────────────────────────────────────────────────
echo "[3/5] TypeScript type check..."
TSC_STATUS="ok"
TSC_ERRORS=0

if npx tsc --noEmit 2>"$TYPECHECK_TXT"; then
  echo "  TypeScript OK"
else
  TSC_STATUS="failed"
  TSC_ERRORS=$(wc -l < "$TYPECHECK_TXT" | tr -d ' ')
  echo "  TypeScript ERRORS ($TSC_ERRORS lines — see $TYPECHECK_TXT)"
fi

# ── 4. Bundle validation ──────────────────────────────────────────────────────
echo "[4/5] Bundle validation..."
{
  echo "=== Bundle Validation ==="

  if node --check webview-ui/dist/main.js 2>&1; then
    echo "main.js: OK"
    MAIN_OK=1
  else
    echo "main.js: SYNTAX ERRORS"
    MAIN_OK=0
  fi

  if node --check webview-ui/dist/components.js 2>&1; then
    echo "components.js: OK"
    COMP_OK=1
  else
    echo "components.js: NOT FOUND or SYNTAX ERRORS"
    COMP_OK=0
  fi

  if node --check dist/extension.js 2>&1; then
    echo "extension.js: OK"
    EXT_OK=1
  else
    echo "extension.js: NOT FOUND or SYNTAX ERRORS"
    EXT_OK=0
  fi
} | tee "$BUNDLE_TXT"

BUNDLE_STATUS="ok"
# Re-read results since subshell variables don't propagate
if grep -q "SYNTAX ERRORS" "$BUNDLE_TXT" 2>/dev/null; then
  BUNDLE_STATUS="failed"
fi

# ── 5. Summary JSON ───────────────────────────────────────────────────────────
echo "[5/5] Writing summary..."

NOW=$(date -u +"%Y-%m-%dT%H:%M:%SZ")

cat > "$SUMMARY_JSON" <<EOF
{
  "generatedAt": "$NOW",
  "unit": {
    "status": "$UNIT_STATUS",
    "passed": $UNIT_PASS,
    "failed": $UNIT_FAIL,
    "skipped": $UNIT_SKIP,
    "reportFile": "$UNIT_JSON"
  },
  "integration": {
    "status": "$INT_STATUS",
    "passed": $INT_PASS,
    "failed": $INT_FAIL,
    "skipped": $INT_SKIP,
    "reportFile": "$INTEGRATION_JSON"
  },
  "typecheck": {
    "status": "$TSC_STATUS",
    "errorLines": $TSC_ERRORS,
    "reportFile": "$TYPECHECK_TXT"
  },
  "bundleValidation": {
    "status": "$BUNDLE_STATUS",
    "reportFile": "$BUNDLE_TXT"
  }
}
EOF

echo ""
echo "=== Summary written to $SUMMARY_JSON ==="
cat "$SUMMARY_JSON"
echo ""
echo "=== Files in test-reports/ ==="
ls -lh test-reports/
