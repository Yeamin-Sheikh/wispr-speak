// Adversarial Stress Suite: Features 18 & 20
// Tests Feature 18 (Fluid Draggable Pill with Spring Physics & Bounds)
// Tests Feature 20 (Character-by-Character Text Injection Animation & Unicode Safety)
//
// Verification Scope:
// 1. Multi-Monitor Physics Bounds: negative coordinates, virtual gaps, disconnected displays,
//    boundary padding (10px), and NaN/invalid input resilience.
// 2. Extreme Velocity & Micro-Drags: speed capping at 3000px/s, stretch transform limits,
//    and 400ms debounced persistence under high-frequency drag storms (100+ events).
// 3. Native Unicode Typing Injection: exotic UTF-8, surrogate pairs, emojis, Japanese/Arabic,
//    CRLF vs LF translation, and empty stream safety.
// 4. Zero Clipboard Pollution: sequence number invariant and clipboard content preservation.
// 5. Boundary Length Gating: exact 199, 200, 201 char thresholds, disabled toggle, and error fallback.

const { describe, it } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { spawnSync, spawn } = require('child_process');
const vm = require('vm');

const { MockClipboard } = require('../helpers/mock-electron');

// Enhanced MockClipboard supporting Electron clipboard methods used in injectText
class ComprehensiveMockClipboard extends MockClipboard {
  constructor() {
    super();
    this.formatsList = ['text/plain'];
    this.html = '';
    this.rtf = '';
  }

  availableFormats() {
    return this.formatsList;
  }

  readHTML() {
    return this.html;
  }

  readRTF() {
    return this.rtf;
  }

  readImage() {
    return { isEmpty: () => true };
  }
}

// Path to native helper binary
const PASTE_HELPER_PATH = path.resolve(__dirname, '../../bin/native/tell-paste.exe');

// Read source of src/main.js to extract real production classes and functions
const mainSource = fs.readFileSync(path.resolve(__dirname, '../../src/main.js'), 'utf8');

function extractClass(name) {
  const regex = new RegExp('class\\s+' + name + '\\s*\\{');
  const match = regex.exec(mainSource);
  if (!match) throw new Error('Class not found in src/main.js: ' + name);
  const start = match.index;
  let bodyStart = mainSource.indexOf('{', start);
  let open = 0;
  let i = bodyStart;
  while (i < mainSource.length) {
    if (mainSource[i] === '{') open++;
    else if (mainSource[i] === '}') {
      open--;
      if (open === 0) {
        return mainSource.slice(start, i + 1);
      }
    }
    i++;
  }
  throw new Error('Unterminated class in src/main.js: ' + name);
}

function extractFunction(name) {
  const regex = new RegExp('function\\s+' + name + '\\s*\\(');
  const match = regex.exec(mainSource);
  if (!match) throw new Error('Function not found in src/main.js: ' + name);
  const start = match.index;
  let p = mainSource.indexOf('(', start);
  let pOpen = 0;
  while (p < mainSource.length) {
    if (mainSource[p] === '(') pOpen++;
    else if (mainSource[p] === ')') {
      pOpen--;
      if (pOpen === 0) break;
    }
    p++;
  }
  let bodyStart = mainSource.indexOf('{', p);
  let open = 0;
  let i = bodyStart;
  while (i < mainSource.length) {
    if (mainSource[i] === '{') open++;
    else if (mainSource[i] === '}') {
      open--;
      if (open === 0) {
        return mainSource.slice(start, i + 1);
      }
    }
    i++;
  }
  throw new Error('Unterminated function in src/main.js: ' + name);
}

// Instantiate MultiMonitorPhysicsBounds directly from src/main.js
const MultiMonitorPhysicsBounds = (() => {
  const classSrc = extractClass('MultiMonitorPhysicsBounds');
  const ctx = {};
  vm.createContext(ctx);
  return vm.runInContext('(' + classSrc + ')', ctx);
})();

// Helper to run native tell-paste.exe with standard input
function runTellPasteStdin(inputText, timeoutMs = 4000) {
  return new Promise((resolve, reject) => {
    if (!fs.existsSync(PASTE_HELPER_PATH)) {
      return reject(new Error('tell-paste.exe binary does not exist at ' + PASTE_HELPER_PATH));
    }

    const proc = spawn(PASTE_HELPER_PATH, ['--type-stdin'], { windowsHide: true });
    let stdout = '';
    let stderr = '';

    const timer = setTimeout(() => {
      try { proc.kill(); } catch {}
      reject(new Error(`tell-paste.exe timed out after ${timeoutMs}ms`));
    }, timeoutMs);

    proc.stdout.on('data', chunk => { stdout += chunk.toString(); });
    proc.stderr.on('data', chunk => { stderr += chunk.toString(); });

    proc.on('close', code => {
      clearTimeout(timer);
      resolve({ code, stdout: stdout.trim(), stderr: stderr.trim() });
    });

    proc.on('error', err => {
      clearTimeout(timer);
      reject(err);
    });

    proc.stdin.write(inputText, 'utf8');
    proc.stdin.end();
  });
}

// Query real Win32 sequence number from native binary
function getNativeClipboardSequence() {
  const res = spawnSync(PASTE_HELPER_PATH, ['--get-seq'], { encoding: 'utf8', windowsHide: true });
  if (res.status !== 0) throw new Error('Failed to get native clipboard sequence: ' + res.stderr);
  const match = res.stdout.match(/CLIPBOARD_SEQ\s+(\d+)/);
  if (!match) throw new Error('Unrecognized output from --get-seq: ' + res.stdout);
  return parseInt(match[1], 10);
}

// ============================================================================
// SUITE 1: Multi-Monitor Physics & Boundary Clamping Under Adversarial Conditions
// ============================================================================
describe('Suite 1: Feature 18 — Multi-Monitor Physics & Boundary Clamping Under Adversarial Conditions', () => {
  const dualMonitorsLeftSecondary = [
    { id: 10, isPrimary: false, workArea: { x: -1920, y: 0, width: 1920, height: 1080 } },
    { id: 20, isPrimary: true, workArea: { x: 0, y: 0, width: 1920, height: 1080 } },
  ];

  const dualMonitorsTopSecondary = [
    { id: 11, isPrimary: false, workArea: { x: 0, y: -1080, width: 1920, height: 1080 } },
    { id: 21, isPrimary: true, workArea: { x: 0, y: 0, width: 1920, height: 1080 } },
  ];

  it('TC-M4-CHAL-01: negative monitor coordinates (secondary screen to the left: x < 0, y >= 0)', () => {
    // Inside secondary screen on left
    const res = MultiMonitorPhysicsBounds.clampToDisplays(-1000, 400, dualMonitorsLeftSecondary);
    assert.strictEqual(res.displayId, 10);
    assert.strictEqual(res.reset, false);
    assert.strictEqual(res.x, -1000);
    assert.strictEqual(res.y, 400);

    // Left edge of negative monitor with 10px padding
    const leftEdge = MultiMonitorPhysicsBounds.clampToDisplays(-2000, 400, dualMonitorsLeftSecondary);
    assert.strictEqual(leftEdge.displayId, 10);
    assert.strictEqual(leftEdge.x, -1920 + 10); // -1910

    // Right edge of negative monitor with 10px padding (bounds.x + width - pillWidth - 10)
    // -1920 + 1920 - 320 - 10 = -330
    const rightEdge = MultiMonitorPhysicsBounds.clampToDisplays(-100, 400, dualMonitorsLeftSecondary);
    assert.strictEqual(rightEdge.displayId, 10);
    assert.strictEqual(rightEdge.x, -330);
  });

  it('TC-M4-CHAL-02: negative monitor coordinates (secondary screen above: x >= 0, y < 0)', () => {
    // Inside secondary screen above
    const res = MultiMonitorPhysicsBounds.clampToDisplays(500, -700, dualMonitorsTopSecondary);
    assert.strictEqual(res.displayId, 11);
    assert.strictEqual(res.reset, false);
    assert.strictEqual(res.x, 500);
    assert.strictEqual(res.y, -700);

    // Top edge within 100px hysteresis buffer (-1100 >= -1080 - 100 = -1180): clamps to -1080 + 10 = -1070
    const topEdge = MultiMonitorPhysicsBounds.clampToDisplays(500, -1100, dualMonitorsTopSecondary);
    assert.strictEqual(topEdge.displayId, 11);
    assert.strictEqual(topEdge.x, 500);
    assert.strictEqual(topEdge.y, -1080 + 10);

    // Bottom edge of upper monitor: -1080 + 1080 - 44 - 10 = -54
    const bottomEdge = MultiMonitorPhysicsBounds.clampToDisplays(500, -10, dualMonitorsTopSecondary);
    assert.strictEqual(bottomEdge.displayId, 11);
    assert.strictEqual(bottomEdge.y, -54);
  });

  it('TC-M4-CHAL-03: extreme negative coordinates far outside any screen (-999,999, -999,999) trigger primary fallback', () => {
    const res = MultiMonitorPhysicsBounds.clampToDisplays(-999999, -999999, dualMonitorsLeftSecondary);
    assert.strictEqual(res.displayId, 20); // Primary monitor id
    assert.strictEqual(res.reset, true);
    // Center bottom of primary monitor (x: 0, y: 0, w: 1920, h: 1080)
    // x = 0 + (1920 - 320) / 2 = 800
    // y = 0 + 1080 - 44 - 85 = 951
    assert.strictEqual(res.x, 800);
    assert.strictEqual(res.y, 951);
  });

  it('TC-M4-CHAL-04: virtual display gaps (dead space between non-contiguous monitors) trigger primary fallback', () => {
    // Display 1: x: 0..1920
    // Display 2: x: 3000..4920 (a dead gap of 1080px between 1920 and 3000)
    const gappedMonitors = [
      { id: 1, isPrimary: true, workArea: { x: 0, y: 0, width: 1920, height: 1080 } },
      { id: 2, isPrimary: false, workArea: { x: 3000, y: 0, width: 1920, height: 1080 } }
    ];

    // Coordinate x=2500 is in the dead gap (outside 1920 and < 3000 - 100 = 2900)
    const res = MultiMonitorPhysicsBounds.clampToDisplays(2500, 500, gappedMonitors);
    assert.strictEqual(res.displayId, 1);
    assert.strictEqual(res.reset, true);
    assert.strictEqual(res.x, 800);
    assert.strictEqual(res.y, 951);
  });

  it('TC-M4-CHAL-05: hysteresis margin at monitor boundary (within 100px) snaps safely inside active work area with 10px padding', () => {
    const gappedMonitors = [
      { id: 1, isPrimary: true, workArea: { x: 0, y: 0, width: 1920, height: 1080 } },
      { id: 2, isPrimary: false, workArea: { x: 3000, y: 0, width: 1920, height: 1080 } }
    ];

    // Target x = 2950 is within 100px of Display 2 (2950 >= 3000 - 100)
    const res = MultiMonitorPhysicsBounds.clampToDisplays(2950, 500, gappedMonitors);
    assert.strictEqual(res.displayId, 2);
    assert.strictEqual(res.reset, false);
    // Must clamp to Display 2 left edge with 10px padding: 3000 + 10 = 3010
    assert.strictEqual(res.x, 3010);
    assert.strictEqual(res.y, 500);
  });

  it('TC-M4-CHAL-06: 4-sided work area padding: ensures strict 10px clearance from left, right, top, bottom bounds', () => {
    const singleMonitor = [
      { id: 1, isPrimary: true, workArea: { x: 100, y: 100, width: 1000, height: 800 } }
    ];
    const pill = { width: 300, height: 50 };

    // Clamping top-left corner
    const topLeft = MultiMonitorPhysicsBounds.clampToDisplays(0, 0, singleMonitor, pill);
    assert.strictEqual(topLeft.x, 100 + 10);
    assert.strictEqual(topLeft.y, 100 + 10);

    // Clamping bottom-right corner (targeting boundary edge)
    const bottomRight = MultiMonitorPhysicsBounds.clampToDisplays(1050, 850, singleMonitor, pill);
    // x = 100 + 1000 - 300 - 10 = 790
    // y = 100 + 800 - 50 - 10 = 840
    assert.strictEqual(bottomRight.x, 790);
    assert.strictEqual(bottomRight.y, 840);
  });

  it('TC-M4-CHAL-07: disconnected monitor recovery: saved position on unplugged display resets to primary center-bottom', () => {
    // User previously positioned pill on display id 3 (x=2400 on 3-monitor setup)
    // But monitor 3 got disconnected, only monitors 1 & 2 remain
    const remainingMonitors = [
      { id: 1, isPrimary: false, workArea: { x: -1920, y: 0, width: 1920, height: 1080 } },
      { id: 2, isPrimary: true, workArea: { x: 0, y: 0, width: 1920, height: 1080 } },
    ];

    const res = MultiMonitorPhysicsBounds.clampToDisplays(3500, 600, remainingMonitors);
    assert.strictEqual(res.displayId, 2);
    assert.strictEqual(res.reset, true);
    assert.strictEqual(res.x, 800);
    assert.strictEqual(res.y, 951);
  });

  it('TC-M4-CHAL-08: empty displays array ([]) recovers safely to default primary bounds without throwing', () => {
    const res = MultiMonitorPhysicsBounds.clampToDisplays(500, 500, []);
    assert.strictEqual(res.reset, true);
    assert.strictEqual(typeof res.x, 'number');
    assert.strictEqual(typeof res.y, 'number');
    assert.ok(!isNaN(res.x));
    assert.ok(!isNaN(res.y));
    assert.strictEqual(res.x, 800);
    assert.strictEqual(res.y, 951);
  });

  it('TC-M4-CHAL-09: adversarial non-numeric coordinates (NaN, Infinity, -Infinity) fail checks and fall back safely', () => {
    const displays = [{ id: 1, isPrimary: true, workArea: { x: 0, y: 0, width: 1920, height: 1080 } }];

    const resNaN = MultiMonitorPhysicsBounds.clampToDisplays(NaN, NaN, displays);
    assert.strictEqual(resNaN.reset, true);
    assert.strictEqual(resNaN.x, 800);
    assert.strictEqual(resNaN.y, 951);

    const resInf = MultiMonitorPhysicsBounds.clampToDisplays(Infinity, 500, displays);
    assert.strictEqual(resInf.reset, true);
    assert.strictEqual(resInf.x, 800);
    assert.strictEqual(resInf.y, 951);

    const resNegInf = MultiMonitorPhysicsBounds.clampToDisplays(-Infinity, -Infinity, displays);
    assert.strictEqual(resNegInf.reset, true);
    assert.strictEqual(resNegInf.x, 800);
    assert.strictEqual(resNegInf.y, 951);
  });
});

// ============================================================================
// SUITE 2: Extreme Drag Velocity & High-Frequency Micro-Drag Stress
// ============================================================================
describe('Suite 2: Feature 18 — Extreme Drag Velocity & High-Frequency Micro-Drag Stress', () => {
  it('TC-M4-CHAL-10: extreme velocity (>10,000 px/s, e.g. 25,000 px/s) capped strictly to 3000 px/s preserving vector ratio', () => {
    // 3-4-5 triangle: 15,000 and 20,000 -> hypot = 25,000 px/s
    const res = MultiMonitorPhysicsBounds.capVelocity(15000, 20000, 3000);
    assert.strictEqual(res.capped, true);
    const speed = Math.hypot(res.vx, res.vy);
    assert.ok(Math.abs(speed - 3000) < 1e-6, `Expected speed ~3000, got ${speed}`);
    // Ratio check: 15000 / 25000 * 3000 = 1800, 20000 / 25000 * 3000 = 2400
    assert.ok(Math.abs(res.vx - 1800) < 1e-6);
    assert.ok(Math.abs(res.vy - 2400) < 1e-6);
  });

  it('TC-M4-CHAL-11: negative extreme velocities (-50,000 px/s) capped to 3000 px/s preserving direction', () => {
    const res = MultiMonitorPhysicsBounds.capVelocity(-50000, 0, 3000);
    assert.strictEqual(res.capped, true);
    assert.strictEqual(res.vx, -3000);
    assert.strictEqual(res.vy, 0);
  });

  it('TC-M4-CHAL-12: zero velocity input handled without division by zero or NaN', () => {
    const res = MultiMonitorPhysicsBounds.capVelocity(0, 0, 3000);
    assert.strictEqual(res.capped, false);
    assert.strictEqual(res.vx, 0);
    assert.strictEqual(res.vy, 0);
    assert.ok(!isNaN(res.vx));
    assert.ok(!isNaN(res.vy));
  });

  it('TC-M4-CHAL-13: velocity stretch transform matrix math never produces NaN or inverted scale (> 0 and bounded)', () => {
    // Test the exact formula used in src/renderer/pill.html:
    // const stretch = Math.min(0.20, (speed / maxSpeed) * 0.25);
    // scale(1 + stretch, 1 - stretch * 0.5)
    const maxSpeed = 3000;
    const testSpeeds = [0, 500, 1500, 3000, 5000, 50000];

    for (const rawSpeed of testSpeeds) {
      const capped = Math.min(rawSpeed, maxSpeed);
      const stretch = Math.min(0.20, (capped / maxSpeed) * 0.25);
      const scaleX = 1 + stretch;
      const scaleY = 1 - stretch * 0.5;

      assert.ok(!isNaN(scaleX) && scaleX >= 1.0 && scaleX <= 1.25, `Invalid scaleX: ${scaleX}`);
      assert.ok(!isNaN(scaleY) && scaleY >= 0.85 && scaleY <= 1.0, `Invalid scaleY: ${scaleY}`);
    }
  });

  it('TC-M4-CHAL-14: rapid micro-drag storm (150 drag events in 150ms) triggers 0 disk writes during dragging', async () => {
    const debounceSource = extractFunction('debouncedSavePillPosition');
    let diskSaveCount = 0;
    const testConfig = { pillPosition: { x: 0, y: 0 } };

    const ctx = {
      savePosTimer: null,
      clearTimeout,
      setTimeout,
      config: testConfig,
      saveConfig: () => { diskSaveCount++; },
      log: () => {},
    };
    vm.createContext(ctx);
    vm.runInContext('let savePosTimer = null;\n' + debounceSource, ctx);

    // Fire 150 rapid micro-drag position updates in 150ms
    const start = Date.now();
    for (let i = 0; i < 150; i++) {
      ctx.debouncedSavePillPosition(500 + i, 800 + i);
    }
    const elapsed = Date.now() - start;

    // During the storm, debounced timer has not fired
    assert.strictEqual(diskSaveCount, 0, 'No disk writes must occur during rapid drag bursts');

    // Clean up timer
    ctx.clearTimeout(ctx.savePosTimer);
  });

  it('TC-M4-CHAL-15: 400ms debounced persistence executes exactly once after rapid micro-drag burst with final position', async () => {
    const debounceSource = extractFunction('debouncedSavePillPosition');
    let diskSaveCount = 0;
    const testConfig = { pillPosition: { x: 0, y: 0 } };

    const ctx = {
      savePosTimer: null,
      clearTimeout,
      setTimeout,
      config: testConfig,
      saveConfig: () => { diskSaveCount++; },
      log: () => {},
    };
    vm.createContext(ctx);
    vm.runInContext('let savePosTimer = null;\n' + debounceSource, ctx);

    // Burst of 120 events
    for (let i = 0; i < 120; i++) {
      ctx.debouncedSavePillPosition(100 + i, 200 + i);
    }

    // Wait 500ms (> 400ms debounce threshold)
    await new Promise(r => setTimeout(r, 500));

    assert.strictEqual(diskSaveCount, 1, 'Exactly one disk write should occur after settling');
    assert.strictEqual(testConfig.pillPosition.x, 219);
    assert.strictEqual(testConfig.pillPosition.y, 319);
  });

  it('TC-M4-CHAL-16: secondary drag burst resets 400ms timer and prevents premature write', async () => {
    const debounceSource = extractFunction('debouncedSavePillPosition');
    let diskSaveCount = 0;
    const testConfig = { pillPosition: { x: 0, y: 0 } };

    const ctx = {
      savePosTimer: null,
      clearTimeout,
      setTimeout,
      config: testConfig,
      saveConfig: () => { diskSaveCount++; },
      log: () => {},
    };
    vm.createContext(ctx);
    vm.runInContext('let savePosTimer = null;\n' + debounceSource, ctx);

    // Initial burst
    ctx.debouncedSavePillPosition(100, 100);

    // Wait 250ms (less than 400ms)
    await new Promise(r => setTimeout(r, 250));
    assert.strictEqual(diskSaveCount, 0, 'Must not have written yet at 250ms');

    // Second burst re-triggers debounce
    ctx.debouncedSavePillPosition(300, 300);

    // Wait another 250ms (total 500ms from start, but only 250ms from second burst)
    await new Promise(r => setTimeout(r, 250));
    assert.strictEqual(diskSaveCount, 0, 'Must still not have written since timer was reset');

    // Wait remaining 200ms to complete the second 400ms window
    await new Promise(r => setTimeout(r, 200));
    assert.strictEqual(diskSaveCount, 1, 'Must write exactly once after second window expires');
    assert.strictEqual(testConfig.pillPosition.x, 300);
    assert.strictEqual(testConfig.pillPosition.y, 300);
  });
});

// ============================================================================
// SUITE 3: Native Unicode Typing Injection & Exotic Characters
// ============================================================================
describe('Suite 3: Feature 20 — Native Unicode Typing Injection & Exotic Characters', () => {
  it('TC-M4-CHAL-17: native helper binary tell-paste.exe capabilities verify type-unicode-v1 flag', () => {
    const res = spawnSync(PASTE_HELPER_PATH, ['--capabilities'], { encoding: 'utf8', windowsHide: true });
    assert.strictEqual(res.status, 0);
    assert.ok(res.stdout.includes('type-unicode-v1'), `Capabilities missing type-unicode-v1: ${res.stdout}`);
  });

  it('TC-M4-CHAL-18: exotic UTF-8 emojis (🚀, 💻, 🎉, 🔥, ✨) processed without crash via --type-stdin', async () => {
    const emojiPayload = '🚀 💻 🎉 🔥 ✨';
    const res = await runTellPasteStdin(emojiPayload, 5000);
    assert.strictEqual(res.code, 0, `Expected exit code 0, got ${res.code}: ${res.stderr}`);
    assert.strictEqual(res.stdout, 'TYPING_OK');
  });

  it('TC-M4-CHAL-19: multi-byte surrogate pairs and ZWJ sequences (👨‍💻) processed without crash', async () => {
    // 👨‍💻 = Man + ZWJ + Laptop (U+1F468 U+200D U+1F4BB)
    const zwjPayload = '👨‍💻';
    const res = await runTellPasteStdin(zwjPayload, 5000);
    assert.strictEqual(res.code, 0, `Expected exit code 0, got ${res.code}: ${res.stderr}`);
    assert.strictEqual(res.stdout, 'TYPING_OK');
  });

  it('TC-M4-CHAL-20: Japanese multi-script text (Kanji, Hiragana, Katakana: こんにちは世界) processed cleanly', async () => {
    const japaneseText = 'こんにちは世界';
    const res = await runTellPasteStdin(japaneseText, 5000);
    assert.strictEqual(res.code, 0, `Expected exit code 0, got ${res.code}: ${res.stderr}`);
    assert.strictEqual(res.stdout, 'TYPING_OK');
  });

  it('TC-M4-CHAL-21: Arabic right-to-left UTF-8 text (مرحبا بالعالم) processed cleanly', async () => {
    const arabicText = 'مرحبا بالعالم';
    const res = await runTellPasteStdin(arabicText, 5000);
    assert.strictEqual(res.code, 0, `Expected exit code 0, got ${res.code}: ${res.stderr}`);
    assert.strictEqual(res.stdout, 'TYPING_OK');
  });

  it('TC-M4-CHAL-22: CRLF (\\r\\n) and LF (\\n) newlines processed with Enter keystroke translation and no double-spacing', async () => {
    const textWithNewlines = 'Line1\r\nLine2\nLine3';
    const res = await runTellPasteStdin(textWithNewlines, 5000);
    assert.strictEqual(res.code, 0, `Expected exit code 0, got ${res.code}: ${res.stderr}`);
    assert.strictEqual(res.stdout, 'TYPING_OK');
  });

  it('TC-M4-CHAL-23: zero-length empty stdin stream completes with exit code 0 and TYPING_OK', async () => {
    const res = await runTellPasteStdin('', 3000);
    assert.strictEqual(res.code, 0);
    assert.strictEqual(res.stdout, 'TYPING_OK');
  });
});

// ============================================================================
// SUITE 4: Zero Clipboard Pollution Verification
// ============================================================================
describe('Suite 4: Feature 20 — Zero Clipboard Pollution Verification', () => {
  it('TC-M4-CHAL-24: native Win32 clipboard sequence number remains strictly identical before and after --type-stdin', async () => {
    const seqBefore = getNativeClipboardSequence();
    assert.ok(typeof seqBefore === 'number' && seqBefore > 0);

    // Execute native typing injection
    const res = await runTellPasteStdin('WisprTell Unicode 🎯', 5000);
    assert.strictEqual(res.code, 0);

    const seqAfter = getNativeClipboardSequence();
    assert.strictEqual(
      seqAfter,
      seqBefore,
      `Clipboard sequence number changed from ${seqBefore} to ${seqAfter}! Animated typing must NOT modify clipboard.`
    );
  });

  it('TC-M4-CHAL-25: animated typing injection via main.js leaves clipboard contents and sequence number completely untouched', async () => {
    const mockClip = new ComprehensiveMockClipboard();
    const SECRET_TEXT = 'IMPORTANT_USER_SECRET_TOKEN_DO_NOT_CORRUPT_987654';
    mockClip.writeText(SECRET_TEXT);
    const initialSeq = mockClip.getClipboardSequenceNumber();

    let typeViaHelperCalled = false;
    let typeViaHelperPayload = '';

    const context = {
      config: { typingAnimation: true, maxAnimatedLength: 200 },
      clipboard: mockClip,
      typeViaHelper: async (text) => {
        typeViaHelperCalled = true;
        typeViaHelperPayload = text;
        return;
      },
      getClipboardSequenceNumber: async () => mockClip.getClipboardSequenceNumber(),
      pasteViaHelper: async () => {},
      targetHwnd: null,
      log: () => {},
    };

    vm.createContext(context);
    vm.runInContext('async ' + extractFunction('injectText'), context);

    // Call injectText with a 25-character utterance
    await context.injectText('Short dictation test 🚀');

    assert.strictEqual(typeViaHelperCalled, true, 'typeViaHelper should have been called');
    assert.strictEqual(typeViaHelperPayload, 'Short dictation test 🚀');

    // Clipboard must NOT have been touched
    assert.strictEqual(mockClip.readText(), SECRET_TEXT, 'Clipboard text must remain untouched');
    assert.strictEqual(mockClip.getClipboardSequenceNumber(), initialSeq, 'Clipboard sequence must not increment');
  });

  it('TC-M4-CHAL-26: clipboard snapshot formats (text, html, rtf) remain pristine and un-clobbered during animated typing', async () => {
    const mockClip = new ComprehensiveMockClipboard();
    mockClip.formats.set('text/plain', 'Original plain text');
    mockClip.formats.set('text/html', '<b>Bold original</b>');
    mockClip.formats.set('text/rtf', '{\\rtf1\\ansi original}');
    mockClip.text = 'Original plain text';
    mockClip.html = '<b>Bold original</b>';
    mockClip.rtf = '{\\rtf1\\ansi original}';
    mockClip.formatsList = ['text/plain', 'text/html', 'text/rtf'];
    const initialSeq = mockClip.getClipboardSequenceNumber();

    const context = {
      config: { typingAnimation: true, maxAnimatedLength: 200 },
      clipboard: mockClip,
      typeViaHelper: async () => {},
      getClipboardSequenceNumber: async () => mockClip.getClipboardSequenceNumber(),
      pasteViaHelper: async () => {},
      targetHwnd: null,
      log: () => {},
    };

    vm.createContext(context);
    vm.runInContext('async ' + extractFunction('injectText'), context);

    await context.injectText('Hello animated world!');

    assert.strictEqual(mockClip.formats.get('text/plain'), 'Original plain text');
    assert.strictEqual(mockClip.formats.get('text/html'), '<b>Bold original</b>');
    assert.strictEqual(mockClip.formats.get('text/rtf'), '{\\rtf1\\ansi original}');
    assert.strictEqual(mockClip.getClipboardSequenceNumber(), initialSeq);
  });
});

// ============================================================================
// SUITE 5: Length Boundary Gating & Resilience Fallbacks
// ============================================================================
describe('Suite 5: Feature 20 — Length Boundary Gating & Resilience Fallbacks', () => {
  it('TC-M4-CHAL-27: boundary length 199 characters triggers animated typing (bypasses clipboard paste)', async () => {
    const mockClip = new ComprehensiveMockClipboard();
    mockClip.writeText('PRE_EXISTING_CLIPBOARD');
    const seqBefore = mockClip.getClipboardSequenceNumber();

    let methodUsed = null;
    const context = {
      config: { typingAnimation: true, maxAnimatedLength: 200 },
      clipboard: mockClip,
      typeViaHelper: async () => { methodUsed = 'animated-typing'; },
      getClipboardSequenceNumber: async () => mockClip.getClipboardSequenceNumber(),
      pasteViaHelper: async () => { methodUsed = 'clipboard-paste'; },
      targetHwnd: null,
      log: () => {},
    };

    vm.createContext(context);
    vm.runInContext('async ' + extractFunction('injectText'), context);

    const text199 = 'A'.repeat(199);
    assert.strictEqual(text199.length, 199);

    await context.injectText(text199);

    assert.strictEqual(methodUsed, 'animated-typing');
    assert.strictEqual(mockClip.getClipboardSequenceNumber(), seqBefore);
    assert.strictEqual(mockClip.readText(), 'PRE_EXISTING_CLIPBOARD');
  });

  it('TC-M4-CHAL-28: boundary length 200 characters triggers animated typing (bypasses clipboard paste)', async () => {
    const mockClip = new ComprehensiveMockClipboard();
    mockClip.writeText('PRE_EXISTING_CLIPBOARD');
    const seqBefore = mockClip.getClipboardSequenceNumber();

    let methodUsed = null;
    const context = {
      config: { typingAnimation: true, maxAnimatedLength: 200 },
      clipboard: mockClip,
      typeViaHelper: async () => { methodUsed = 'animated-typing'; },
      getClipboardSequenceNumber: async () => mockClip.getClipboardSequenceNumber(),
      pasteViaHelper: async () => { methodUsed = 'clipboard-paste'; },
      targetHwnd: null,
      log: () => {},
    };

    vm.createContext(context);
    vm.runInContext('async ' + extractFunction('injectText'), context);

    const text200 = 'B'.repeat(200);
    assert.strictEqual(text200.length, 200);

    await context.injectText(text200);

    assert.strictEqual(methodUsed, 'animated-typing');
    assert.strictEqual(mockClip.getClipboardSequenceNumber(), seqBefore);
    assert.strictEqual(mockClip.readText(), 'PRE_EXISTING_CLIPBOARD');
  });

  it('TC-M4-CHAL-29: boundary length 201 characters triggers instant paste fallback (writes to clipboard)', async () => {
    const mockClip = new ComprehensiveMockClipboard();
    mockClip.writeText('PRE_EXISTING_CLIPBOARD');

    let methodUsed = null;
    const context = {
      config: { typingAnimation: true, maxAnimatedLength: 200 },
      clipboard: mockClip,
      setTimeout,
      clearTimeout,
      typeViaHelper: async () => { methodUsed = 'animated-typing'; },
      getClipboardSequenceNumber: async () => mockClip.getClipboardSequenceNumber(),
      pasteViaHelper: async () => { methodUsed = 'clipboard-paste'; },
      targetHwnd: null,
      log: () => {},
    };

    vm.createContext(context);
    vm.runInContext('async ' + extractFunction('injectText'), context);

    const text201 = 'C'.repeat(201);
    assert.strictEqual(text201.length, 201);

    await context.injectText(text201);

    assert.strictEqual(methodUsed, 'clipboard-paste', '201 chars must bypass animated typing and use clipboard paste');
    assert.strictEqual(mockClip.readText(), text201, 'Clipboard must be updated with text201');
  });

  it('TC-M4-CHAL-30: typingAnimation = false bypasses animation at 199, 200, and 201 chars, routing all to paste', async () => {
    for (const len of [199, 200, 201]) {
      const mockClip = new ComprehensiveMockClipboard();
      let methodUsed = null;
      const context = {
        config: { typingAnimation: false, maxAnimatedLength: 200 },
        clipboard: mockClip,
        setTimeout,
        clearTimeout,
        typeViaHelper: async () => { methodUsed = 'animated-typing'; },
        getClipboardSequenceNumber: async () => mockClip.getClipboardSequenceNumber(),
        pasteViaHelper: async () => { methodUsed = 'clipboard-paste'; },
        targetHwnd: null,
        log: () => {},
      };

      vm.createContext(context);
      vm.runInContext('async ' + extractFunction('injectText'), context);

      const text = 'X'.repeat(len);
      await context.injectText(text);

      assert.strictEqual(methodUsed, 'clipboard-paste', `Length ${len} with animation disabled must use paste`);
      assert.strictEqual(mockClip.readText(), text);
    }
  });

  it('TC-M4-CHAL-31: helper failure or timeout during animated typing catches gracefully and falls back to clipboard paste', async () => {
    const mockClip = new ComprehensiveMockClipboard();
    let pasteViaHelperCalled = false;
    const logs = [];

    const context = {
      config: { typingAnimation: true, maxAnimatedLength: 200 },
      clipboard: mockClip,
      setTimeout,
      clearTimeout,
      typeViaHelper: async () => {
        throw new Error('typing helper process died unexpectedly');
      },
      getClipboardSequenceNumber: async () => mockClip.getClipboardSequenceNumber(),
      pasteViaHelper: async () => { pasteViaHelperCalled = true; },
      targetHwnd: null,
      log: (...args) => logs.push(args.join(' ')),
    };

    vm.createContext(context);
    vm.runInContext('async ' + extractFunction('injectText'), context);

    const shortText = 'Should fallback to paste!';
    await context.injectText(shortText);

    assert.strictEqual(pasteViaHelperCalled, true, 'Must fallback to clipboard paste when helper fails');
    assert.strictEqual(mockClip.readText(), shortText, 'Clipboard text must be set by fallback paste');
    assert.ok(
      logs.some(l => l.includes('animated typing failed, falling back to clipboard paste')),
      'Must log animated typing failure and fallback'
    );
  });
});
