#!/usr/bin/env node

/**
 * Post-commit test runner that generates reports named by branch and commit ID.
 * Report format: test-reports/<branch>_<commit-short-hash>_<timestamp>.json
 *
 * See GROUND_RULES.md for specification.
 */

const { execSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const REPORTS_DIR = path.join(__dirname, '..', 'test-reports');

function run(cmd) {
  return execSync(cmd, { encoding: 'utf-8' }).trim();
}

function main() {
  // Ensure reports directory exists
  if (!fs.existsSync(REPORTS_DIR)) {
    fs.mkdirSync(REPORTS_DIR, { recursive: true });
  }

  // Git metadata
  const branch = run('git rev-parse --abbrev-ref HEAD').replace(/[/\\]/g, '-');
  const commitId = run('git rev-parse HEAD');
  const commitShort = run('git rev-parse --short HEAD');
  const commitMessage = run('git log -1 --pretty=%s');
  const timestamp = new Date().toISOString();
  const timestampFile = timestamp.replace(/[:.]/g, '-').replace('Z', '');

  const reportFileName = `${branch}_${commitShort}_${timestampFile}.json`;
  const reportPath = path.join(REPORTS_DIR, reportFileName);

  console.log(`\n--- Running test suite for ${branch}@${commitShort} ---\n`);

  const startTime = Date.now();
  let testResult;
  let exitCode = 0;

  try {
    // Run vitest with JSON reporter
    testResult = execSync('npx vitest run --reporter=json 2>&1', {
      encoding: 'utf-8',
      cwd: path.join(__dirname, '..'),
    });
  } catch (err) {
    testResult = err.stdout || err.stderr || '';
    exitCode = err.status || 1;
  }

  const durationMs = Date.now() - startTime;

  // Parse vitest JSON output
  let parsed = null;
  try {
    // vitest JSON output may have non-JSON lines before it
    const jsonStart = testResult.indexOf('{');
    if (jsonStart >= 0) {
      parsed = JSON.parse(testResult.slice(jsonStart));
    }
  } catch {
    // JSON parse failed
  }

  // Build report
  const report = {
    branch: branch,
    commitId: commitId,
    commitMessage: commitMessage,
    timestamp: timestamp,
    duration_ms: durationMs,
    summary: {
      total: 0,
      passed: 0,
      failed: 0,
      skipped: 0,
    },
    suites: {},
    failures: [],
  };

  if (parsed && parsed.testResults) {
    for (const suite of parsed.testResults) {
      for (const test of suite.assertionResults || []) {
        report.summary.total++;
        if (test.status === 'passed') report.summary.passed++;
        else if (test.status === 'failed') {
          report.summary.failed++;
          report.failures.push({
            suite: path.basename(suite.name),
            test: test.fullName || test.title,
            file: suite.name,
            error: (test.failureMessages || []).join('\n').slice(0, 500),
          });
        } else {
          report.summary.skipped++;
        }
      }
    }
  }

  // Write report
  fs.writeFileSync(reportPath, JSON.stringify(report, null, 2));

  // Print summary
  console.log(`\n--- Test Report: ${reportFileName} ---`);
  console.log(`Total: ${report.summary.total}`);
  console.log(`Passed: ${report.summary.passed}`);
  console.log(`Failed: ${report.summary.failed}`);
  console.log(`Skipped: ${report.summary.skipped}`);
  console.log(`Duration: ${durationMs}ms`);

  if (report.failures.length > 0) {
    console.log('\nFailures:');
    for (const f of report.failures) {
      console.log(`  - ${f.test} (${f.file})`);
      console.log(`    ${f.error.split('\n')[0]}`);
    }
  }

  console.log(`\nReport saved to: ${reportPath}\n`);

  // Exit with test exit code (non-zero if tests failed)
  process.exit(exitCode);
}

main();
