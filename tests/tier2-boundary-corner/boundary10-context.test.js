// Tier 2 - Boundary 10: Context-Aware Smart Polish Boundary Cases
const { describe, it } = require('node:test');
const assert = require('node:assert');

function classifyTargetWindowRobust(target) {
  if (!target) return { category: 'general', persona: 'Natural' };

  const exe = String(target.exe || '').toLowerCase().trim();
  const title = String(target.title || '').toLowerCase().trim();

  if (!exe && !title) return { category: 'general', persona: 'Natural' };

  if (/code\.exe|cursor\.exe|devenv\.exe/.test(exe)) {
    return { category: 'code', persona: 'Code' };
  }
  if (/slack\.exe|discord\.exe/.test(exe)) {
    return { category: 'chat', persona: 'Natural' };
  }
  if (/outlook\.exe|winword\.exe/.test(exe)) {
    return { category: 'formal', persona: 'Formal' };
  }

  return { category: 'general', persona: 'Natural' };
}

describe('Tier 2 - Boundary 10: Context-Aware Smart Polish Boundary Cases', () => {
  it('TC-T2-B10-01: handles null or undefined window target gracefully with fallback', () => {
    const res = classifyTargetWindowRobust(null);
    assert.strictEqual(res.category, 'general');
    assert.strictEqual(res.persona, 'Natural');
  });

  it('TC-T2-B10-02: handles empty title and empty exe name safely', () => {
    const res = classifyTargetWindowRobust({ exe: '', title: '' });
    assert.strictEqual(res.category, 'general');
  });

  it('TC-T2-B10-03: matches executable name regardless of mixed casing (e.g. CoDe.ExE)', () => {
    const res = classifyTargetWindowRobust({ exe: 'cOdE.ExE', title: 'Editor' });
    assert.strictEqual(res.category, 'code');
  });

  it('TC-T2-B10-04: safely handles titles containing injection strings or special characters', () => {
    const maliciousTitle = "test.js'; DROP TABLE users; -- <script>alert(1)</script>";
    assert.doesNotThrow(() => {
      const res = classifyTargetWindowRobust({ exe: 'Code.exe', title: maliciousTitle });
      assert.strictEqual(res.category, 'code');
    });
  });

  it('TC-T2-B10-05: handles window title containing unicode and non-ASCII characters', () => {
    const unicodeTitle = 'Проект - Wispr Tell (開発)';
    assert.doesNotThrow(() => {
      const res = classifyTargetWindowRobust({ exe: 'unknown.exe', title: unicodeTitle });
      assert.strictEqual(res.category, 'general');
    });
  });
});
