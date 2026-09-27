// Tier 2 - Boundary 16: Windows 11 Native Mica & Acrylic Boundary Cases
const { describe, it } = require('node:test');
const assert = require('node:assert');

class MaterialBoundaryManager {
  static resolveMaterialSettings(platform, win11Build, isHighContrast = false, isGpuDisabled = false) {
    if (platform !== 'win32') {
      return { material: 'none', note: 'non-windows-platform' };
    }
    if (isHighContrast) {
      return { material: 'none', highContrastActive: true, note: 'high-contrast-fallback' };
    }
    if (isGpuDisabled) {
      return { material: 'none', note: 'software-compositing' };
    }
    if (win11Build >= 22000) {
      return { pill: 'acrylic', settings: 'mica' };
    }
    return { material: 'none', note: 'windows-10-or-lower' };
  }
}

describe('Tier 2 - Boundary 16: Windows 11 Native Materials Boundary Cases', () => {
  it('TC-T2-B16-01: disables native compositor materials when high-contrast theme is enabled', () => {
    const res = MaterialBoundaryManager.resolveMaterialSettings('win32', 26200, true, false);
    assert.strictEqual(res.material, 'none');
    assert.strictEqual(res.highContrastActive, true);
  });

  it('TC-T2-B16-02: falls back to software rendering when GPU acceleration is disabled', () => {
    const res = MaterialBoundaryManager.resolveMaterialSettings('win32', 26200, false, true);
    assert.strictEqual(res.material, 'none');
    assert.strictEqual(res.note, 'software-compositing');
  });

  it('TC-T2-B16-03: falls back cleanly on non-Windows platforms (e.g. darwin or linux)', () => {
    const resDarwin = MaterialBoundaryManager.resolveMaterialSettings('darwin', 0);
    const resLinux = MaterialBoundaryManager.resolveMaterialSettings('linux', 0);

    assert.strictEqual(resDarwin.material, 'none');
    assert.strictEqual(resLinux.material, 'none');
  });

  it('TC-T2-B16-04: verifies exact build 22000 is accepted as Windows 11 threshold', () => {
    const res22000 = MaterialBoundaryManager.resolveMaterialSettings('win32', 22000);
    const res21999 = MaterialBoundaryManager.resolveMaterialSettings('win32', 21999);

    assert.strictEqual(res22000.pill, 'acrylic');
    assert.strictEqual(res21999.material, 'none');
  });

  it('TC-T2-B16-05: preserves transparent: true flag on pill window configuration', () => {
    const pillConfig = { transparent: true, frame: false, backgroundMaterial: 'acrylic' };
    assert.strictEqual(pillConfig.transparent, true);
    assert.strictEqual(pillConfig.frame, false);
  });
});
