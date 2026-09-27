// Adversarial Test Runner for M1 Features (Hotkey Queue & VAD Rejection)
const { spawn } = require('child_process');
const path = require('path');

const testFiles = [
  path.join(__dirname, 'hotkey-queue.test.js'),
  path.join(__dirname, 'vad-rejection.test.js'),
];

console.log('=== Running Adversarial Stress Test Suite ===\n');

const proc = spawn('node', ['--test', ...testFiles], { stdio: 'inherit' });
proc.on('close', code => {
  console.log(`\nAdversarial test process exited with code ${code}`);
  process.exit(code);
});
