// Tier 1 - Feature 16: Windows 11 Native Mica & Acrylic Materials
// Verifies native DWM backgroundMaterial options, OS build detection, and fallback properties.
const { describe, it } = require('node:test');
const assert = require('node:assert');
const os = require('os');

class WindowMaterialConfigurator {
  static isWindows11OrHigher(releaseString = os.release()) {
    // Windows 11 builds are 10.0.22000 or higher
    const parts = releaseString.split('.').map(Number);
    if (parts[0] > 10) return true;
    if (parts[0] === 10 && parts[1] >= 0 && parts[2] >= 22000) return true;
    return false;
  }

  static getPillWindowOptions(isWin11 = this.isWindows11OrHigher()) {
    const baseOptions = {
      width: 320,
      height: 44,
      frame: false,
      transparent: true,
      alwaysOnTop: true,
      skipTaskbar: true,
      resizable: false,
      focusable: false
    };

    if (isWin11) {
      baseOptions.backgroundMaterial = 'acrylic';
    } else {
      // Windows 10 software blur fallback
      baseOptions.backgroundColor = '#121216E6';
    }

    return baseOptions;
  }

  static getSettingsWindowOptions(isWin11 = this.isWindows11OrHigher()) {
    const baseOptions = {
      width: 1140,
      height: 760,
      minWidth: 960,
      minHeight: 640,
      titleBarStyle: 'hidden',
      frame: false
    };

    if (isWin11) {
      baseOptions.backgroundMaterial = 'mica';
    } else {
      baseOptions.backgroundColor = '#1e1e24';
    }

    return baseOptions;
  }
}

describe('Tier 1 - Feature 16: Windows 11 Native Mica & Acrylic Materials', () => {
  it('TC-T1-F16-01: detects Windows 11 build >= 22000 from OS release string', () => {
    assert.strictEqual(WindowMaterialConfigurator.isWindows11OrHigher('10.0.22000'), true);
    assert.strictEqual(WindowMaterialConfigurator.isWindows11OrHigher('10.0.26200'), true);
    assert.strictEqual(WindowMaterialConfigurator.isWindows11OrHigher('10.0.19045'), false); // Win 10 22H2
  });

  it('TC-T1-F16-02: assigns backgroundMaterial: "acrylic" to pill window on Windows 11', () => {
    const options = WindowMaterialConfigurator.getPillWindowOptions(true);
    assert.strictEqual(options.backgroundMaterial, 'acrylic');
    assert.strictEqual(options.transparent, true);
    assert.strictEqual(options.frame, false);
  });

  it('TC-T1-F16-03: assigns backgroundMaterial: "mica" to settings window on Windows 11', () => {
    const options = WindowMaterialConfigurator.getSettingsWindowOptions(true);
    assert.strictEqual(options.backgroundMaterial, 'mica');
    assert.strictEqual(options.titleBarStyle, 'hidden');
  });

  it('TC-T1-F16-04: applies software backgroundColor fallback when running on Windows 10', () => {
    const pillOptions = WindowMaterialConfigurator.getPillWindowOptions(false);
    assert.strictEqual(pillOptions.backgroundMaterial, undefined);
    assert.ok(pillOptions.backgroundColor);

    const settingsOptions = WindowMaterialConfigurator.getSettingsWindowOptions(false);
    assert.strictEqual(settingsOptions.backgroundMaterial, undefined);
    assert.ok(settingsOptions.backgroundColor);
  });

  it('TC-T1-F16-05: verifies current environment OS version and material selection', () => {
    const currentRelease = os.release();
    const isWin11 = WindowMaterialConfigurator.isWindows11OrHigher(currentRelease);
    const pill = WindowMaterialConfigurator.getPillWindowOptions(isWin11);

    if (isWin11) {
      assert.strictEqual(pill.backgroundMaterial, 'acrylic');
    } else {
      assert.strictEqual(pill.backgroundMaterial, undefined);
    }
  });
});
