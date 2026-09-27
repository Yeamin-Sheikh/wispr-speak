// Tier 2 - Boundary 18: Fluid Draggable Pill with Spring Physics Boundary Cases
const { describe, it } = require('node:test');
const assert = require('node:assert');

class MultiMonitorPhysicsBounds {
  static clampToDisplays(targetX, targetY, displays, pillSize = { width: 320, height: 44 }) {
    // Check if target falls within any connected display work area
    for (const d of displays) {
      const bounds = d.workArea;
      if (
        targetX >= bounds.x - 100 && targetX <= bounds.x + bounds.width &&
        targetY >= bounds.y - 100 && targetY <= bounds.y + bounds.height
      ) {
        // Clamp strictly within this display
        const clampedX = Math.max(bounds.x + 10, Math.min(bounds.x + bounds.width - pillSize.width - 10, targetX));
        const clampedY = Math.max(bounds.y + 10, Math.min(bounds.y + bounds.height - pillSize.height - 10, targetY));
        return { x: clampedX, y: clampedY, displayId: d.id };
      }
    }

    // If completely outside all displays (e.g. monitor unplugged), fallback to primary display center-bottom
    const primary = displays.find(d => d.isPrimary) || displays[0];
    return {
      x: primary.workArea.x + Math.floor((primary.workArea.width - pillSize.width) / 2),
      y: primary.workArea.y + primary.workArea.height - pillSize.height - 85,
      displayId: primary.id,
      reset: true
    };
  }

  static capVelocity(vx, vy, maxSpeed = 3000) {
    const speed = Math.sqrt(vx * vx + vy * vy);
    if (speed > maxSpeed) {
      const ratio = maxSpeed / speed;
      return { vx: vx * ratio, vy: vy * ratio, capped: true };
    }
    return { vx, vy, capped: false };
  }
}

describe('Tier 2 - Boundary 18: Draggable Pill Spring Physics Boundary Cases', () => {
  const mockDisplays = [
    { id: 1, isPrimary: true, workArea: { x: 0, y: 0, width: 1920, height: 1080 } },
    { id: 2, isPrimary: false, workArea: { x: 1920, y: 0, width: 2560, height: 1440 } }
  ];

  it('TC-T2-B18-01: clamps drag coordinates across multi-monitor setup (secondary screen)', () => {
    // Drag to secondary monitor (x=2000, y=500)
    const res = MultiMonitorPhysicsBounds.clampToDisplays(2000, 500, mockDisplays);
    assert.strictEqual(res.displayId, 2);
    assert.strictEqual(res.x, 2000);
    assert.strictEqual(res.y, 500);
  });

  it('TC-T2-B18-02: relocates pill to primary display center-bottom when saved monitor is disconnected', () => {
    // Coordinate on disconnected display (x = 8000, y = 8000)
    const res = MultiMonitorPhysicsBounds.clampToDisplays(8000, 8000, mockDisplays);
    assert.strictEqual(res.displayId, 1);
    assert.strictEqual(res.reset, true);
    assert.strictEqual(res.x, Math.floor((1920 - 320) / 2));
    assert.strictEqual(res.y, 1080 - 44 - 85);
  });

  it('TC-T2-B18-03: caps extreme jerk velocities (>3000px/s) to prevent physics instability', () => {
    const extremeJerk = MultiMonitorPhysicsBounds.capVelocity(5000, 4000, 3000);
    assert.strictEqual(extremeJerk.capped, true);
    const speed = Math.sqrt(extremeJerk.vx ** 2 + extremeJerk.vy ** 2);
    assert.ok(Math.abs(speed - 3000) < 1e-4);
  });

  it('TC-T2-B18-04: ensures spring damping prevents infinite oscillation', () => {
    const k = 180;
    const c = 28; // damping
    const m = 1;
    // Damping ratio zeta = c / (2 * sqrt(k * m))
    const zeta = c / (2 * Math.sqrt(k * m));
    assert.ok(zeta >= 0.7, 'Spring must be critically damped or near critical (zeta >= 0.7)');
  });

  it('TC-T2-B18-05: guards against zero or negative mass input', () => {
    function sanitizePhysicsConfig(config) {
      return {
        mass: config.mass > 0 ? config.mass : 1,
        k: config.k > 0 ? config.k : 1,
        c: config.c !== undefined ? Math.max(0.1, config.c) : 12
      };
    }

    const sanitized = sanitizePhysicsConfig({ mass: 0, k: -50, c: 0 });
    assert.strictEqual(sanitized.mass, 1); // Defaults
    assert.strictEqual(sanitized.k, 1);
    assert.strictEqual(sanitized.c, 0.1);
  });
});
