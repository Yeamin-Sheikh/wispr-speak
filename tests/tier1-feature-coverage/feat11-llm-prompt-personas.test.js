// Tier 1 - Feature 11: Customizable LLM Prompt Personas
// Verifies persona presets, custom persona CRUD operations, active selection, and system prompt formatting.
const { describe, it } = require('node:test');
const assert = require('node:assert');

class PersonaManager {
  constructor(initialPersonas = null) {
    this.personas = initialPersonas || [
      { id: 'natural', name: 'Natural', systemPrompt: 'Clean grammar while keeping spoken rhythm.', temperature: 0.3, isDefault: true },
      { id: 'formal', name: 'Formal', systemPrompt: 'Rewrite into professional, formal prose.', temperature: 0.2, isDefault: false },
      { id: 'code', name: 'Code', systemPrompt: 'Preserve code syntax, casing, and programming terms.', temperature: 0.1, isDefault: false },
      { id: 'minimal', name: 'Minimal', systemPrompt: 'Only fix obvious spelling mistakes, do not reword.', temperature: 0.0, isDefault: false }
    ];
    this.activePersonaId = 'natural';
  }

  getActivePersona() {
    return this.personas.find(p => p.id === this.activePersonaId) || this.personas[0];
  }

  setActivePersona(id) {
    if (!this.personas.some(p => p.id === id)) {
      throw new Error(`Persona '${id}' not found`);
    }
    this.activePersonaId = id;
    return this.getActivePersona();
  }

  addCustomPersona(persona) {
    if (!persona.name || !persona.systemPrompt) {
      throw new Error('Persona must have a name and system prompt');
    }
    const id = persona.id || 'custom_' + Date.now();
    const newPersona = {
      id,
      name: persona.name,
      systemPrompt: persona.systemPrompt,
      temperature: Math.max(0.0, Math.min(1.0, persona.temperature ?? 0.3)),
      isDefault: false
    };
    this.personas.push(newPersona);
    return newPersona;
  }

  updatePersona(id, updates) {
    const p = this.personas.find(item => item.id === id);
    if (!p) throw new Error(`Persona '${id}' not found`);
    if (updates.name) p.name = updates.name;
    if (updates.systemPrompt) p.systemPrompt = updates.systemPrompt;
    if (updates.temperature !== undefined) p.temperature = Math.max(0.0, Math.min(1.0, updates.temperature));
    return p;
  }

  deletePersona(id) {
    const index = this.personas.findIndex(p => p.id === id);
    if (index === -1) throw new Error(`Persona '${id}' not found`);
    if (this.personas[index].isDefault) {
      throw new Error('Cannot delete default persona');
    }
    const removed = this.personas.splice(index, 1)[0];
    if (this.activePersonaId === id) {
      this.activePersonaId = 'natural';
    }
    return removed;
  }
}

describe('Tier 1 - Feature 11: Customizable LLM Prompt Personas', () => {
  it('TC-T1-F11-01: initializes with 4 default presets (Natural, Formal, Code, Minimal)', () => {
    const pm = new PersonaManager();
    const presets = pm.personas.map(p => p.id);
    assert.deepStrictEqual(presets, ['natural', 'formal', 'code', 'minimal']);
    assert.strictEqual(pm.getActivePersona().name, 'Natural');
  });

  it('TC-T1-F11-02: updates active persona and persists selection', () => {
    const pm = new PersonaManager();
    pm.setActivePersona('formal');
    assert.strictEqual(pm.getActivePersona().id, 'formal');
    assert.strictEqual(pm.getActivePersona().temperature, 0.2);
  });

  it('TC-T1-F11-03: creates custom user persona with custom instructions', () => {
    const pm = new PersonaManager();
    const created = pm.addCustomPersona({
      id: 'concise',
      name: 'Ultra Concise',
      systemPrompt: 'Strip all fluff. Output maximum 1 sentence.',
      temperature: 0.1
    });

    assert.strictEqual(created.id, 'concise');
    assert.strictEqual(pm.personas.length, 5);
    pm.setActivePersona('concise');
    assert.strictEqual(pm.getActivePersona().systemPrompt, 'Strip all fluff. Output maximum 1 sentence.');
  });

  it('TC-T1-F11-04: updates existing persona prompts and parameters', () => {
    const pm = new PersonaManager();
    pm.updatePersona('code', { temperature: 0.05, systemPrompt: 'Strict coding prompt' });
    const code = pm.personas.find(p => p.id === 'code');

    assert.strictEqual(code.temperature, 0.05);
    assert.strictEqual(code.systemPrompt, 'Strict coding prompt');
  });

  it('TC-T1-F11-05: deletes custom persona and resets active persona to default', () => {
    const pm = new PersonaManager();
    pm.addCustomPersona({ id: 'temp_p', name: 'Temporary', systemPrompt: 'Test' });
    pm.setActivePersona('temp_p');
    assert.strictEqual(pm.getActivePersona().id, 'temp_p');

    pm.deletePersona('temp_p');
    assert.strictEqual(pm.personas.some(p => p.id === 'temp_p'), false);
    assert.strictEqual(pm.getActivePersona().id, 'natural', 'Should reset active persona to default');
  });
});
