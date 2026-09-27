// Tier 2 - Boundary 13: Interactive Onboarding Flow Boundary Cases
const { describe, it } = require('node:test');
const assert = require('node:assert');

class OnboardingEdgeHandler {
  static sanitizeApiKey(rawKey) {
    if (!rawKey) return '';
    return String(rawKey).trim().replace(/[\r\n\t]/g, '');
  }

  static handleMicError(permissionState, devices) {
    if (permissionState === 'denied') {
      return { allowed: false, message: 'Microphone permission denied by Windows system settings' };
    }
    if (!devices || devices.length === 0) {
      return { allowed: false, message: 'No microphone input devices detected' };
    }
    return { allowed: true };
  }

  static preserveUserDataOnRerun(existingConfig) {
    // Re-running onboarding should NOT wipe dictionary or history
    const pristineDict = existingConfig.dictionary || [];
    const pristinePersonas = existingConfig.personas || [];
    return {
      firstRun: false,
      dictionary: pristineDict,
      personas: pristinePersonas
    };
  }
}

describe('Tier 2 - Boundary 13: Interactive Onboarding Flow Boundary Cases', () => {
  it('TC-T2-B13-01: trims whitespace, newlines, and carriage returns from pasted API keys', () => {
    const dirtyKey = '  \n gsk_1234567890abcdef \r\n ';
    const cleanKey = OnboardingEdgeHandler.sanitizeApiKey(dirtyKey);
    assert.strictEqual(cleanKey, 'gsk_1234567890abcdef');
  });

  it('TC-T2-B13-02: returns descriptive error when OS microphone permission is denied', () => {
    const res = OnboardingEdgeHandler.handleMicError('denied', ['default-mic']);
    assert.strictEqual(res.allowed, false);
    assert.ok(res.message.includes('permission denied'));
  });

  it('TC-T2-B13-03: returns descriptive error when no audio input devices are connected', () => {
    const res = OnboardingEdgeHandler.handleMicError('granted', []);
    assert.strictEqual(res.allowed, false);
    assert.ok(res.message.includes('No microphone input devices'));
  });

  it('TC-T2-B13-04: preserves existing dictionary terms when onboarding wizard is re-run', () => {
    const existingConfig = {
      firstRun: false,
      dictionary: [{ from: 'customTerm', to: 'Custom Term' }]
    };
    const updated = OnboardingEdgeHandler.preserveUserDataOnRerun(existingConfig);
    assert.strictEqual(updated.dictionary.length, 1);
    assert.strictEqual(updated.dictionary[0].from, 'customTerm');
  });

  it('TC-T2-B13-05: preserves custom personas when onboarding is re-run', () => {
    const existingConfig = {
      firstRun: false,
      personas: [{ id: 'my_persona', name: 'My Persona' }]
    };
    const updated = OnboardingEdgeHandler.preserveUserDataOnRerun(existingConfig);
    assert.strictEqual(updated.personas.length, 1);
    assert.strictEqual(updated.personas[0].id, 'my_persona');
  });
});
