// Tier 1 - Feature 18: Fluid Draggable Pill with Spring Physics
// Verifies spring dynamics equations, target coordinate tracking, screen boundary clamping, and position persistence.
const { describe, it } = require('node:test');
const assert = require('node:assert');
const { simulateSpringStep } = require('../helpers/test-harness');

class PillDragPhysicsController {
  constructor(options = {}) {
    this.x = options.initialX || 500;
    this.y = options.initialY || 800;
    this.targetX = this.x;
    this.targetY = this.y;
    this.vx = 0;
    this.vy = 0;
    this.k = options.k || 180; // spring stiffness
    this.c = options.c || 12;  // damping coefficient
    this.mass = options.mass || 1;
    this.workArea = options.workArea || { x: 0, y: 0, width: 1920, height: 1080 };
    this.pillSize = options.pillSize || { width: 320, height: 44 };
    this.isDragging = false;
  }

  startDrag() {
    this.isDragging = true;
  }

  updateDragTarget(screenX, screenY) {
    // Clamp target within work area margins (10px padding)
    const minX = this.workArea.x + 10;
    const maxX = this.workArea.x + this.workArea.width - this.pillSize.width - 10;
    const minY = this.workArea.y + 10;
    const maxY = this.workArea.y + this.workArea.height - this.pillSize.height - 10;

    this.targetX = Math.max(minX, Math.min(maxX, screenX));
    this.targetY = Math.max(minY, Math.min(maxY, screenY));
  }

  step(dt = 0.016) {
    const stepX = simulateSpringStep({
      currentX: this.x,
      velocity: this.vx,
      targetX: this.targetX,
      k: this.k,
      c: this.c,
      mass: this.mass,
      dt
    });
    this.x = stepX.x;
    this.vx = stepX.v;

    const stepY = simulateSpringStep({
      currentX: this.y,
      velocity: this.vy,
      targetX: this.targetY,
      k: this.k,
      c: this.c,
      mass: this.mass,
      dt
    });
    this.y = stepY.x;
    this.vy = stepY.v;

    return { x: this.x, y: this.y, vx: this.vx, vy: this.vy };
  }

  stopDrag() {
    this.isDragging = false;
    return {
      x: Math.round(this.targetX),
      y: Math.round(this.targetY)
    };
  }
}

describe('Tier 1 - Feature 18: Fluid Draggable Pill with Spring Physics', () => {
  it('TC-T1-F18-01: calculates spring acceleration and moves position toward target', () => {
    const controller = new PillDragPhysicsController({ initialX: 100, initialY: 100 });
    controller.updateDragTarget(200, 100);

    const step1 = controller.step(0.016);
    assert.ok(step1.x > 100, 'Position x should move toward target 200');
    assert.ok(step1.vx > 0, 'Velocity vx should accelerate forward');
  });

  it('TC-T1-F18-02: converges to target position and settles velocity over multiple steps', () => {
    const controller = new PillDragPhysicsController({ initialX: 0, initialY: 0 });
    controller.updateDragTarget(500, 300);

    // Simulate ~60 frames (1 second) of physics simulation
    for (let i = 0; i < 60; i++) {
      controller.step(0.016);
    }

    assert.ok(Math.abs(controller.x - 500) < 5, `Expected x near 500, got ${controller.x}`);
    assert.ok(Math.abs(controller.y - 300) < 5, `Expected y near 300, got ${controller.y}`);
    assert.ok(Math.abs(controller.vx) < 1, 'Velocity vx should settle near zero');
  });

  it('TC-T1-F18-03: clamps drag targets inside screen work area boundaries', () => {
    const controller = new PillDragPhysicsController({
      workArea: { x: 0, y: 0, width: 1920, height: 1080 },
      pillSize: { width: 320, height: 44 }
    });

    // Attempt to drag far off-screen to the right and bottom
    controller.updateDragTarget(5000, 5000);
    assert.strictEqual(controller.targetX, 1920 - 320 - 10);
    assert.strictEqual(controller.targetY, 1080 - 44 - 10);

    // Attempt to drag far off-screen to the left and top
    controller.updateDragTarget(-500, -500);
    assert.strictEqual(controller.targetX, 10);
    assert.strictEqual(controller.targetY, 10);
  });

  it('TC-T1-F18-04: formats persisted coordinates on drag release for config storage', () => {
    const controller = new PillDragPhysicsController();
    controller.startDrag();
    controller.updateDragTarget(800.4, 600.7);

    const savedPosition = controller.stopDrag();
    assert.strictEqual(savedPosition.x, 800);
    assert.strictEqual(savedPosition.y, 601);
  });

  it('TC-T1-F18-05: restores pill to saved config coordinates upon startup', () => {
    const savedConfig = { pillPosition: { x: 750, y: 920 } };
    const controller = new PillDragPhysicsController({
      initialX: savedConfig.pillPosition.x,
      initialY: savedConfig.pillPosition.y
    });

    assert.strictEqual(controller.x, 750);
    assert.strictEqual(controller.y, 920);
  });
});
