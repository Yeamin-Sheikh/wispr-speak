#!/usr/bin/env node
// Wispr Tell Comprehensive E2E Test Runner
// Executes 4-tier requirement-driven test suites and aggregates metrics.
const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');

const ARGS = process.argv.slice(2);
const options = {
  tier: null,       // 1, 2, 3, 4, or null (all)
  feature: null,    // 1-20, or null (all)
  reporter: 'spec', // 'spec' or 'json'
  bail: false
};

for (const arg of ARGS) {
  if (arg.startsWith('--tier=')) options.tier = arg.split('=')[1];
  else if (arg.startsWith('--feature=')) options.feature = arg.split('=')[1];
  else if (arg.startsWith('--reporter=')) options.reporter = arg.split('=')[1];
  else if (arg === '--bail') options.bail = true;
  else if (arg === '--help' || arg === '-h') {
    console.log(`
Wispr Tell E2E Test Runner
Usage: node tests/run-all-tests.js [options]

Options:
  --tier=N         Run tests only for tier N (1, 2, 3, or 4)
  --feature=N      Run tests only for feature N (1 to 20)
  --reporter=MODE  Output format: 'spec' (default) or 'json'
  --bail           Stop immediately on first test failure
  --help, -h       Show this help message
`);
    process.exit(0);
  }
}

const TESTS_ROOT = __dirname;
const TIER1_DIR = path.join(TESTS_ROOT, 'tier1-feature-coverage');
const TIER2_DIR = path.join(TESTS_ROOT, 'tier2-boundary-corner');
const TIER3_DIR = path.join(TESTS_ROOT, 'tier3-cross-feature');
const TIER4_DIR = path.join(TESTS_ROOT, 'tier4-scenarios');

function collectTestFiles() {
  const files = [];

  // Tier 1 files
  if (!options.tier || options.tier === '1') {
    if (fs.existsSync(TIER1_DIR)) {
      const list = fs.readdirSync(TIER1_DIR)
        .filter(f => f.endsWith('.test.js'))
        .filter(f => {
          if (!options.feature) return true;
          const featNum = String(options.feature).padStart(2, '0');
          return f.includes(`feat${featNum}`);
        })
        .map(f => ({ tier: 'Tier 1 - Feature Coverage', file: path.join(TIER1_DIR, f) }));
      files.push(...list);
    }
  }

  // Tier 2 files
  if (!options.tier || options.tier === '2') {
    if (fs.existsSync(TIER2_DIR)) {
      const list = fs.readdirSync(TIER2_DIR)
        .filter(f => f.endsWith('.test.js'))
        .filter(f => {
          if (!options.feature) return true;
          const featNum = String(options.feature).padStart(2, '0');
          return f.includes(`boundary${featNum}`);
        })
        .map(f => ({ tier: 'Tier 2 - Boundary & Corner Cases', file: path.join(TIER2_DIR, f) }));
      files.push(...list);
    }
  }

  // Tier 3 files
  if (!options.tier || options.tier === '3') {
    if (fs.existsSync(TIER3_DIR) && !options.feature) {
      const list = fs.readdirSync(TIER3_DIR)
        .filter(f => f.endsWith('.test.js'))
        .map(f => ({ tier: 'Tier 3 - Cross-Feature Combinations', file: path.join(TIER3_DIR, f) }));
      files.push(...list);
    }
  }

  // Tier 4 files
  if (!options.tier || options.tier === '4') {
    if (fs.existsSync(TIER4_DIR) && !options.feature) {
      const list = fs.readdirSync(TIER4_DIR)
        .filter(f => f.endsWith('.test.js'))
        .map(f => ({ tier: 'Tier 4 - Real-World Application Scenarios', file: path.join(TIER4_DIR, f) }));
      files.push(...list);
    }
  }

  return files;
}

async function runTestSuite() {
  const targetFiles = collectTestFiles();
  if (targetFiles.length === 0) {
    console.error('No test files matched the specified criteria.');
    process.exit(1);
  }

  if (options.reporter === 'spec') {
    console.log('\n===============================================================');
    console.log('       WISPR TELL — OPAQUE-BOX E2E TEST RUNNER');
    console.log('===============================================================');
    console.log(`Execution Mode:  ${options.tier ? 'Tier ' + options.tier : 'All Tiers (1-4)'}`);
    console.log(`Target Feature:  ${options.feature ? 'Feature ' + options.feature : 'All 20 Features'}`);
    console.log(`Test Files:      ${targetFiles.length} files selected\n`);
  }

  const startTime = Date.now();
  const filePaths = targetFiles.map(t => t.file);

  const nodeArgs = ['--test', ...filePaths];
  const child = spawn(process.execPath, nodeArgs, {
    cwd: path.join(TESTS_ROOT, '..'),
    env: { ...process.env, FORCE_COLOR: '1' },
    stdio: options.reporter === 'spec' ? 'inherit' : ['ignore', 'pipe', 'pipe']
  });

  let rawStdout = '';
  let rawStderr = '';

  if (options.reporter === 'json') {
    child.stdout.on('data', d => rawStdout += d.toString());
    child.stderr.on('data', d => rawStderr += d.toString());
  }

  child.on('close', (code) => {
    const totalDuration = Date.now() - startTime;

    if (options.reporter === 'json') {
      const passedMatches = (rawStdout.match(/✔/g) || []).length;
      const failedMatches = (rawStdout.match(/✖/g) || []).length;
      const result = {
        exitCode: code,
        durationMs: totalDuration,
        summary: {
          totalFiles: targetFiles.length,
          approxPassedTests: passedMatches,
          approxFailedTests: failedMatches
        },
        passed: code === 0
      };
      console.log(JSON.stringify(result, null, 2));
      process.exit(code);
    }

    console.log('\n===============================================================');
    console.log(`Summary: Process exited with code ${code} (${code === 0 ? 'ALL PASS' : 'FAILURES DETECTED'})`);
    console.log(`Total Execution Time: ${totalDuration} ms`);
    console.log('===============================================================\n');

    process.exit(code);
  });
}

runTestSuite();
