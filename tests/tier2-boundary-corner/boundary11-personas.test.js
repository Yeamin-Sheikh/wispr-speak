// Tier 2 - Boundary 11: LLM Prompt Personas Boundary Cases
const { describe, it } = require('node:test');
const assert = require('node:assert');

class PersonaValidator {
  static validateAndSanitize(persona, existingPersonas = []) {
    if (!persona || typeof persona !== 'object') {
      throw new Error('Invalid persona payload');
    }
    const name = String(persona.name || '').trim();
    if (!name) throw new Error('Persona name cannot be empty');

    const systemPrompt = String(persona.systemPrompt || '').trim();
    if (!systemPrompt) throw new Error('Persona system prompt cannot be empty');

    const id = String(persona.id || name.toLowerCase().replace(/[^a-z0-9_]/g, '_'));
    if (existingPersonas.some(p => p.id === id)) {
      throw new Error(`Duplicate persona ID: ${id}`);
    }

    // Temperature clamp [0.0, 1.0]
    let temp = Number(persona.temperature ?? 0.3);
    if (isNaN(temp)) temp = 0.3;
    temp = Math.max(0.0, Math.min(1.0, temp));

    // Prompt length ceiling (e.g. 4000 chars)
    const sanitizedPrompt = systemPrompt.length > 4000 ? systemPrompt.substring(0, 4000) : systemPrompt;

    return {
      id,
      name,
      systemPrompt: sanitizedPrompt,
      temperature: temp,
      isDefault: false
    };
  }
}

describe('Tier 2 - Boundary 11: LLM Prompt Personas Boundary Cases', () => {
  it('TC-T2-B11-01: clamps out-of-range temperature values to [0.0, 1.0]', () => {
    const tooHigh = PersonaValidator.validateAndSanitize({ name: 'Hot', systemPrompt: 'Test', temperature: 2.5 });
    assert.strictEqual(tooHigh.temperature, 1.0);

    const tooLow = PersonaValidator.validateAndSanitize({ name: 'Cold', systemPrompt: 'Test', temperature: -1.0 });
    assert.strictEqual(tooLow.temperature, 0.0);
  });

  it('TC-T2-B11-02: truncates oversized system prompt (>4000 characters) safely', () => {
    const hugePrompt = 'A'.repeat(5000);
    const result = PersonaValidator.validateAndSanitize({ name: 'Long', systemPrompt: hugePrompt });
    assert.strictEqual(result.systemPrompt.length, 4000);
  });

  it('TC-T2-B11-03: rejects persona with empty name or empty prompt', () => {
    assert.throws(() => PersonaValidator.validateAndSanitize({ name: '', systemPrompt: 'valid' }), /name cannot be empty/);
    assert.throws(() => PersonaValidator.validateAndSanitize({ name: 'valid', systemPrompt: '' }), /prompt cannot be empty/);
  });

  it('TC-T2-B11-04: rejects duplicate persona IDs', () => {
    const existing = [{ id: 'custom_id', name: 'Existing' }];
    assert.throws(() => {
      PersonaValidator.validateAndSanitize({ id: 'custom_id', name: 'Duplicate', systemPrompt: 'Test' }, existing);
    }, /Duplicate persona ID/);
  });

  it('TC-T2-B11-05: prevents deletion of default persona', () => {
    function deletePersonaSafe(personas, id) {
      const p = personas.find(item => item.id === id);
      if (!p) throw new Error('Not found');
      if (p.isDefault) throw new Error('Cannot delete default persona');
      return personas.filter(item => item.id !== id);
    }

    const personas = [{ id: 'natural', name: 'Natural', isDefault: true }];
    assert.throws(() => deletePersonaSafe(personas, 'natural'), /Cannot delete default persona/);
  });
});
