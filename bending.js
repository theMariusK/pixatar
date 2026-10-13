// Bending: hold the left mouse button over water or earth and it comes with you.
//
// Q selects the element, shape, and action; B toggles digging. Water is below;
// earth (EarthBending) follows the same
// principle but fuses what it lifts into one solid rock; fire (FireBending) is
// conjured rather than lifted, since there is no fire lying around to take; air
// (AirBending, last) holds and throws a swirling ball of wisps the same way, but
// the wisps are pure force rather than matter — they push what they pass instead
// of landing as a cell.
//
// Every element has a Form and an Action (game.js, Q opens the picker):
// Bolt gathers near the cursor; Orbit holds a ring around the caster.
// Normal releases what is held; Punch turns it into an element-specific attack.
//
// Water: while the button is held, water
// near the cursor is lifted out of the grid a little at a time and gathers into a
// blob that follows the cursor — not rigidly, but each drop chasing its own place in
// the blob with a capped speed, so the water trails behind a fast sweep and catches
// up when you stop. Let go and the drops keep the momentum they had: sweep and release
// to throw water. Each drop turns back into a water cell where it lands.
//
// Nothing is created or destroyed here. A drop is exactly one water cell that has
// been taken out of the grid while it is in the air, and it goes back in when it
// lands. The only way one is used up is by putting out fire or cooling lava, which is
// the same cost every Water spell pays (see spells.js, "matter").
//
// Drops live outside the grid while they fly, the way debris does, which is what lets
// them move freely instead of obeying the sand rules. They still collide with
// terrain, so bent water pours around a wall rather than through it.

const BEND = {
  GRAB_RADIUS: 6,     // cells around the cursor that water is lifted from
  GRAB_RATE: 260,     // cells per second lifted while the button is held
  CAPACITY: 200,      // cells held at once
  REACH: 95,          // cells from the bender that water can be lifted from or held at
  FOLLOW: 7,          // how hard a drop is pulled toward its place in the blob (1/s)
  RESPONSE: 9,        // how quickly a drop's velocity turns toward that pull (1/s)
  MAX_SPEED: 520,     // px/s — the lag behind a fast sweep comes from this cap
  SPACING: 0.6,       // blob packing: ~1/sqrt(pi) gives each drop about one cell of area, a solid blob
  SWIRL: 0.6,         // rad/s the blob slowly turns, so held water never looks frozen
  GRAVITY: 900,       // px/s² on released drops
  SETTLE_RADIUS: 8,   // how far a landing drop looks for an open cell
  FREE_LIFE: 4,       // seconds a released drop may fly before it settles anyway
  PUNCH_SPEED: 720,    // focused water jet
  SPLASH_SPEED: 420,   // outward splash from Orbit Punch
};

// Golden-angle spiral: packs any number of drops into a round blob, with each new
// drop landing on the outside so the blob grows outward as water is lifted into it.
const BEND_GOLDEN = Math.PI * (3 - Math.sqrt(5));

function bendDiscOffsets(r) {
  const list = [];
  for (let dy = -r; dy <= r; dy++) {
    for (let dx = -r; dx <= r; dx++) {
      const d = Math.hypot(dx, dy);
      if (d <= r) list.push([dx, dy, d]);
    }
  }
  return list.sort((a, b) => a[2] - b[2]);
}

// Where held matter wants to be: the cursor, but never further from the bender than
// `reach` cells.
function bendTarget(scene, reach) {
  const p = scene.player;
  const pointer = scene.input.activePointer;
  const px = p.x + p.w / 2, py = p.y + p.h / 2;
  const dx = pointer.worldX - px, dy = pointer.worldY - py;
  const r = reach * PIXEL;
  const d = Math.hypot(dx, dy);
  if (d <= r) return { x: pointer.worldX, y: pointer.worldY };
  return { x: px + (dx / d) * r, y: py + (dy / d) * r };
}

function bendAim(scene) {
  const p = scene.player;
  const cx = p.x + p.w / 2, cy = p.y + p.h / 2;
  const pointer = scene.input.activePointer;
  const dx = pointer.worldX - cx, dy = pointer.worldY - cy;
  const length = Math.hypot(dx, dy);
  return length > 1 ? { x: dx / length, y: dy / length }
    : { x: p.facing || 1, y: 0 };
}

function bendOutward(x, y, cx, cy, index, count, phase = 0) {
  const dx = x - cx, dy = y - cy;
  const length = Math.hypot(dx, dy);
  const angle = length > 1 ? Math.atan2(dy, dx) : phase + index * Math.PI * 2 / count;
  return { x: Math.cos(angle), y: Math.sin(angle) };
}

function bendClearPath(scene, x0, y0, x1, y1) {
  const steps = Math.ceil(Math.hypot(x1 - x0, y1 - y0) / PIXEL);
  for (let i = 1; i < steps; i++) {
    const gx = Math.floor((x0 + (x1 - x0) * i / steps) / PIXEL);
    const gy = Math.floor((y0 + (y1 - y0) * i / steps) / PIXEL);
    if (gx < 0 || gx >= COLS || gy < 0 || gy >= ROWS
      || IS_SOLID[scene.grid[scene.idx(gx, gy)]]) return false;
  }
  return true;
}

// True while this element's bending owns the left mouse button.
function bendSelected(scene, element) {
  return scene.leftClickMode === 'bend' && scene.bendElement === element
    && !scene.player.dead && !scene.wheelOpen && !scene.bendWheelOpen;
}

// ---------------------------------------------------------------------------
// forms — Bolt (the default above) and Orbit, shared by every element
// ---------------------------------------------------------------------------
//
// Bolt gathers matter at the cursor and throws it. Orbit gathers the same way
// (grab()/steerHeld's substance half is untouched either way) but never chases
// the cursor at all: what's held pins to the bender and spins for as long as
// the button stays down, and it hits whatever it swings past — the one thing
// Bolt form never could. Letting go scatters the ring outward instead of
// throwing one mass in one direction. Punch consumes it in a stronger attack.
const ORBIT = {
  RADIUS: 34,          // px the ring sits at around the bender
  SPIN: 3.2,           // rad/s
  RELEASE_KICK: 160,   // px/s outward speed given to each piece when the ring is let go
  HIT_RADIUS: 10,      // px around an orbiting piece that can strike a body
  HIT_COOLDOWN: 0.35,  // s before the same piece can strike again
};

// Shoves anything caught within ORBIT.HIT_RADIUS of (x, y) — the ring's own
// strike. Modest and knockback-only by design, without shoving the bender.
// Returns whether it hit anything, so callers can throttle per piece.
function orbitStrike(scene, x, y, strength) {
  const hits = scene.bodiesInRadius(x, y, ORBIT.HIT_RADIUS);
  let hit = false;
  for (const t of hits) {
    if (!t.self) hit = true;
  }
  if (hit) scene.knockback(x, y, ORBIT.HIT_RADIUS * 2.4, strength, 0, 0, true);
  return hit;
}

// Test the visible bent matter against body rectangles, rather than body centres.
// A single body appears once even when a whole blob of particles overlaps it.
function bendContacts(scene, points, pad = PIXEL) {
  if (!points.length) return [];
  const targets = [];
  for (const id in scene.remotePlayers) {
    if (id === scene.netId) continue;
    const p = scene.remotePlayers[id];
    if (!p.dead) targets.push({ id, body: { x: p.x, y: p.y, w: PLAYER_BOX.w, h: PLAYER_BOX.h } });
  }
  for (const enemy of scene.enemies.list) {
    if (!enemy.dead) targets.push({ enemy, body: enemy });
  }
  return targets.filter(({ body }) => points.some(({ x, y }) =>
    x >= body.x - pad && x <= body.x + body.w + pad &&
    y >= body.y - pad && y <= body.y + body.h + pad));
}

function bendBodyWithin(body, x, y, radius) {
  const px = Math.max(body.x, Math.min(x, body.x + body.w));
  const py = Math.max(body.y, Math.min(y, body.y + body.h));
  return Math.hypot(px - x, py - y) <= radius;
}

function bendHitReady(cooldowns, key, now, interval) {
  if (cooldowns.size > 128) {
    for (const [oldKey, until] of cooldowns) {
      if (until <= now) cooldowns.delete(oldKey);
    }
  }
  if ((cooldowns.get(key) || 0) > now) return false;
  cooldowns.set(key, now + interval);
  return true;
}

const BEND_DAMAGE = {
  WATER_POWER: 0.06,
  AIR_POWER: 0.00035,
  FIRE_MINERAL_HEAT: 0.25,
  MAX_CELLS: 1024,
  WEAR_LIFE: 15000,
};

function bendExposedCell(scene, gx, gy) {
  return [[-1, 0], [1, 0], [0, -1], [0, 1]].some(([dx, dy]) =>
    !IS_SOLID[scene.grid[scene.idx(gx + dx, gy + dy)]]);
}

function bendSurfaceDamage(scene) {
  if (!scene.bendingDamage) scene.bendingDamage = new BendingSurfaceDamage(scene);
  return scene.bendingDamage;
}

// Shared, bounded wear lets weak impacts accumulate. Burning keeps the original
// material in place until it is consumed; only the final cell changes travel over
// the existing multiplayer cell stream.
class BendingSurfaceDamage {
  constructor(scene) {
    this.scene = scene;
    this.clear();
  }

  clear() {
    for (const obj of this.burningObjects || []) obj.bendBurning = false;
    this.cells = new Map();
    this.objects = new WeakMap();
    this.burningObjects = new Set();
  }

  invalidateCell(id) {
    this.cells.delete(id);
  }

  record(mat, variant) {
    return { mat, variant, damage: 0, hits: {}, at: this.scene.time.now,
      burn: 0, wetUntil: 0, fx: 0 };
  }

  apply(record, amount, element, impact = false) {
    const now = this.scene.time.now;
    // Discrete explosions deliver physical damage independently of the weaker,
    // continuous heat contacts (and can stack when two fireballs land together).
    if (impact) {
      record.damage += amount;
      record.at = now;
      return record.damage >= PixelWorld.IMPACT_RESISTANCE[record.mat];
    }
    const fuel = PixelWorld.FLAMMABILITY[record.mat] > 0;
    if (element === 'Water') {
      record.burn = 0;
      record.wetUntil = now + 500;
    } else if (element === 'Fire') {
      amount *= fuel ? 1 : BEND_DAMAGE.FIRE_MINERAL_HEAT;
      if (now < record.wetUntil) amount *= 0.2;
      else if (fuel) {
        record.burn = Math.max(record.burn,
          PixelWorld.IMPACT_RESISTANCE[record.mat] / this.burnRate(record.mat) + 0.5);
      }
    }
    // Use the strongest contact per element per frame: substeps and overlapping
    // particles must not multiply damage just because the frame is longer.
    const previous = record.hits[element];
    const accepted = previous?.at === now ? Math.max(0, amount - previous.amount) : amount;
    record.hits[element] = { at: now, amount: Math.max(amount, previous?.at === now ? previous.amount : 0) };
    record.damage += accepted;
    record.at = now;
    return record.damage >= PixelWorld.IMPACT_RESISTANCE[record.mat];
  }

  cell(gx, gy, amount, element, impact = false) {
    const s = this.scene;
    if (gx <= 0 || gx >= COLS - 1 || gy <= 0 || gy >= ROWS - 1 || amount <= 0) return false;
    const id = s.idx(gx, gy), mat = s.grid[id];
    if (!Number.isFinite(PixelWorld.IMPACT_RESISTANCE[mat])) return false;
    const variant = s.life[id];
    let record = this.cells.get(id);
    if (!record || record.mat !== mat || (mat !== PixelWorld.MAT.ICE && record.variant !== variant)
      || s.time.now - record.at > BEND_DAMAGE.WEAR_LIFE) {
      record = this.record(mat, variant);
      if (this.cells.size >= BEND_DAMAGE.MAX_CELLS) this.cells.delete(this.cells.keys().next().value);
      this.cells.set(id, record);
    }
    if (element === 'Fire' && this.wet(gx, gy)) record.wetUntil = s.time.now + 100;
    if (!this.apply(record, amount, element, impact)) return false;
    this.destroyCell(id, record, element, impact);
    return true;
  }

  object(obj, amount, element, impact = false) {
    if (amount <= 0 || !Number.isFinite(PixelWorld.IMPACT_RESISTANCE[obj.mat])) return false;
    let record = this.objects.get(obj);
    if (!record || record.mat !== obj.mat) {
      record = this.record(obj.mat, obj.variant);
      this.objects.set(obj, record);
    }
    if (element === 'Fire' && this.wet(Math.floor(obj.x / PIXEL), Math.floor(obj.y / PIXEL))) {
      record.wetUntil = this.scene.time.now + 100;
    }
    const destroyed = this.apply(record, amount, element, impact);
    obj.bendBurning = record.burn > 0;
    if (record.burn > 0) this.burningObjects.add(obj);
    else this.burningObjects.delete(obj);
    if (destroyed) this.destroyObject(obj, record, element, impact);
    return destroyed;
  }

  burnRate(mat) {
    return 0.45 + Math.min(0.6, PixelWorld.FLAMMABILITY[mat] * 6);
  }

  wet(gx, gy) {
    const s = this.scene;
    return [[0, 0], [-1, 0], [1, 0], [0, -1], [0, 1]].some(([dx, dy]) => {
      const x = gx + dx, y = gy + dy;
      return x >= 0 && x < COLS && y >= 0 && y < ROWS
        && s.grid[s.idx(x, y)] === WATER;
    });
  }

  destroyCell(id, record, element, impact = false) {
    const s = this.scene;
    const gx = id % COLS, gy = Math.floor(id / COLS);
    const fuel = !impact && element === 'Fire' && PixelWorld.FLAMMABILITY[record.mat] > 0;
    this.cells.delete(id);
    if (fuel) {
      if (record.mat === PixelWorld.MAT.GRASS) {
        s.setCell(id, PixelWorld.MAT.DIRT, 1);
        if (s.grid[id - COLS] === EMPTY) s.setCell(id - COLS, FIRE, PixelWorld.FIRE_LIFE);
      } else s.setCell(id, FIRE, PixelWorld.BURN_LIFE[record.mat]);
    } else if (!impact && element === 'Fire' && [PixelWorld.MAT.ICE, PixelWorld.MAT.PACKED_ICE,
      PixelWorld.MAT.SNOW].includes(record.mat)) {
      s.setCell(id, WATER);
    } else {
      const debris = s.spawnDebris(gx, gy, record.mat, gx, gy + 1, false);
      if (debris) debris.bendCasterSafe = element !== 'Air';
      s.setCell(id, EMPTY);
    }
    if (!s.multiplayer) s.collapseTimer = Math.min(s.collapseTimer ?? 120, 30);
    s.fx.burst(gx * PIXEL + PIXEL / 2, gy * PIXEL + PIXEL / 2, 4, element,
      { speed: 45, life: 0.3, size: 0.9 });
  }

  destroyObject(obj, record, element, impact = false) {
    const s = this.scene;
    const index = s.debris.indexOf(obj);
    if (index >= 0) s.debris.splice(index, 1);
    this.objects.delete(obj);
    this.burningObjects.delete(obj);
    obj.bendBurning = false;
    if (!impact && element === 'Fire' && PixelWorld.FLAMMABILITY[record.mat] > 0) {
      const gx = Math.floor(obj.x / PIXEL), gy = Math.floor(obj.y / PIXEL);
      if (gx > 0 && gx < COLS - 1 && gy > 0 && gy < ROWS - 1 && s.grid[s.idx(gx, gy)] === EMPTY) {
        s.setCell(s.idx(gx, gy), FIRE, PixelWorld.BURN_LIFE[record.mat]);
      }
    }
    s.fx.burst(obj.x, obj.y, 6, element, { speed: 55, life: 0.35, size: 1 });
  }

  settleObject(obj, gx, gy) {
    const record = this.objects.get(obj);
    if (!record) return;
    const id = this.scene.idx(gx, gy);
    if (this.scene.grid[id] !== record.mat) return;
    this.cells.set(id, { ...record, variant: this.scene.life[id], hits: {}, at: this.scene.time.now });
    if (this.cells.size > BEND_DAMAGE.MAX_CELLS) this.cells.delete(this.cells.keys().next().value);
    this.objects.delete(obj);
    this.burningObjects.delete(obj);
    obj.bendBurning = false;
  }

  update(dt) {
    const s = this.scene;
    let effects = 24;
    const burn = (record, x, y) => {
      if (this.wet(Math.floor(x / PIXEL), Math.floor(y / PIXEL)) || s.time.now < record.wetUntil) {
        record.burn = 0;
        return false;
      }
      record.burn -= dt;
      record.damage += this.burnRate(record.mat) * dt;
      record.fx += dt;
      if (record.fx >= 0.12 && effects > 0) {
        record.fx %= 0.12;
        effects--;
        s.fx.burst(x, y, 2, 'Fire', { speed: 20, rise: 35, life: 0.3, size: 0.8 });
      }
      return record.damage >= PixelWorld.IMPACT_RESISTANCE[record.mat];
    };
    for (const [id, record] of this.cells) {
      if (s.grid[id] !== record.mat
        || (record.mat !== PixelWorld.MAT.ICE && s.life[id] !== record.variant)
        || s.time.now - record.at > BEND_DAMAGE.WEAR_LIFE) {
        this.cells.delete(id);
        continue;
      }
      if (record.burn > 0 && burn(record, (id % COLS) * PIXEL + PIXEL / 2,
        Math.floor(id / COLS) * PIXEL + PIXEL / 2)) this.destroyCell(id, record, 'Fire');
    }
    for (const obj of this.burningObjects) {
      const record = this.objects.get(obj);
      if (!record || record.mat !== obj.mat || !s.debris.includes(obj)) {
        obj.bendBurning = false;
        this.objects.delete(obj);
        this.burningObjects.delete(obj);
        continue;
      }
      if (record.burn > 0 && burn(record, obj.x, obj.y)) this.destroyObject(obj, record, 'Fire');
      else if (record.burn <= 0) {
        obj.bendBurning = false;
        this.burningObjects.delete(obj);
      }
    }
  }
}

class WaterBending {
  constructor(scene) {
    this.scene = scene;
    this.element = 'Water';
    this.form = 'Bolt'; // 'Bolt' | 'Orbit' — set by game.js's bend-form wheel
    this.grabRadius = BEND.GRAB_RADIUS;
    this.held = [];    // drops following the cursor: { x, y, vx, vy }
    this.free = [];    // released drops, falling until they land: { x, y, vx, vy, age }
    this.active = false;
    this.grabAcc = 0;
    this.grabOffsets = bendDiscOffsets(BEND.GRAB_RADIUS);
    this.settleOffsets = bendDiscOffsets(BEND.SETTLE_RADIUS);
    this.gfx = scene.add.graphics().setDepth(8.5);
    this.hitCooldowns = new Map();
    this.surfaceDamage = bendSurfaceDamage(scene);
  }

  begin() {
    this.active = true;
    this.grabAcc = 0;
  }

  // Let go of everything held. Bolt's drops keep their velocity, which is the
  // throw; Orbit's have almost none, so they get an outward kick instead —
  // letting go of a ring reads as releasing it, not an arbitrary scatter.
  release() {
    if (!this.active && !this.held.length) return;
    this.active = false;
    const p = this.scene.player;
    const cx = p.x + p.w / 2, cy = p.y + p.h / 2;
    for (const d of this.held) {
      d.age = 0;
      if (this.form === 'Orbit') {
        const dx = d.x - cx, dy = d.y - cy;
        const dist = Math.max(1, Math.hypot(dx, dy));
        d.vx += (dx / dist) * ORBIT.RELEASE_KICK;
        d.vy += (dy / dist) * ORBIT.RELEASE_KICK;
      }
      this.free.push(d);
    }
    this.held.length = 0;
  }

  get holding() {
    return this.held.length;
  }

  punch() {
    if (!this.held.length) return false;
    const s = this.scene;
    const p = s.player;
    const cx = p.x + p.w / 2, cy = p.y + p.h / 2;
    const count = this.held.length;
    const aim = bendAim(s);
    for (let i = 0; i < count; i++) {
      const drop = this.held[i];
      const dir = this.form === 'Orbit'
        ? bendOutward(drop.x, drop.y, cx, cy, i, count, this.spin || 0) : aim;
      const speed = this.form === 'Orbit' ? BEND.SPLASH_SPEED : BEND.PUNCH_SPEED;
      drop.vx = dir.x * speed;
      drop.vy = dir.y * speed;
      drop.age = 0;
      drop.punched = true;
      drop.punchMass = count;
      this.free.push(drop);
    }
    this.held.length = 0;
    if (this.form === 'Orbit') {
      this.drenchBurst(cx, cy, ORBIT.RADIUS + 32, 180);
      s.fx.shockwave(cx, cy, 'Water',
        { r0: ORBIT.RADIUS * 0.5, r1: ORBIT.RADIUS + 64, life: 0.4, width: 3, rings: 2 });
      s.fx.burst(cx, cy, Math.min(40, count / 3 + 10), 'Water',
        { speed: 150, life: 0.5, size: 1.4 });
    } else {
      s.fx.streaks(cx, cy, Math.min(24, count / 5 + 6), 'Water',
        { speed: 240, angle: Math.atan2(aim.y, aim.x), spread: 0.5, life: 0.35 });
    }
    return true;
  }

  drenchBurst(x, y, radius, impulse) {
    const s = this.scene;
    const now = s.time.now;
    for (const target of bendContacts(s, [{ x, y }], radius)) {
      if (!bendBodyWithin(target.body, x, y, radius)) continue;
      const bx = target.body.x + target.body.w / 2;
      const by = target.body.y + target.body.h / 2;
      if (!bendClearPath(s, x, y, bx, by)) continue;
      const key = target.id || target.enemy;
      if (!bendHitReady(this.hitCooldowns, key, now, 170)) continue;
      const dir = bendOutward(bx, by, x, y, 0, 1);
      const ix = dir.x * impulse, iy = dir.y * impulse - 35;
      if (target.enemy) {
        target.enemy.wetUntil = now + 650;
        target.enemy.impulseX = (target.enemy.impulseX || 0) + ix;
        target.enemy.vy += iy;
      } else s.reportHit(target.id, 'Water', 0, null, { wetMs: 650, ix, iy });
    }
    for (const obj of [...s.debris]) {
      if (Math.hypot(obj.x - x, obj.y - y) > radius
        || !bendClearPath(s, x, y, obj.x, obj.y)) continue;
      const dir = bendOutward(obj.x, obj.y, x, y, 0, 1);
      obj.vx += dir.x * impulse;
      obj.vy += dir.y * impulse - 35;
      this.surfaceDamage.object(obj, BEND_DAMAGE.WATER_POWER * (impulse / 200) ** 2, 'Water');
    }
  }

  target() {
    return bendTarget(this.scene, BEND.REACH);
  }

  update(dt) {
    // Anything that takes the left button away from water bending lets the water go:
    // dying, opening the spell wheel, switching to another mode or element.
    if (this.active && !bendSelected(this.scene, this.element)) this.release();

    if (this.active) this.grab(dt);
    if (this.held.length) {
      if (this.form === 'Orbit') this.steerOrbit(dt); else this.steerHeld(dt);
    }
    if (this.free.length) this.updateFree(dt);
    this.touchBodies();
    this.pushObjects(dt);
  }

  touchBodies() {
    const s = this.scene;
    const now = s.time.now;
    for (const target of bendContacts(s, [...this.held, ...this.free])) {
      const key = target.id || target.enemy;
      if (!bendHitReady(this.hitCooldowns, key, now, 170)) continue;
      if (target.enemy) target.enemy.wetUntil = now + 450;
      else s.reportHit(target.id, 'Water', 0, null, { wetMs: 450 });
      s.fx.burst(target.body.x + target.body.w / 2, target.body.y + target.body.h / 2,
        3, 'Water', { speed: 35, life: 0.25, size: 1 });
    }
  }

  touchPunchDrop(drop) {
    const s = this.scene;
    const now = s.time.now;
    for (const target of bendContacts(s, [drop], PIXEL * 1.5)) {
      if (!bendBodyWithin(target.body, drop.x, drop.y, PIXEL * 1.5)) continue;
      const key = target.id || target.enemy;
      if (!bendHitReady(this.hitCooldowns, key, now, 170)) continue;
      const ix = Math.max(-240, Math.min(240, drop.vx * 0.32));
      const iy = Math.max(-220, Math.min(220, drop.vy * 0.32));
      if (target.enemy) {
        target.enemy.wetUntil = now + 650;
        target.enemy.impulseX = (target.enemy.impulseX || 0) + ix;
        target.enemy.vy += iy;
      } else s.reportHit(target.id, 'Water', 0, null, { wetMs: 650, ix, iy });
      s.fx.burst(drop.x, drop.y, 5, 'Water', { speed: 55, life: 0.28, size: 1.1 });
    }
  }

  pushObjects(dt) {
    const drops = [...this.held, ...this.free];
    if (!drops.length) return;
    for (const obj of [...this.scene.debris, ...this.scene.projectiles]) {
      const drop = drops.find((d) => Math.hypot(d.x - obj.x, d.y - obj.y) < PIXEL * 3);
      if (!drop) continue;
      obj.vx += drop.vx * dt * 1.5;
      obj.vy += drop.vy * dt * 1.5;
      if (!this.objectHitCooldowns) this.objectHitCooldowns = new Map();
      if (bendHitReady(this.objectHitCooldowns, obj, this.scene.time.now, 150)) {
        const speed = Math.hypot(drop.vx, drop.vy);
        this.surfaceDamage.object(obj, Math.max(0.0001,
          BEND_DAMAGE.WATER_POWER * (speed / 200) ** 2), 'Water');
      }
    }
  }

  // Lift water out of the grid near the cursor, nearest cells first, up to the rate
  // and the capacity. Only water within reach of the bender can be lifted.
  grab(dt) {
    if (this.held.length >= BEND.CAPACITY) { this.grabAcc = 0; return; }
    const s = this.scene;
    this.grabAcc += BEND.GRAB_RATE * dt;
    let n = Math.floor(this.grabAcc);
    if (n <= 0) return;
    this.grabAcc -= n;

    const p = s.player;
    const pgx = (p.x + p.w / 2) / PIXEL, pgy = (p.y + p.h / 2) / PIXEL;
    const pointer = s.input.activePointer;
    const cgx = Math.floor(pointer.worldX / PIXEL), cgy = Math.floor(pointer.worldY / PIXEL);
    for (const [dx, dy] of this.grabOffsets) {
      if (n <= 0 || this.held.length >= BEND.CAPACITY) break;
      const x = cgx + dx, y = cgy + dy;
      if (x <= 0 || x >= COLS - 1 || y <= 0 || y >= ROWS - 1) continue;
      const id = s.idx(x, y);
      if (s.grid[id] !== WATER) continue;
      if (Math.hypot(x - pgx, y - pgy) > BEND.REACH) continue;
      s.setCell(id, EMPTY);
      this.held.push({ x: x * PIXEL + PIXEL / 2, y: y * PIXEL + PIXEL / 2, vx: 0, vy: 0 });
      n--;
    }
    // Nothing left under the cursor: do not bank pickups for later.
    this.grabAcc = Math.min(this.grabAcc, 1);
  }

  // Each drop chases its own place in the blob. The pull is proportional to distance
  // but capped at MAX_SPEED, and the velocity only turns toward it at RESPONSE, which
  // is what gives the water its lag: a fast sweep stretches the blob into a stream
  // that catches up and gathers again when the cursor stops.
  steerHeld(dt) {
    const { x: cx, y: cy } = this.target();
    const spin = (this.scene.time.now / 1000) * BEND.SWIRL;
    const turn = Math.min(1, BEND.RESPONSE * dt);
    for (let i = this.held.length - 1; i >= 0; i--) {
      const d = this.held[i];
      const r = BEND.SPACING * PIXEL * Math.sqrt(i + 0.5);
      const a = i * BEND_GOLDEN + spin;
      const tx = cx + Math.cos(a) * r, ty = cy + Math.sin(a) * r;
      let wx = (tx - d.x) * BEND.FOLLOW, wy = (ty - d.y) * BEND.FOLLOW;
      const w = Math.hypot(wx, wy);
      if (w > BEND.MAX_SPEED) { wx *= BEND.MAX_SPEED / w; wy *= BEND.MAX_SPEED / w; }
      d.vx += (wx - d.vx) * turn;
      d.vy += (wy - d.vy) * turn;
      if (this.moveDrop(d, dt) === 'consumed') this.held.splice(i, 1);
    }
  }

  // Orbit form: instead of chasing the cursor, each drop takes a fixed slot on
  // a ring around the bender that spins for as long as the button is held.
  // Anything the ring swings close to gets a shove — the substance hooks
  // (moveDrop, dousing/cooling) are exactly the same ones Bolt form uses.
  steerOrbit(dt) {
    const s = this.scene;
    const p = s.player;
    const cx = p.x + p.w / 2, cy = p.y + p.h / 2;
    this.spin = (this.spin || 0) + ORBIT.SPIN * dt;
    const n = this.held.length;
    const turn = Math.min(1, BEND.RESPONSE * dt);
    for (let i = n - 1; i >= 0; i--) {
      const d = this.held[i];
      const a = (i / n) * Math.PI * 2 + this.spin;
      const tx = cx + Math.cos(a) * ORBIT.RADIUS, ty = cy + Math.sin(a) * ORBIT.RADIUS;
      let wx = (tx - d.x) * BEND.FOLLOW, wy = (ty - d.y) * BEND.FOLLOW;
      const w = Math.hypot(wx, wy);
      if (w > BEND.MAX_SPEED) { wx *= BEND.MAX_SPEED / w; wy *= BEND.MAX_SPEED / w; }
      d.vx += (wx - d.vx) * turn;
      d.vy += (wy - d.vy) * turn;
      if (this.moveDrop(d, dt) === 'consumed') { this.held.splice(i, 1); continue; }
      d.hitCd = (d.hitCd || 0) - dt;
      if (d.hitCd <= 0 && orbitStrike(s, d.x, d.y, 140)) d.hitCd = ORBIT.HIT_COOLDOWN;
    }
  }

  updateFree(dt) {
    const s = this.scene;
    for (let i = this.free.length - 1; i >= 0; i--) {
      const d = this.free[i];
      d.age += dt;
      d.vy += BEND.GRAVITY * dt;
      d.vx *= 1 - Math.min(1, 0.4 * dt);
      const res = this.moveDrop(d, dt);
      if (res === 'consumed') { this.free.splice(i, 1); continue; }
      // It lands when it hits something, falls into standing water, or has simply
      // been in the air too long.
      const gx = Math.floor(d.x / PIXEL), gy = Math.floor(d.y / PIXEL);
      const inWater = s.grid[s.idx(gx, gy)] === WATER;
      if (res === 'blocked' || inWater || d.age > BEND.FREE_LIFE) {
        this.settle(d);
        this.free.splice(i, 1);
      }
    }
  }

  // Moves one drop by its velocity in sub-steps of at most one cell, so a fast throw
  // cannot tunnel through a thin wall. Blocked per axis, so a drop pressed into a
  // wall slides along it. Returns 'ok', 'blocked', or 'consumed' when the drop was
  // spent putting out fire or cooling lava.
  moveDrop(d, dt) {
    const s = this.scene;
    const dist = Math.max(Math.abs(d.vx), Math.abs(d.vy)) * dt;
    const steps = Math.max(1, Math.ceil(dist / PIXEL));
    const sx = (d.vx * dt) / steps, sy = (d.vy * dt) / steps;
    let blocked = false;
    for (let k = 0; k < steps; k++) {
      if (this.solidAt(d.x + sx, d.y)) this.erodeSurface(d, d.x + sx, d.y);
      if (this.solidAt(d.x + sx, d.y)) { d.vx *= -0.15; blocked = true; } else d.x += sx;
      if (this.solidAt(d.x, d.y + sy)) this.erodeSurface(d, d.x, d.y + sy);
      if (this.solidAt(d.x, d.y + sy)) { d.vy *= -0.15; blocked = true; } else d.y += sy;
      if (d.punched) this.touchPunchDrop(d);
      const gx = Math.floor(d.x / PIXEL), gy = Math.floor(d.y / PIXEL);
      const id = s.idx(gx, gy);
      const m = s.grid[id];
      if (m === FIRE) { s.setCell(id, SMOKE, SMOKE_LIFE); return 'consumed'; }
      if (m === LAVA) { s.setCell(id, STONE); return 'consumed'; }
      if (blocked) break;
    }
    return blocked ? 'blocked' : 'ok';
  }

  erodeSurface(drop, x, y) {
    const speed = Math.hypot(drop.vx, drop.vy);
    const load = 1 + Math.min(1.5, Math.sqrt(drop.punchMass || 1) / 10);
    if (this.surfaceDamage.cell(Math.floor(x / PIXEL), Math.floor(y / PIXEL),
      speed < 65 ? 0.0001 : BEND_DAMAGE.WATER_POWER * (speed / 200) ** 2 * load, 'Water')) {
      drop.vx *= 0.6;
      drop.vy *= 0.6;
    }
  }

  solidAt(px, py) {
    const gx = Math.floor(px / PIXEL), gy = Math.floor(py / PIXEL);
    if (gx <= 0 || gx >= COLS - 1 || gy <= 0 || gy >= ROWS - 1) return true;
    return IS_SOLID[this.scene.grid[this.scene.idx(gx, gy)]] === 1;
  }

  // Put a landed drop back into the grid as water, in the nearest open cell. A drop
  // that finds nowhere within SETTLE_RADIUS (wedged into a sealed crevice) is lost —
  // rare, and the only leak in the system.
  settle(d) {
    const s = this.scene;
    const gx = Math.floor(d.x / PIXEL), gy = Math.floor(d.y / PIXEL);
    for (const [dx, dy] of this.settleOffsets) {
      const x = gx + dx, y = gy + dy;
      if (x <= 0 || x >= COLS - 1 || y <= 0 || y >= ROWS - 1) continue;
      const id = s.idx(x, y);
      if (s.grid[id] === EMPTY) { s.setCell(id, WATER); return; }
    }
  }

  draw() {
    const g = this.gfx;
    g.clear();
    if (!this.held.length && !this.free.length) return;
    const pal = PALETTE[WATER][0];
    const base = Phaser.Display.Color.GetColor(pal[0], pal[1], pal[2]);
    const fast = 0x7fb4f5;
    // A faint halo around the held blob, so bent water reads as held rather than as
    // water that happens to be floating.
    if (this.held.length > 4) {
      let sx = 0, sy = 0;
      for (const d of this.held) { sx += d.x; sy += d.y; }
      const r = BEND.SPACING * PIXEL * Math.sqrt(this.held.length) + 6;
      g.fillStyle(0x66b8ff, 0.12);
      g.fillCircle(sx / this.held.length, sy / this.held.length, r);
    }
    for (const list of [this.held, this.free]) {
      for (const d of list) {
        const speed = Math.abs(d.vx) + Math.abs(d.vy);
        g.fillStyle(speed > 320 ? fast : base, 1);
        // A hair larger than a cell, so drops at fractional positions do not leave
        // seams between them.
        g.fillRect(d.x - PIXEL / 2 - 0.5, d.y - PIXEL / 2 - 0.5, PIXEL + 1, PIXEL + 1);
      }
    }
  }
}

// ---------------------------------------------------------------------------
// earth
// ---------------------------------------------------------------------------
//
// Same hold-and-follow as water, but earth does not stay loose. Every cell lifted
// flies to its place in a single rock that forms at the cursor, and fuses into it
// as stone — sand, dirt, brick and ore all come together as one solid body. The rock
// moves as one piece: it follows the cursor, heavier and laggier the bigger it gets,
// and it cannot be dragged through terrain.
//
// Let go and the rock is thrown with whatever momentum it had, falls under gravity,
// and lands as ordinary stone in the world — static, and subject to the world's own
// support rules from then on: stone left hanging with nothing under it falls, and
// lands hard on whatever is below (world.js, updateFallingRigid).
//
// Matter is conserved one cell for one cell: the rock is exactly as big as the hole
// it came out of. Pieces still in flight when you let go fall as what they were.

const EARTH_BEND = {
  GRAB_RADIUS: 5,       // cells around the cursor that earth is lifted from
  GRAB_RATE: 150,       // effort per second; loose earth costs 1 per cell, hard rock 2
  CAPACITY: 160,        // cells in one rock
  REACH: 95,            // cells from the bender, as for water
  FOLLOW: 6,            // pull toward the cursor (1/s)
  RESPONSE: 6,          // how quickly the rock's velocity turns toward that pull (1/s)
  MAX_SPEED: 420,       // px/s for a pebble...
  HEAVY_SLOWDOWN: 0.5,  // ...and a full-sized rock moves at half that
  PIECE_SPEED: 700,     // px/s a lifted piece flies to the rock at
  GRAVITY: 1100,        // px/s² on a thrown rock
  FREE_LIFE: 6,         // seconds a thrown rock may fly before it lands anyway
  FOOTING: 3,           // rows under the bender's feet that are never lifted
  PUNCH_SPEED: 690,     // focused rock strike
  FRAGMENT_SPEED: 470,  // stone fragments from Orbit Punch
  MIN_IMPACT_SPEED: 65, // resting rocks cannot excavate terrain
  IMPACT_SPEED_SCALE: 200,
  MAX_CRUMBLE_RADIUS: 16, // cells; limits the work done by one impact
  MAX_CRUMBLE_CELLS: 300,
  CRUMBLE_DEBRIS: 20,
};

class EarthBending {
  constructor(scene) {
    const M = PixelWorld.MAT;
    this.scene = scene;
    this.element = 'Earth';
    this.form = 'Bolt'; // 'Bolt' | 'Orbit' — set by game.js's bend-form wheel
    this.grabRadius = EARTH_BEND.GRAB_RADIUS;
    // What counts as earth. Hard rock takes twice the effort to pry loose.
    this.loose = new Set([M.SAND, M.DIRT, M.GRASS]);
    this.hard = new Set([M.STONE, M.SANDSTONE, M.COAL, M.GOLD, M.BRICK]);
    // What a thrown rock may land in: open space, and things too thin to stop it.
    this.open = new Set([M.EMPTY, M.SMOKE, M.FIRE, M.GAS]);
    this.active = false;
    this.grabAcc = 0;
    this.rock = null;      // the held rock: { x, y, vx, vy, cells: [{ ox, oy, shade }], nextSlot }
    this.pieces = [];      // lifted cells flying to the rock: { x, y, mat, variant, slot }
    this.thrown = [];      // released rocks, falling until they land
    this.loosePieces = []; // pieces let go before they reached the rock
    // Rock slots, grid-aligned and nearest-first, so the rock grows outward from its
    // centre as a compact lump. Radius 12 holds far more than CAPACITY.
    this.slots = bendDiscOffsets(12);
    this.grabOffsets = bendDiscOffsets(EARTH_BEND.GRAB_RADIUS);
    this.settleOffsets = bendDiscOffsets(4);
    this.gfx = scene.add.graphics().setDepth(8.5);
    this.hitCooldowns = new Map();
  }

  get holding() {
    return (this.rock ? this.rock.cells.length : 0) + this.pieces.length;
  }

  punch() {
    if (!this.rock || !this.holding) return false;
    const s = this.scene;
    const p = s.player;
    const cx = p.x + p.w / 2, cy = p.y + p.h / 2;
    const rock = this.rock;
    // Pieces already lifted from terrain belong to this attack even if they
    // had not reached their slots yet. Fusing them preserves their cell count.
    for (const piece of this.pieces) {
      const [ox, oy] = this.slots[piece.slot];
      rock.cells.push({ ox, oy, shade: piece.variant || 0 });
    }
    this.pieces.length = 0;
    if (this.form === 'Orbit') {
      rock.x = cx; rock.y = cy;
      const count = rock.cells.length;
      for (let i = 0; i < count; i++) {
        const cell = rock.cells[i];
        const x = cx + cell.ox * PIXEL, y = cy + cell.oy * PIXEL;
        const dir = bendOutward(x, y, cx, cy, i, count, this.spin || 0);
        this.thrown.push({
          x, y, vx: dir.x * EARTH_BEND.FRAGMENT_SPEED,
          vy: dir.y * EARTH_BEND.FRAGMENT_SPEED,
          age: 0, punched: true, fragment: true,
          cells: [{ ox: 0, oy: 0, shade: cell.shade }],
        });
      }
      s.fx.shockwave(cx, cy, 'Earth',
        { r0: ORBIT.RADIUS * 0.4, r1: ORBIT.RADIUS * 3, life: 0.4, width: 3, rings: 2 });
      s.fx.shards(cx, cy, Math.min(28, 6 + count / 5), 'Earth',
        { speed: 180, life: 0.5, size: 1.4 });
    } else {
      const aim = bendAim(s);
      rock.vx = aim.x * EARTH_BEND.PUNCH_SPEED;
      rock.vy = aim.y * EARTH_BEND.PUNCH_SPEED;
      rock.age = 0;
      rock.punched = true;
      this.thrown.push(rock);
      s.fx.shards(rock.x, rock.y, Math.min(20, 5 + rock.cells.length / 8), 'Earth',
        { speed: 130, angle: Math.atan2(aim.y, aim.x), spread: 1, life: 0.4 });
    }
    this.rock = this.active ? { ...bendTarget(s, EARTH_BEND.REACH),
      vx: 0, vy: 0, cells: [], nextSlot: 0 } : null;
    return true;
  }

  begin() {
    const t = bendTarget(this.scene, EARTH_BEND.REACH);
    this.active = true;
    this.grabAcc = 0;
    this.rock = { x: t.x, y: t.y, vx: 0, vy: 0, cells: [], nextSlot: 0 };
  }

  // Bolt lets go of one flying boulder (thrown). Orbit has no boulder to throw
  // — letting go scatters the ring's own stones outward, each one landing
  // where it falls rather than flying on together.
  release() {
    if (!this.active && !this.rock) return;
    this.active = false;
    if (this.rock && this.rock.cells.length) {
      if (this.form === 'Orbit') {
        const M = PixelWorld.MAT;
        for (const c of this.rock.cells) {
          const d = Math.max(1, Math.hypot(c.ox, c.oy));
          this.loosePieces.push({
            x: this.rock.x + c.ox * PIXEL, y: this.rock.y + c.oy * PIXEL,
            vx: (c.ox / d) * ORBIT.RELEASE_KICK, vy: (c.oy / d) * ORBIT.RELEASE_KICK,
            mat: M.STONE, variant: c.shade, age: 0,
          });
        }
      } else {
        this.rock.age = 0;
        this.thrown.push(this.rock);
      }
    }
    for (const pc of this.pieces) {
      this.loosePieces.push({ x: pc.x, y: pc.y, vx: 0, vy: 0, mat: pc.mat, variant: pc.variant, age: 0 });
    }
    this.pieces.length = 0;
    this.rock = null;
  }

  update(dt) {
    if (this.active && !bendSelected(this.scene, this.element)) this.release();
    if (this.active) this.grab(dt);
    if (this.rock) {
      this.flyPieces(dt);
      if (this.form === 'Orbit') this.steerOrbitRock(dt); else this.steerRock(dt);
    }
    if (this.thrown.length) this.updateThrown(dt);
    if (this.loosePieces.length) this.updateLoose(dt);
  }

  strikeBodies(rock, impactSpeed = Math.hypot(rock.vx, rock.vy)) {
    if (!rock.cells.length) return;
    const s = this.scene;
    const now = s.time.now;
    if (impactSpeed < 65 && this.form !== 'Orbit') return;
    const points = rock.cells.map((c) => ({ x: rock.x + c.ox * PIXEL, y: rock.y + c.oy * PIXEL }));
    const damage = Math.min(24, 4 + Math.sqrt(rock.cells.length) * 1.1 + impactSpeed * 0.018);
    this.strikeObjects(rock, points, impactSpeed);
    for (const target of bendContacts(s, points, PIXEL * 1.4)) {
      const key = target.id || target.enemy;
      if (!bendHitReady(this.hitCooldowns, key, now, 400)) continue;
      const cx = target.body.x + target.body.w / 2;
      const cy = target.body.y + target.body.h / 2;
      const ix = Math.max(-240, Math.min(240, rock.vx * 0.65));
      const iy = Math.max(-260, Math.min(120, rock.vy * 0.4 - 90));
      if (target.enemy) {
        s.damageEnemy(target.enemy, damage, 'Earth');
        target.enemy.impulseX = (target.enemy.impulseX || 0) + ix;
        target.enemy.vy += iy;
      } else {
        s.reportHit(target.id, 'Earth', damage, null, { ix, iy });
      }
      s.fx.burst(cx, cy, 8, 'Earth', { speed: 90, life: 0.35, size: 1.4 });
    }
  }

  strikeObjects(rock, points, speed) {
    const energy = this.impactEnergy(rock, speed);
    if (!energy) return;
    const s = this.scene;
    let spent = 0;
    for (let i = s.debris.length - 1; i >= 0; i--) {
      const d = s.debris[i];
      if (d.earthImpactSource === (rock.impactSource || rock)
        && s.time.now < d.earthImpactUntil) continue;
      if (!points.some((p) => Math.hypot(p.x - d.x, p.y - d.y) < PIXEL * 2.5)) continue;
      if (!bendHitReady(this.hitCooldowns, d, s.time.now, 180)) continue;
      const resistance = PixelWorld.IMPACT_RESISTANCE[d.mat];
      if (!Number.isFinite(resistance)) continue;
      if (energy - spent >= resistance) {
        s.debris.splice(i, 1);
        spent += resistance;
        s.fx.shards(d.x, d.y, 4, 'Earth');
      } else {
        const transfer = Math.min(0.65, Math.sqrt(rock.cells.length) * 0.15);
        d.vx += rock.vx * transfer;
        d.vy += rock.vy * transfer - 25;
      }
    }
    if (spent) this.spendImpactEnergy(rock, spent, energy);
  }

  impactEnergy(rock, speed = Math.hypot(rock.vx, rock.vy)) {
    if (speed < EARTH_BEND.MIN_IMPACT_SPEED) return 0;
    return rock.cells.length * (speed / EARTH_BEND.IMPACT_SPEED_SCALE) ** 2;
  }

  spendImpactEnergy(rock, spent, energy) {
    const retained = Math.sqrt(Math.max(0, 1 - spent / energy));
    rock.vx *= retained;
    rock.vy *= retained;
  }

  // Fracture spreads from actual contact pixels through connected material.
  // Its finite energy budget buys fewer pixels in masonry than in soil or wood.
  // Every broken pixel consumes momentum, so penetration is also finite.
  crumbleTerrain(rock, contacts) {
    const energy = this.impactEnergy(rock);
    if (!energy || !contacts.length) return 0;
    const s = this.scene;
    const radius = Math.min(EARTH_BEND.MAX_CRUMBLE_RADIUS,
      Math.max(1, Math.ceil(Math.cbrt(energy) * 0.7 + Math.sqrt(rock.cells.length) * 0.14)));
    const meanX = contacts.reduce((sum, c) => sum + c.x, 0) / contacts.length;
    const meanY = contacts.reduce((sum, c) => sum + c.y, 0) / contacts.length;
    // A hollow or orbiting rock can touch opposite sides of an empty gap.
    // Anchor the crater on a real contact instead of the air between them.
    const center = contacts.reduce((best, c) =>
      Math.hypot(c.x - meanX, c.y - meanY) < Math.hypot(best.x - meanX, best.y - meanY) ? c : best);
    const cx = center.x, cy = center.y;
    const queue = [];
    const seen = new Set();
    const enqueue = (x, y) => {
      if (x <= 0 || x >= COLS - 1 || y <= 0 || y >= ROWS - 1) return;
      const distance2 = (x - cx) ** 2 + (y - cy) ** 2;
      if (distance2 > radius * radius) return;
      const id = s.idx(x, y);
      if (seen.has(id) || !IS_SOLID[s.grid[id]]) return;
      seen.add(id);
      queue.push({ x, y, id, distance2 });
    };
    for (const contact of contacts) enqueue(contact.x, contact.y);
    let spent = 0, broken = 0, chunks = 0;
    const budget = energy * 0.7;
    for (let head = 0; head < queue.length && broken < EARTH_BEND.MAX_CRUMBLE_CELLS; head++) {
      const cell = queue[head];
      const mat = s.grid[cell.id];
      const cost = PixelWorld.IMPACT_RESISTANCE[mat]
        * (1 + cell.distance2 / (radius * radius) * 0.8);
      if (!Number.isFinite(cost) || spent + cost > budget) continue;
      // Spawn before clearing: the cell's palette variant belongs to the rubble.
      if (chunks < EARTH_BEND.CRUMBLE_DEBRIS) {
        const debris = s.spawnDebris(cell.x, cell.y, mat, cx, cy, true);
        if (debris) {
          debris.vx = rock.vx * 0.22 + (cell.x - cx) * 14;
          debris.vy = rock.vy * 0.12 + (cell.y - cy) * 14 - 80;
          debris.earthImpactSource = rock.impactSource || rock;
          debris.earthImpactUntil = s.time.now + 160;
          chunks++;
        }
      }
      s.setCell(cell.id, EMPTY);
      spent += cost;
      broken++;
      enqueue(cell.x - 1, cell.y);
      enqueue(cell.x + 1, cell.y);
      enqueue(cell.x, cell.y - 1);
      enqueue(cell.x, cell.y + 1);
    }
    if (!broken) return 0;
    this.spendImpactEnergy(rock, spent, energy);
    // Queue one support pass rather than scanning the whole world per fragment.
    if (!s.multiplayer) s.collapseTimer = Math.min(s.collapseTimer ?? 120, 30);
    const x = cx * PIXEL + PIXEL / 2, y = cy * PIXEL + PIXEL / 2;
    s.fx.shards(x, y, Math.min(36, 3 + broken / 3), 'Earth',
      { speed: Math.min(240, 80 + Math.sqrt(energy) * 6), size: 1.2, life: 0.45 });
    s.fx.smoke(x, y, Math.min(12, 2 + broken / 12), 'Earth',
      { speed: 35, rise: 45, size: 1.4, life: 0.7 });
    if (!rock.fragment) {
      s.fx.shake('Earth', Math.min(0.012, 0.001 + Math.sqrt(spent) * 0.0004), 130);
      if (broken >= 12) s.fx.hitstop(Math.min(55, 25 + broken / 8));
    }
    return broken;
  }

  // Pry earth loose near the cursor, nearest first. Never from directly under the
  // bender's feet — lifting your own footing would drop you into the hole.
  grab(dt) {
    const s = this.scene;
    const rock = this.rock;
    if (this.holding >= EARTH_BEND.CAPACITY) { this.grabAcc = 0; return; }
    this.grabAcc += EARTH_BEND.GRAB_RATE * dt;
    if (this.grabAcc < 1) return;

    const p = s.player;
    const pgx = (p.x + p.w / 2) / PIXEL, pgy = (p.y + p.h / 2) / PIXEL;
    const fx0 = Math.floor(p.x / PIXEL), fx1 = Math.floor((p.x + p.w - 1) / PIXEL);
    const feet = Math.floor((p.y + p.h) / PIXEL);
    const pointer = s.input.activePointer;
    const cgx = Math.floor(pointer.worldX / PIXEL), cgy = Math.floor(pointer.worldY / PIXEL);
    for (const [dx, dy] of this.grabOffsets) {
      if (this.holding >= EARTH_BEND.CAPACITY) break;
      const x = cgx + dx, y = cgy + dy;
      if (x <= 0 || x >= COLS - 1 || y <= 0 || y >= ROWS - 1) continue;
      if (x >= fx0 && x <= fx1 && y >= feet && y < feet + EARTH_BEND.FOOTING) continue;
      const id = s.idx(x, y);
      const m = s.grid[id];
      const cost = this.loose.has(m) ? 1 : this.hard.has(m) ? 2 : 0;
      if (!cost) continue;
      if (this.grabAcc < cost) break;
      if (Math.hypot(x - pgx, y - pgy) > EARTH_BEND.REACH) continue;
      const variant = s.life[id];
      s.setCell(id, EMPTY);
      this.grabAcc -= cost;
      this.pieces.push({
        x: x * PIXEL + PIXEL / 2, y: y * PIXEL + PIXEL / 2,
        mat: m, variant, slot: rock.nextSlot++,
      });
    }
    // Nothing left to lift under the cursor: do not bank effort for later.
    this.grabAcc = Math.min(this.grabAcc, 2);
  }

  // Lifted pieces fly straight to their slot in the rock, through anything — they are
  // being pulled — and fuse into it as stone when they arrive.
  flyPieces(dt) {
    const rock = this.rock;
    const stepLen = EARTH_BEND.PIECE_SPEED * dt;
    for (let i = this.pieces.length - 1; i >= 0; i--) {
      const pc = this.pieces[i];
      const [ox, oy] = this.slots[pc.slot];
      const tx = rock.x + ox * PIXEL, ty = rock.y + oy * PIXEL;
      const dx = tx - pc.x, dy = ty - pc.y;
      const d = Math.hypot(dx, dy);
      if (d <= stepLen) {
        rock.cells.push({ ox, oy, shade: (Math.random() * 4) | 0 });
        this.pieces.splice(i, 1);
        if (Math.random() < 0.3) {
          this.scene.fx.burst(tx, ty, 2, 'Earth', { speed: 30, life: 0.3, size: 1.1 });
        }
      } else {
        pc.x += (dx / d) * stepLen;
        pc.y += (dy / d) * stepLen;
      }
    }
  }

  // The rock follows the cursor as one body. Its top speed drops as it grows, so a
  // pebble whips around and a boulder lumbers.
  steerRock(dt) {
    const rock = this.rock;
    const t = bendTarget(this.scene, EARTH_BEND.REACH);
    const mass = rock.cells.length / EARTH_BEND.CAPACITY;
    const max = EARTH_BEND.MAX_SPEED * (1 - EARTH_BEND.HEAVY_SLOWDOWN * mass);
    let wx = (t.x - rock.x) * EARTH_BEND.FOLLOW, wy = (t.y - rock.y) * EARTH_BEND.FOLLOW;
    const w = Math.hypot(wx, wy);
    if (w > max) { wx *= max / w; wy *= max / w; }
    const turn = Math.min(1, EARTH_BEND.RESPONSE * dt);
    rock.vx += (wx - rock.vx) * turn;
    rock.vy += (wy - rock.vy) * turn;
    // A held rock is dug out of the ground it sits in, and it is exactly the shape of
    // its own hole, so it has to be allowed to scrape — see rockCollides.
    this.moveRock(rock, dt, 'held');
  }

  // Orbit form: the rock never chases the cursor at all. It pins to the
  // bender and its cells rotate in place around that centre — a spinning
  // clump rather than a followed boulder — striking anything it swings past.
  // Contacts use their tangential speed, including movement of the caster.
  steerOrbitRock(dt) {
    const rock = this.rock;
    const p = this.scene.player;
    const tether = Math.exp(-5 * dt);
    rock.orbitDriftX = Math.max(-ORBIT.RADIUS, Math.min(ORBIT.RADIUS,
      ((rock.orbitDriftX || 0) + rock.vx * dt) * tether));
    rock.orbitDriftY = Math.max(-ORBIT.RADIUS, Math.min(ORBIT.RADIUS,
      ((rock.orbitDriftY || 0) + rock.vy * dt) * tether));
    rock.x = p.x + p.w / 2 + rock.orbitDriftX;
    rock.y = p.y + p.h / 2 + rock.orbitDriftY;
    const oldX = rock.orbitCenterX ?? rock.x, oldY = rock.orbitCenterY ?? rock.y;
    const centerVx = dt > 0 ? (rock.x - oldX) / dt : 0;
    const centerVy = dt > 0 ? (rock.y - oldY) / dt : 0;
    rock.orbitCenterX = rock.x; rock.orbitCenterY = rock.y;
    rock.vx *= tether;
    rock.vy *= tether;
    const dtheta = ORBIT.SPIN * dt;
    const cos = Math.cos(dtheta), sin = Math.sin(dtheta);
    const contacts = new Map();
    let fastest = { vx: centerVx, vy: centerVy, speed: Math.hypot(centerVx, centerVy) };
    for (const c of rock.cells) {
      const before = this.solidAt(oldX + c.ox * PIXEL, oldY + c.oy * PIXEL);
      const nx = c.ox * cos - c.oy * sin;
      const ny = c.ox * sin + c.oy * cos;
      c.ox = nx; c.oy = ny;
      const px = rock.x + nx * PIXEL, py = rock.y + ny * PIXEL;
      if (!before && this.solidAt(px, py)) {
        const gx = Math.floor(px / PIXEL), gy = Math.floor(py / PIXEL);
        contacts.set(this.scene.idx(gx, gy), { x: gx, y: gy });
      }
      const vx = centerVx - ny * PIXEL * ORBIT.SPIN;
      const vy = centerVy + nx * PIXEL * ORBIT.SPIN;
      const speed = Math.hypot(vx, vy);
      if (speed > fastest.speed) fastest = { vx, vy, speed };
      c.hitCd = (c.hitCd || 0) - dt;
      if (c.hitCd <= 0) {
        if (orbitStrike(this.scene, px, py, 220)) c.hitCd = ORBIT.HIT_COOLDOWN;
      }
    }
    const impactRock = { ...rock, vx: fastest.vx, vy: fastest.vy, impactSource: rock };
    if (contacts.size && this.scene.time.now >= (rock.orbitImpactUntil || 0)) {
      this.crumbleTerrain(impactRock, [...contacts.values()]);
      rock.orbitImpactUntil = this.scene.time.now + 220;
    }
    this.strikeBodies(impactRock, fastest.speed);
  }

  updateThrown(dt) {
    for (let i = this.thrown.length - 1; i >= 0; i--) {
      const rock = this.thrown[i];
      // Let go while buried in the ground: it simply stays there.
      if (rock.age === 0 && rock.cells.every((c) => this.solidAt(rock.x + c.ox * PIXEL, rock.y + c.oy * PIXEL))) {
        this.stamp(rock);
        this.thrown.splice(i, 1);
        continue;
      }
      rock.age += dt;
      rock.vy += EARTH_BEND.GRAVITY * dt;
      rock.vx *= 1 - Math.min(1, 0.3 * dt);
      const hit = this.moveRock(rock, dt, 'thrown');
      if (hit.down || rock.age > EARTH_BEND.FREE_LIFE) {
        this.stamp(rock);
        this.thrown.splice(i, 1);
      }
    }
  }

  // Moves a rock by its velocity in sub-steps of at most one cell, blocked per axis.
  // A sideways hit stops the sideways motion (it slides down the wall); a hit from
  // above is a landing.
  moveRock(rock, dt, mode) {
    const hit = { side: false, down: false, up: false };
    const dist = Math.max(Math.abs(rock.vx), Math.abs(rock.vy)) * dt;
    const steps = Math.max(1, Math.ceil(dist / PIXEL));
    for (let k = 0; k < steps; k++) {
      const impactSpeed = Math.hypot(rock.vx, rock.vy);
      const sx = (rock.vx * dt) / steps, sy = (rock.vy * dt) / steps;
      if (sx) {
        if (this.rockCollides(rock, sx, 0, mode)) { hit.side = true; rock.vx = 0; } else rock.x += sx;
      }
      if (sy) {
        if (this.rockCollides(rock, 0, sy, mode)) {
          if (sy > 0) hit.down = true; else hit.up = true;
          rock.vy = 0;
        } else rock.y += sy;
      }
      this.strikeBodies(rock, impactSpeed);
      if (hit.down) break;
    }
    return hit;
  }

  // Newly entering pixels receive an impact before deciding whether terrain
  // stops the rock. Held rocks retain their extraction tolerance; thrown rocks
  // ignore pixels they were already embedded in when released against a wall.
  rockCollides(rock, dx, dy, mode) {
    const occupancy = [];
    const contacts = new Map();
    for (const c of rock.cells) {
      const px = rock.x + c.ox * PIXEL, py = rock.y + c.oy * PIXEL;
      const x = px + dx, y = py + dy;
      const before = this.solidAt(px, py);
      occupancy.push({ x, y, before });
      if (!before && this.solidAt(x, y)) {
        const gx = Math.floor(x / PIXEL), gy = Math.floor(y / PIXEL);
        contacts.set(this.scene.idx(gx, gy), { x: gx, y: gy });
      }
    }
    this.crumbleTerrain(rock, [...contacts.values()]);
    if (mode === 'held') {
      const before = occupancy.filter((cell) => cell.before).length;
      const after = occupancy.filter((cell) => this.solidAt(cell.x, cell.y)).length;
      return after > before && after > Math.max(1, rock.cells.length * 0.15);
    }
    return occupancy.some((cell) => !cell.before && this.solidAt(cell.x, cell.y));
  }

  solidAt(px, py) {
    const gx = Math.floor(px / PIXEL), gy = Math.floor(py / PIXEL);
    if (gx <= 0 || gx >= COLS - 1 || gy <= 0 || gy >= ROWS - 1) return true;
    return IS_SOLID[this.scene.grid[this.scene.idx(gx, gy)]] === 1;
  }

  // Land: write the rock into the world as stone, cell for cell. From here on it is
  // ordinary terrain, and the world's support pass decides whether it stays put.
  stamp(rock) {
    const s = this.scene;
    const M = PixelWorld.MAT;
    // Bottom rows first, so the rock settles onto what it landed on.
    const cells = rock.cells.slice().sort((a, b) => b.oy - a.oy);
    for (const c of cells) {
      const gx = Math.floor((rock.x + c.ox * PIXEL) / PIXEL);
      const gy = Math.floor((rock.y + c.oy * PIXEL) / PIXEL);
      this.placeStone(gx, gy, c.shade, M);
    }
    const n = rock.cells.length;
    if (rock.fragment) {
      if (Math.random() < 0.3) s.fx.burst(rock.x, rock.y, 2, 'Earth',
        { speed: 40, life: 0.25, size: 0.8 });
      return;
    }
    s.fx.burst(rock.x, rock.y + 4, Math.min(24, 4 + n / 6), 'Earth', { speed: 70, life: 0.6, rise: 30 });
    s.fx.shake('Earth', Math.min(0.01, 0.002 + n * 0.00005), 140);
  }

  // One stone cell at (gx, gy), or as near to it as there is room. Water it lands
  // in is pushed aside rather than deleted — the rock displaces it.
  placeStone(gx, gy, shade, M) {
    const s = this.scene;
    for (const [dx, dy] of this.settleOffsets) {
      const x = gx + dx, y = gy + dy;
      if (x <= 0 || x >= COLS - 1 || y <= 0 || y >= ROWS - 1) continue;
      const id = s.idx(x, y);
      const m = s.grid[id];
      if (m === WATER) {
        if (!this.putNear(x, y, WATER, 0)) continue;
      } else if (!this.open.has(m)) continue;
      s.setCell(id, M.STONE, shade);
      return;
    }
  }

  // The nearest open cell to (gx, gy) gets `mat`. Returns false if there is none.
  putNear(gx, gy, mat, variant) {
    const s = this.scene;
    for (const [dx, dy] of this.settleOffsets) {
      const x = gx + dx, y = gy + dy;
      if (x <= 0 || x >= COLS - 1 || y <= 0 || y >= ROWS - 1) continue;
      const id = s.idx(x, y);
      if (s.grid[id] === EMPTY) { s.setCell(id, mat, variant); return true; }
    }
    return false;
  }

  // Pieces let go mid-flight fall as what they were and land as that material.
  updateLoose(dt) {
    for (let i = this.loosePieces.length - 1; i >= 0; i--) {
      const pc = this.loosePieces[i];
      pc.age += dt;
      pc.vy += EARTH_BEND.GRAVITY * dt;
      const steps = Math.max(1, Math.ceil(Math.max(Math.abs(pc.vx), Math.abs(pc.vy)) * dt / PIXEL));
      let landed = false;
      for (let k = 0; k < steps && !landed; k++) {
        const nx = pc.x + pc.vx * dt / steps;
        if (this.solidAt(nx, pc.y)) pc.vx *= -0.15; else pc.x = nx;
        const ny = pc.y + pc.vy * dt / steps;
        if (this.solidAt(pc.x, ny)) {
          landed = pc.vy >= 0;
          pc.vy = 0;
        } else pc.y = ny;
      }
      if (landed || pc.age > EARTH_BEND.FREE_LIFE) {
        this.putNear(Math.floor(pc.x / PIXEL), Math.floor(pc.y / PIXEL), pc.mat, pc.variant);
        this.loosePieces.splice(i, 1);
      }
    }
  }

  draw() {
    const g = this.gfx;
    g.clear();
    const stone = PALETTE[PixelWorld.MAT.STONE];
    const color = (c) => Phaser.Display.Color.GetColor(c[0], c[1], c[2]);
    const drawRock = (rock, held) => {
      if (held && rock.cells.length > 4) {
        const r = Math.sqrt(rock.cells.length / Math.PI) * PIXEL + 5;
        g.fillStyle(0xc8a064, 0.1);
        g.fillCircle(rock.x, rock.y, r);
      }
      for (const c of rock.cells) {
        g.fillStyle(color(stone[c.shade % stone.length]), 1);
        g.fillRect(rock.x + c.ox * PIXEL - PIXEL / 2, rock.y + c.oy * PIXEL - PIXEL / 2, PIXEL, PIXEL);
      }
    };
    if (this.rock) drawRock(this.rock, true);
    for (const rock of this.thrown) drawRock(rock, false);
    for (const list of [this.pieces, this.loosePieces]) {
      for (const pc of list) {
        const pal = PALETTE[pc.mat];
        g.fillStyle(color(pal[(pc.variant || 0) % pal.length]), 1);
        g.fillRect(pc.x - PIXEL / 2, pc.y - PIXEL / 2, PIXEL, PIXEL);
      }
    }
  }
}

// ---------------------------------------------------------------------------
// fire
// ---------------------------------------------------------------------------
//
// Water is lifted and earth is torn loose, but there is no fire lying in the
// grid to take — fire is the one element a bender creates instead of moves.
// Holding the button kindles embers at the caster's hand and pulls them to the
// cursor. They swirl into a blob the same way held water does, but an ember is burning on
// borrowed time: left held too long, it simply burns itself out and is gone,
// so a fire bender can't bank an endless stockpile the way water and earth can.
//
// Let go and the embers fly on their momentum, exactly like a thrown drop of
// water. One that touches something flammable sets it alight on contact and is
// spent doing it, one that touches water is snuffed out, and one that lands
// anywhere else simply becomes an ordinary fire cell and burns down the way any
// other fire does (world.js, updateFire) — a small ember, so it gets less life
// than a stoked blaze.

const FIRE_BEND = {
  GRAB_RADIUS: 6,        // targeting ring shown at the cursor
  CONJURE_RATE: 90,      // embers created per second while the button is held
  CAPACITY: 120,         // embers held at once — less than water or earth, since
                          // this mass is free and needs some cap of its own
  REACH: 95,             // cells from the bender embers may be held at
  FOLLOW: 8,             // how hard an ember is pulled toward its place in the blob
  RESPONSE: 10,          // how quickly an ember's velocity turns toward that pull
  MAX_SPEED: 560,        // px/s
  SPACING: 0.6,          // blob packing, as water
  SWIRL: 1.4,            // rad/s — embers churn faster than water; fire doesn't sit still
  GRAVITY: 480,          // px/s² on released embers — lighter than water or stone
  SETTLE_RADIUS: 6,      // how far a landing ember looks for an open cell
  FREE_LIFE: 3,          // seconds a thrown ember may fly before it burns out unlanded
  HOLD_LIFE: 6,          // seconds a kindled ember may be held before it burns out
  EMBER_LIFE_FRAC: 0.5,  // an ember that lands with no fuel gets this fraction of FIRE_LIFE
  BALL_SPEED: 440,       // px/s after a Bolt Punch
  BALL_LIFE: 2.2,        // a missed ball cannot fly forever
  PUNCH_KICK: 340,      // px/s outward speed after an Orbit Punch
};

class FireBending {
  constructor(scene) {
    this.scene = scene;
    this.element = 'Fire';
    this.form = 'Bolt'; // 'Bolt' | 'Orbit' — set by game.js's bend-form wheel
    this.grabRadius = FIRE_BEND.GRAB_RADIUS;
    this.held = [];    // embers following the cursor: { x, y, vx, vy, life }
    this.free = [];    // released embers, flying until they land or burn out: { x, y, vx, vy, age }
    this.fireballs = []; // cohesive Bolt Punch projectiles made from the held embers
    this.active = false;
    this.grabAcc = 0;
    this.settleOffsets = bendDiscOffsets(FIRE_BEND.SETTLE_RADIUS);
    this.gfx = scene.add.graphics().setDepth(8.5);
    this.hitCooldowns = new Map();
    this.casterFxAcc = 0;
    this.surfaceDamage = bendSurfaceDamage(scene);
  }

  begin() {
    this.active = true;
    this.grabAcc = 0;
    this.casterFxAcc = 0;
    this.scene.emitFireCasterParticles(10);
  }

  // Let go of everything held. Bolt's embers keep their velocity, which is the
  // throw; Orbit's get an outward kick instead, so letting go of a ring reads
  // as releasing it rather than an arbitrary scatter.
  release() {
    if (!this.active && !this.held.length) return;
    this.active = false;
    const p = this.scene.player;
    const cx = p.x + p.w / 2, cy = p.y + p.h / 2;
    for (const d of this.held) {
      d.age = 0;
      if (this.form === 'Orbit') {
        const dx = d.x - cx, dy = d.y - cy;
        const dist = Math.max(1, Math.hypot(dx, dy));
        d.vx += (dx / dist) * ORBIT.RELEASE_KICK;
        d.vy += (dy / dist) * ORBIT.RELEASE_KICK;
      }
      this.free.push(d);
    }
    this.held.length = 0;
  }

  get holding() {
    return this.held.length;
  }

  // Right-click Punch consumes the hovering fire. Bolt compresses it into a
  // travelling ball; Orbit releases the same embers in every direction.
  punch() {
    if (!this.held.length) return false;
    const s = this.scene;
    const p = s.player;
    const cx = p.x + p.w / 2, cy = p.y + p.h / 2;
    const count = this.held.length;
    if (this.form === 'Orbit') {
      const phase = this.spin || 0;
      for (let i = 0; i < count; i++) {
        const ember = this.held[i];
        const distance = Math.hypot(ember.x - cx, ember.y - cy);
        const angle = distance > 1
          ? Math.atan2(ember.y - cy, ember.x - cx)
          : phase + i * Math.PI * 2 / count;
        ember.vx = Math.cos(angle) * FIRE_BEND.PUNCH_KICK;
        ember.vy = Math.sin(angle) * FIRE_BEND.PUNCH_KICK;
        ember.age = 0;
        this.free.push(ember);
      }
      this.held.length = 0;
      const radius = ORBIT.RADIUS + 12;
      this.damageBurst(cx, cy, radius, Math.min(26, 5 + count * 0.14));
      this.burnDebris(cx, cy, radius, 0.15 + Math.sqrt(count) * 0.05);
      s.fx.shockwave(cx, cy, 'Fire',
        { r0: ORBIT.RADIUS * 0.35, r1: radius * 1.7, life: 0.38, width: 3, rings: 2 });
      s.fx.burst(cx, cy, Math.min(35, 8 + count / 3), 'Fire',
        { speed: 160, life: 0.5, rise: 20, size: 1.4 });
    } else {
      let x = 0, y = 0;
      for (const ember of this.held) { x += ember.x; y += ember.y; }
      x /= count; y /= count;
      const aim = s.input.activePointer;
      const dx = aim.worldX - cx, dy = aim.worldY - cy;
      const dist = Math.hypot(dx, dy);
      const ux = dist > 1 ? dx / dist : (p.facing || 1);
      const uy = dist > 1 ? dy / dist : 0;
      const size = Math.min(16, 5 + Math.sqrt(count) * 0.85);
      const embers = [];
      const visualCount = Math.max(12, Math.min(96, count));
      for (let i = 0; i < visualCount; i++) {
        const held = this.held[i % count];
        const offsetX = held.x - x, offsetY = held.y - y;
        const offset = Math.hypot(offsetX, offsetY);
        embers.push({
          angle: offset > 1 ? Math.atan2(offsetY, offsetX) : i * BEND_GOLDEN,
          radius: Math.min(size * 0.9, offset * 0.24 + size * (0.2 + Math.random() * 0.5)),
          spin: (i % 2 ? 1 : -1) * (3 + Math.random() * 6),
          phase: Math.random() * Math.PI * 2,
          scale: 0.65 + Math.random() * 0.8,
        });
      }
      this.fireballs.push({
        x, y, vx: ux * FIRE_BEND.BALL_SPEED, vy: uy * FIRE_BEND.BALL_SPEED,
        size, mass: count, life: FIRE_BEND.BALL_LIFE, age: 0, trail: 0, embers,
      });
      this.held.length = 0;
      s.fx.burst(x, y, 20, 'Fire', { speed: 110, life: 0.42, size: 1.5, shape: 'square' });
      s.fx.streaks(x, y, 9, 'Fire', { speed: 180, life: 0.24, size: 1.2 });
    }
    return true;
  }

  // Both Punch forms use the same body damage and burn rules, and neither
  // includes the caster in its contact list.
  damageBurst(x, y, radius, amount) {
    const s = this.scene;
    const now = s.time.now;
    for (const target of bendContacts(s, [{ x, y }], radius)) {
      if (!bendBodyWithin(target.body, x, y, radius)) continue;
      if (target.enemy) {
        s.damageEnemy(target.enemy, amount, 'Fire');
        target.enemy.burnUntil = now + 1200;
      } else {
        s.reportHit(target.id, 'Fire', amount, null, { burnMs: 1200 });
      }
    }
  }

  burnDebris(x, y, radius, heat = 0.3) {
    const s = this.scene;
    for (const obj of [...s.debris]) {
      if (Math.hypot(obj.x - x, obj.y - y) > radius) continue;
      this.surfaceDamage.object(obj, heat, 'Fire');
    }
  }

  igniteBurst(x, y, radius, heat = 0.3) {
    const s = this.scene;
    const gx = Math.floor(x / PIXEL), gy = Math.floor(y / PIXEL);
    for (let dy = -radius; dy <= radius; dy++) {
      for (let dx = -radius; dx <= radius; dx++) {
        const distance = Math.hypot(dx, dy);
        if (distance > radius || Math.random() > 0.65 * (1 - distance / (radius + 1))) continue;
        const xx = gx + dx, yy = gy + dy;
        if (xx <= 0 || xx >= COLS - 1 || yy <= 0 || yy >= ROWS - 1) continue;
        const id = s.idx(xx, yy);
        const mat = s.grid[id];
        if (mat === EMPTY || mat === SMOKE || mat === GAS) {
          s.setCell(id, FIRE, PixelWorld.FIRE_LIFE);
        } else if (IS_SOLID[mat] && bendExposedCell(s, xx, yy)) {
          this.igniteCell(xx, yy, heat * (1 - distance / (radius + 1)));
        }
      }
    }
  }

  explodeFireball(ball, radius, heat) {
    const s = this.scene;
    const reach = radius * PIXEL * 1.4;
    const power = Math.min(9, 1.2 + Math.sqrt(ball.mass) * 0.5);
    const speed = Math.hypot(ball.vx, ball.vy);
    // Back up one flight substep so a wall impact originates outside the wall.
    const ox = ball.x - (speed > 0 ? ball.vx / speed * PIXEL : 0);
    const oy = ball.y - (speed > 0 ? ball.vy / speed * PIXEL : 0);
    const pressureAt = (x, y) => {
      let pressure = power * Math.max(0, 1 - Math.hypot(x - ball.x, y - ball.y) / reach);
      const steps = Math.ceil(Math.hypot(x - ox, y - oy) / PIXEL);
      let previous = -1;
      const end = s.idx(Math.floor(x / PIXEL), Math.floor(y / PIXEL));
      for (let i = 0; i < steps && pressure > 0; i++) {
        const gx = Math.floor((ox + (x - ox) * i / steps) / PIXEL);
        const gy = Math.floor((oy + (y - oy) * i / steps) / PIXEL);
        if (gx < 0 || gx >= COLS || gy < 0 || gy >= ROWS) return 0;
        const id = s.idx(gx, gy);
        if (id === previous || id === end) continue;
        previous = id;
        if (IS_SOLID[s.grid[id]]) pressure -= PixelWorld.IMPACT_RESISTANCE[s.grid[id]] * 0.8;
      }
      return Math.max(0, pressure);
    };
    // Sample the intact wall before changing any cells, so the crater cannot
    // keep growing through material destroyed earlier in this same explosion.
    const cells = [];
    const gx = Math.floor(ball.x / PIXEL), gy = Math.floor(ball.y / PIXEL);
    for (let dy = -radius; dy <= radius; dy++) {
      for (let dx = -radius; dx <= radius; dx++) {
        if (Math.hypot(dx, dy) > radius) continue;
        const x = gx + dx, y = gy + dy;
        if (x <= 0 || x >= COLS - 1 || y <= 0 || y >= ROWS - 1) continue;
        if (!Number.isFinite(PixelWorld.IMPACT_RESISTANCE[s.grid[s.idx(x, y)]])) continue;
        const pressure = pressureAt(x * PIXEL + PIXEL / 2, y * PIXEL + PIXEL / 2);
        if (pressure > 0) cells.push({ x, y, pressure });
      }
    }
    const objects = s.debris.map((obj) => ({ obj, pressure: pressureAt(obj.x, obj.y) }));
    const push = (obj, pressure) => {
      const dx = obj.x - ball.x, dy = obj.y - ball.y;
      const distance = Math.hypot(dx, dy);
      const ux = distance > 0.01 ? dx / distance : (speed > 0 ? ball.vx / speed : 0);
      const uy = distance > 0.01 ? dy / distance : (speed > 0 ? ball.vy / speed : -1);
      const resistance = PixelWorld.IMPACT_RESISTANCE[obj.mat];
      const kick = pressure * 65 / Math.sqrt(Math.max(1, resistance || 1));
      obj.vx = (obj.vx || 0) + ux * kick;
      obj.vy = (obj.vy || 0) + uy * kick - kick * 0.25;
      obj.settleTimer = Math.max(obj.settleTimer || 0, 1);
      obj.bendCasterSafe = true;
    };
    for (const { obj, pressure } of objects) {
      if (pressure <= 0 || this.surfaceDamage.object(obj, pressure, 'Fire', true)) continue;
      push(obj, pressure);
      this.surfaceDamage.object(obj, heat * pressure / power, 'Fire');
    }
    const fragmentsStart = s.debris.length;
    for (const cell of cells) this.surfaceDamage.cell(cell.x, cell.y, cell.pressure, 'Fire', true);
    // Fresh fragments get the outward impulse without taking blast damage twice.
    for (const obj of s.debris.slice(fragmentsStart)) {
      const pressure = power * Math.max(0, 1 - Math.hypot(obj.x - ball.x, obj.y - ball.y) / reach);
      push(obj, pressure);
      this.surfaceDamage.object(obj, heat * pressure / power, 'Fire');
    }
  }

  impactFireball(ball, doused = false) {
    const s = this.scene;
    const radius = Math.min(14, Math.round(3 + Math.sqrt(ball.mass) * 0.8));
    if (!doused) {
      const heat = Math.min(0.9, 0.15 + Math.sqrt(ball.mass) * 0.06);
      this.explodeFireball(ball, radius, heat);
      this.igniteBurst(ball.x, ball.y, radius, heat);
      this.damageBurst(ball.x, ball.y, radius * PIXEL * 1.4,
        Math.min(36, 9 + ball.mass * 0.2));
    }
    s.fx.burst(ball.x, ball.y, Math.min(70, 20 + ball.mass / 2),
      doused ? 'Water' : 'Fire', { speed: 170, life: 0.65, rise: 35, size: 1.5,
        shape: 'square' });
    if (!doused) {
      s.fx.streaks(ball.x, ball.y, 16, 'Fire', { speed: 250, life: 0.3, size: 1.3 });
      s.fx.smoke(ball.x, ball.y, 7, 'Fire', { speed: 70, life: 0.9, size: 2.4, rise: 45 });
      s.fx.shockwave(ball.x, ball.y, 'Fire',
        { r0: ball.size, r1: radius * PIXEL * 1.9, life: 0.4, width: 3, rings: 2 });
      s.fx.hitstop(35);
    }
    s.fx.ring(ball.x, ball.y, doused ? 'Water' : 'Fire',
      { r0: 2, r1: radius * PIXEL * 1.6, life: 0.35, width: 3 });
    if (!doused) s.fx.shake('Fire', 0.004 + Math.min(ball.mass, 100) * 0.00004, 110);
  }

  fireballEmberPoint(ball, ember) {
    const angle = ember.angle + ball.age * ember.spin
      + Math.sin(ball.age * 13 + ember.phase) * 0.22;
    const radius = ember.radius * (0.76 + Math.sin(ball.age * 19 + ember.phase) * 0.2);
    return {
      x: ball.x + Math.cos(angle) * radius,
      y: ball.y + Math.sin(angle) * radius,
    };
  }

  emitFireballTrail(ball, fromX, fromY) {
    const s = this.scene;
    const distance = Math.hypot(ball.x - fromX, ball.y - fromY);
    if (distance < 0.001) return;
    const spacing = 7;
    const speed = Math.max(1, Math.hypot(ball.vx, ball.vy));
    const ux = ball.vx / speed, uy = ball.vy / speed;
    const sideX = -uy, sideY = ux;
    let next = spacing - ball.trail;
    while (next <= distance) {
      const t = next / distance;
      const scatter = (Math.random() - 0.5) * ball.size * 1.4;
      const x = fromX + (ball.x - fromX) * t + sideX * scatter;
      const y = fromY + (ball.y - fromY) * t + sideY * scatter;
      s.fx.burst(x, y, 2, 'Fire', {
        speed: 55, angle: Math.atan2(-uy, -ux), spread: 1.6,
        life: 0.48, rise: 20, size: 1.2, shape: 'square',
        color: Math.random() < 0.35 ? FX_PALETTE.Fire.core : FX_PALETTE.Fire.spark,
      });
      if (Math.random() < 0.25) {
        s.fx.smoke(x, y, 1, 'Fire', { speed: 18, life: 0.6, size: 1.3, rise: 25 });
      }
      next += spacing;
    }
    ball.trail = (ball.trail + distance) % spacing;
  }

  updateFireballs(dt) {
    const s = this.scene;
    for (let i = this.fireballs.length - 1; i >= 0; i--) {
      const ball = this.fireballs[i];
      ball.life -= dt;
      ball.age += dt;
      const fromX = ball.x, fromY = ball.y;
      const steps = Math.max(1, Math.ceil(Math.max(Math.abs(ball.vx), Math.abs(ball.vy)) * dt / PIXEL));
      const sx = ball.vx * dt / steps, sy = ball.vy * dt / steps;
      let impact = false, doused = false;
      for (let k = 0; k < steps; k++) {
        ball.x += sx; ball.y += sy;
        const gx = Math.floor(ball.x / PIXEL), gy = Math.floor(ball.y / PIXEL);
        if (gx <= 0 || gx >= COLS - 1 || gy <= 0 || gy >= ROWS - 1) {
          impact = true; doused = true; break;
        }
        const mat = s.grid[s.idx(gx, gy)];
        if (mat === WATER) { impact = true; doused = true; break; }
        if (IS_SOLID[mat]) { impact = true; break; }
        if (s.debris.some((obj) => Math.hypot(obj.x - ball.x, obj.y - ball.y) <= ball.size + PIXEL)) {
          impact = true; break;
        }
        if (bendContacts(s, [ball], ball.size).some((t) => bendBodyWithin(t.body, ball.x, ball.y, ball.size))) {
          impact = true; break;
        }
      }
      if (ball.life <= 0) impact = true;
      this.emitFireballTrail(ball, fromX, fromY);
      if (impact) {
        this.impactFireball(ball, doused);
        this.fireballs.splice(i, 1);
        continue;
      }
    }
  }

  target() {
    return bendTarget(this.scene, FIRE_BEND.REACH);
  }

  update(dt) {
    // Anything that takes the left button away from fire bending lets the embers
    // go: dying, opening the spell wheel, switching to another mode or element.
    if (this.active && !bendSelected(this.scene, this.element)) this.release();

    if (this.active) this.grab(dt);
    if (this.active) {
      this.casterFxAcc += dt * 18;
      while (this.casterFxAcc >= 1) {
        this.casterFxAcc--;
        this.scene.emitFireCasterParticles(2);
      }
    }
    if (this.held.length) {
      if (this.form === 'Orbit') this.steerOrbit(dt); else this.steerHeld(dt);
    }
    if (this.free.length) this.updateFree(dt);
    if (this.fireballs.length) this.updateFireballs(dt);
    this.touchBodies();
    this.touchObjects();
    this.surfaceDamage.update(dt);
  }

  touchBodies() {
    const s = this.scene;
    const now = s.time.now;
    for (const target of bendContacts(s, [...this.held, ...this.free])) {
      const key = target.id || target.enemy;
      if (!bendHitReady(this.hitCooldowns, key, now, 230)) continue;
      if (target.enemy) {
        s.damageEnemy(target.enemy, 3, 'Fire');
        target.enemy.burnUntil = now + 1200;
      } else {
        s.reportHit(target.id, 'Fire', 3, null, { burnMs: 1200 });
      }
      s.fx.burst(target.body.x + target.body.w / 2, target.body.y + 3,
        5, 'Fire', { speed: 45, life: 0.4, rise: 55, size: 1.3 });
    }
  }

  touchObjects() {
    const s = this.scene;
    for (const obj of [...s.debris]) {
      if (!Number.isFinite(PixelWorld.IMPACT_RESISTANCE[obj.mat])) continue;
      let ember = null;
      let list = null;
      for (const particles of [this.held, this.free]) {
        const found = particles.findIndex((d) => Math.hypot(d.x - obj.x, d.y - obj.y) < PIXEL * 2);
        if (found >= 0) { ember = found; list = particles; break; }
      }
      if (!list) continue;
      list.splice(ember, 1);
      this.surfaceDamage.object(obj, 0.08, 'Fire');
    }
  }

  // Kindle actual embers at the caster's hand. Steering carries them to the
  // cursor, so fire visibly travels from the body instead of appearing at aim.
  // Nothing is removed from the world when they are created.
  grab(dt) {
    if (this.held.length >= FIRE_BEND.CAPACITY) { this.grabAcc = 0; return; }
    const s = this.scene;
    this.grabAcc += FIRE_BEND.CONJURE_RATE * dt;
    let n = Math.floor(this.grabAcc);
    if (n <= 0) return;
    this.grabAcc -= n;

    const p = s.player;
    const sourceX = p.x + p.w / 2 + (p.facing || 1) * p.w * 0.35;
    const sourceY = p.y + p.h * 0.38;
    const target = this.target();
    const dx = target.x - sourceX, dy = target.y - sourceY;
    const dist = Math.max(1, Math.hypot(dx, dy));
    n = Math.min(n, FIRE_BEND.CAPACITY - this.held.length);
    for (let i = 0; i < n; i++) {
      this.held.push({
        x: sourceX + (Math.random() - 0.5) * 2,
        y: sourceY + (Math.random() - 0.5) * 2,
        vx: this.form === 'Orbit' ? 0 : dx / dist * 105,
        vy: this.form === 'Orbit' ? 0 : dy / dist * 105,
        life: FIRE_BEND.HOLD_LIFE,
      });
    }
    this.grabAcc = Math.min(this.grabAcc, 1);
  }

  // Each ember chases its own place in the blob, exactly as held water does, and
  // burns down while it's held — an ember whose life runs out just goes out.
  steerHeld(dt) {
    const { x: cx, y: cy } = this.target();
    const spin = (this.scene.time.now / 1000) * FIRE_BEND.SWIRL;
    const turn = Math.min(1, FIRE_BEND.RESPONSE * dt);
    for (let i = this.held.length - 1; i >= 0; i--) {
      const d = this.held[i];
      d.life -= dt;
      if (d.life <= 0) { this.held.splice(i, 1); continue; }
      const r = FIRE_BEND.SPACING * PIXEL * Math.sqrt(i + 0.5);
      const a = i * BEND_GOLDEN + spin;
      const tx = cx + Math.cos(a) * r, ty = cy + Math.sin(a) * r;
      let wx = (tx - d.x) * FIRE_BEND.FOLLOW, wy = (ty - d.y) * FIRE_BEND.FOLLOW;
      const w = Math.hypot(wx, wy);
      if (w > FIRE_BEND.MAX_SPEED) { wx *= FIRE_BEND.MAX_SPEED / w; wy *= FIRE_BEND.MAX_SPEED / w; }
      d.vx += (wx - d.vx) * turn;
      d.vy += (wy - d.vy) * turn;
      if (this.moveDrop(d, dt) === 'consumed') this.held.splice(i, 1);
    }
  }

  // Orbit form: instead of chasing the cursor, each ember takes a fixed slot
  // on a ring around the bender that spins for as long as the button is held,
  // igniting or striking anything it swings close to.
  steerOrbit(dt) {
    const s = this.scene;
    const p = s.player;
    const cx = p.x + p.w / 2, cy = p.y + p.h / 2;
    this.spin = (this.spin || 0) + ORBIT.SPIN * dt;
    const n = this.held.length;
    const turn = Math.min(1, FIRE_BEND.RESPONSE * dt);
    for (let i = n - 1; i >= 0; i--) {
      const d = this.held[i];
      d.life -= dt;
      if (d.life <= 0) { this.held.splice(i, 1); continue; }
      const a = (i / n) * Math.PI * 2 + this.spin;
      const tx = cx + Math.cos(a) * ORBIT.RADIUS, ty = cy + Math.sin(a) * ORBIT.RADIUS;
      let wx = (tx - d.x) * FIRE_BEND.FOLLOW, wy = (ty - d.y) * FIRE_BEND.FOLLOW;
      const w = Math.hypot(wx, wy);
      if (w > FIRE_BEND.MAX_SPEED) { wx *= FIRE_BEND.MAX_SPEED / w; wy *= FIRE_BEND.MAX_SPEED / w; }
      d.vx += (wx - d.vx) * turn;
      d.vy += (wy - d.vy) * turn;
      if (this.moveDrop(d, dt) === 'consumed') { this.held.splice(i, 1); continue; }
      d.hitCd = (d.hitCd || 0) - dt;
      if (d.hitCd <= 0 && orbitStrike(s, d.x, d.y, 150)) d.hitCd = ORBIT.HIT_COOLDOWN;
    }
  }

  updateFree(dt) {
    for (let i = this.free.length - 1; i >= 0; i--) {
      const d = this.free[i];
      d.age += dt;
      d.vy += FIRE_BEND.GRAVITY * dt;
      d.vx *= 1 - Math.min(1, 0.3 * dt);
      const res = this.moveDrop(d, dt);
      if (res === 'consumed') { this.free.splice(i, 1); continue; }
      if (res === 'blocked' || d.age > FIRE_BEND.FREE_LIFE) {
        this.settle(d);
        this.free.splice(i, 1);
      }
    }
  }

  // Moves one ember by its velocity in sub-steps of at most one cell, blocked per
  // axis like a water drop. Fuel keeps burning after an ember lights it; hard
  // surfaces accumulate heat while they block the ember. Water snuffs it out.
  moveDrop(d, dt) {
    const s = this.scene;
    const dist = Math.max(Math.abs(d.vx), Math.abs(d.vy)) * dt;
    const steps = Math.max(1, Math.ceil(dist / PIXEL));
    const sx = (d.vx * dt) / steps, sy = (d.vy * dt) / steps;
    let blocked = false;
    for (let k = 0; k < steps; k++) {
      if (this.solidAt(d.x + sx, d.y)) {
        if (this.igniteCell(Math.floor((d.x + sx) / PIXEL), Math.floor(d.y / PIXEL), dt * 1.6)) return 'consumed';
        blocked = true;
      } else d.x += sx;
      if (this.solidAt(d.x, d.y + sy)) {
        if (this.igniteCell(Math.floor(d.x / PIXEL), Math.floor((d.y + sy) / PIXEL), dt * 1.6)) return 'consumed';
        blocked = true;
      } else d.y += sy;
      const gx = Math.floor(d.x / PIXEL), gy = Math.floor(d.y / PIXEL);
      const id = s.idx(gx, gy);
      if (s.grid[id] === WATER) return 'consumed';
      if (this.igniteCell(gx, gy, dt * 1.6)) return 'consumed';
      const obj = s.debris.find((o) => Math.hypot(o.x - d.x, o.y - d.y) < PIXEL * 2
        && Number.isFinite(PixelWorld.IMPACT_RESISTANCE[o.mat]));
      if (obj) {
        this.surfaceDamage.object(obj, 0.08, 'Fire');
        return 'consumed';
      }
      if (blocked) break;
    }
    return blocked ? 'blocked' : 'ok';
  }

  // Direct contact starts a lasting burn; masonry needs sustained heating.
  igniteCell(gx, gy, heat = 0.08) {
    if (gx <= 0 || gx >= COLS - 1 || gy <= 0 || gy >= ROWS - 1) return false;
    const s = this.scene;
    const id = s.idx(gx, gy);
    const m = s.grid[id];
    const destroyed = this.surfaceDamage.cell(gx, gy, heat, 'Fire');
    return destroyed || PixelWorld.FLAMMABILITY[m] > 0;
  }

  solidAt(px, py) {
    const gx = Math.floor(px / PIXEL), gy = Math.floor(py / PIXEL);
    if (gx <= 0 || gx >= COLS - 1 || gy <= 0 || gy >= ROWS - 1) return true;
    return IS_SOLID[this.scene.grid[this.scene.idx(gx, gy)]] === 1;
  }

  // A landed ember that found no fuel becomes an ordinary fire cell in the
  // nearest open spot, and burns down exactly like any other. Wedged into a
  // sealed crevice with nowhere to go, it is simply lost — the same rare leak
  // water's settle has.
  settle(d) {
    const s = this.scene;
    const M = PixelWorld.MAT;
    const gx = Math.floor(d.x / PIXEL), gy = Math.floor(d.y / PIXEL);
    for (const [dx, dy] of this.settleOffsets) {
      const x = gx + dx, y = gy + dy;
      if (x <= 0 || x >= COLS - 1 || y <= 0 || y >= ROWS - 1) continue;
      const id = s.idx(x, y);
      if (s.grid[id] === M.EMPTY) {
        s.setCell(id, M.FIRE, Math.round(PixelWorld.FIRE_LIFE * FIRE_BEND.EMBER_LIFE_FRAC));
        return;
      }
    }
  }

  draw() {
    const g = this.gfx;
    g.clear();
    if (!this.held.length && !this.free.length && !this.fireballs.length) return;
    const pal = FX_PALETTE.Fire;
    // A faint hot halo around the held blob, so a fire bender's swirl reads as
    // heat, not as a fistful of floating embers.
    if (this.held.length > 4) {
      let sx = 0, sy = 0;
      for (const d of this.held) { sx += d.x; sy += d.y; }
      const r = FIRE_BEND.SPACING * PIXEL * Math.sqrt(this.held.length) + 6;
      g.fillStyle(pal.glow, 0.14);
      g.fillCircle(sx / this.held.length, sy / this.held.length, r);
    }
    for (const list of [this.held, this.free]) {
      for (const d of list) {
        const speed = Math.abs(d.vx) + Math.abs(d.vy);
        g.fillStyle(speed > 320 ? pal.core : pal.glow, 1);
        // A hair larger than a cell, so embers at fractional positions do not
        // leave seams between them.
        g.fillRect(d.x - PIXEL / 2 - 0.5, d.y - PIXEL / 2 - 0.5, PIXEL + 1, PIXEL + 1);
      }
    }
    for (const ball of this.fireballs) {
      for (const ember of ball.embers) {
        const pt = this.fireballEmberPoint(ball, ember);
        const flicker = Math.sin(ball.age * 27 + ember.phase);
        const width = PIXEL * ember.scale * (0.8 + Math.max(0, flicker) * 0.35);
        const color = flicker > 0.55 ? pal.core : flicker < -0.4 ? pal.accent : pal.glow;
        g.fillStyle(pal.deep, 0.24).fillRect(pt.x - width, pt.y - width, width * 2, width * 2);
        g.fillStyle(color, 0.8 + Math.max(0, flicker) * 0.2)
          .fillRect(pt.x - width / 2, pt.y - width / 2, width, width);
      }
    }
  }
}

// ---------------------------------------------------------------------------
// air
// ---------------------------------------------------------------------------
//
// Air has nothing in the grid to lift and nothing to conjure as a substance,
// but it holds and throws exactly the same way water and fire do: holding the
// button gathers a swirling ball of wind at the cursor, made of the same kind
// of drifting wisps as Fire's embers, and it follows your hand — not rigidly,
// the same lag and catch-up as every other held blob here. Sweep and let go
// and the wisps keep whatever motion they had, so throwing a gust is a flick
// of the mouse, not a fixed-size explosion at a fixed range.
//
// A held or flying wisp-ball pushes everything near it — enemies, debris,
// projectiles — every frame it exists, and it carries smoke, gas and flame
// along with it, the one way a gust touches the grid. The push comes from the
// whole cluster's centre and size, not from each wisp separately, so a tight
// ball of ninety wisps doesn't hit ninety times harder than a loose one.
// The bender is pushed too when they stand in their own gust. Nothing about it
// draws, moves or creates a cell beyond that drift. A wisp is
// never matter, so it never lands as anything — held too long or flown too
// far, it simply dissipates.

const AIR_BEND = {
  GRAB_RADIUS: 6,        // cells around the cursor new wisps gather in
  CONJURE_RATE: 110,     // wisps drawn out of the air per second while held
  CAPACITY: 90,          // wisps held at once
  REACH: 100,            // cells from the bender a wisp may be held at
  FOLLOW: 9,             // how hard a wisp is pulled toward its place in the ball
  RESPONSE: 12,          // how quickly a wisp's velocity turns toward that pull — air answers fastest of the four
  MAX_SPEED: 640,        // px/s
  SPACING: 0.55,         // ball packing, as the other three
  SWIRL: 1.8,            // rad/s — the fastest churn of any held blob
  LOFT: 60,              // px/s² upward drift on a thrown wisp: air floats, it doesn't fall
  DRAG: 0.4,             // 1/s velocity bleed on a thrown wisp
  FREE_LIFE: 2.2,        // seconds a thrown gust may travel before it dissipates
  HOLD_LIFE: 5,          // seconds a held wisp may be sustained before it dissipates
  HOLD_ACCEL: 900,       // px/s² the held ball pushes with, scaled by dt
  THROW_ACCEL: 1500,     // px/s² a moving gust pushes with — a current hits harder than a held breeze
  PUSH_PAD: 26,          // px added to the ball's own radius when it pushes
  GAS_CHANCE: 0.5,       // per-cell chance a caught puff of smoke/gas/fire drifts this tick
  GAS_BUDGET: 40,        // cells checked per push, so a big ball stays cheap
  PUNCH_SPEED: 790,      // forward speed of a focused pressure blast
  RING_SPEED: 430,       // outward speed of an Orbit Punch wave
  RING_RANGE: 165,       // maximum wind-ring radius in pixels
};

class AirBending {
  constructor(scene) {
    this.scene = scene;
    this.element = 'Air';
    this.form = 'Bolt'; // 'Bolt' | 'Orbit' — set by game.js's bend-form wheel
    this.grabRadius = AIR_BEND.GRAB_RADIUS;
    this.held = [];    // wisps following the cursor: { x, y, vx, vy, life }
    this.free = [];    // released wisps, flying until they dissipate: { x, y, vx, vy, age }
    this.active = false;
    this.grabAcc = 0;
    this.grabOffsets = bendDiscOffsets(AIR_BEND.GRAB_RADIUS);
    this.gfx = scene.add.graphics().setDepth(8.5);
    this.jetDirections = new Map();
    this.nextJetId = 0;
    this.rings = [];
    this.surfaceDamage = bendSurfaceDamage(scene);
  }

  begin() {
    this.active = true;
    this.grabAcc = 0;
  }

  // Let go of everything held. Bolt's wisps keep their velocity, which is the
  // throw; Orbit's get an outward kick instead, so letting go of a ring reads
  // as releasing it rather than an arbitrary scatter.
  release() {
    if (!this.active && !this.held.length) return;
    this.active = false;
    const p = this.scene.player;
    const cx = p.x + p.w / 2, cy = p.y + p.h / 2;
    for (const d of this.held) {
      d.age = 0;
      if (this.form === 'Orbit') {
        const dx = d.x - cx, dy = d.y - cy;
        const dist = Math.max(1, Math.hypot(dx, dy));
        d.vx += (dx / dist) * ORBIT.RELEASE_KICK;
        d.vy += (dy / dist) * ORBIT.RELEASE_KICK;
      }
      this.free.push(d);
    }
    this.held.length = 0;
  }

  get holding() {
    return this.held.length;
  }

  punch() {
    if (!this.held.length) return false;
    const s = this.scene;
    const p = s.player;
    const cx = p.x + p.w / 2, cy = p.y + p.h / 2;
    const count = this.held.length;
    if (this.form === 'Orbit') {
      this.held.length = 0;
      this.rings.push({ x: cx, y: cy, radius: 24,
        strength: Math.min(440, 230 + count * 2) });
      this.gust(cx, cy, 30, 115);
      s.fx.shockwave(cx, cy, 'Air',
        { r0: 18, r1: AIR_BEND.RING_RANGE, life: 0.34, width: 4, rings: 2 });
      s.fx.burst(cx, cy, Math.min(36, 8 + count / 3), 'Air',
        { speed: 160, life: 0.4, size: 1.3 });
    } else {
      const aim = bendAim(s);
      const id = ++this.nextJetId;
      this.jetDirections.set(id, aim);
      for (const wisp of this.held) {
        wisp.vx = aim.x * AIR_BEND.PUNCH_SPEED;
        wisp.vy = aim.y * AIR_BEND.PUNCH_SPEED;
        wisp.age = 0;
        wisp.jetId = id;
        this.free.push(wisp);
      }
      this.held.length = 0;
      s.fx.streaks(cx, cy, Math.min(24, 7 + count / 5), 'Air',
        { speed: 270, angle: Math.atan2(aim.y, aim.x), spread: 0.55, life: 0.32 });
    }
    return true;
  }

  target() {
    return bendTarget(this.scene, AIR_BEND.REACH);
  }

  update(dt) {
    // Anything that takes the left button away from air bending lets the ball
    // go: dying, opening the spell wheel, switching to another mode or element.
    if (this.active && !bendSelected(this.scene, this.element)) this.release();

    if (this.active) this.grab(dt);
    if (this.held.length) {
      // Orbit's push is already free: groupPush hits everything near the held
      // cluster every frame regardless of where that cluster is, so pinning it
      // to a ring around the bender instead of the cursor is the only change
      // Orbit form needs here.
      if (this.form === 'Orbit') this.steerOrbit(dt); else this.steerHeld(dt);
      this.groupPush(this.held, AIR_BEND.HOLD_ACCEL * dt);
    }
    if (this.free.length) {
      this.updateFree(dt);
      const ordinary = [];
      const jets = new Map();
      for (const wisp of this.free) {
        if (!wisp.jetId) ordinary.push(wisp);
        else {
          if (!jets.has(wisp.jetId)) jets.set(wisp.jetId, []);
          jets.get(wisp.jetId).push(wisp);
        }
      }
      this.groupPush(ordinary, AIR_BEND.THROW_ACCEL * dt);
      for (const [id, wisps] of jets) {
        this.groupPush(wisps, AIR_BEND.THROW_ACCEL * dt * 1.7,
          this.jetDirections.get(id));
      }
      for (const id of this.jetDirections.keys()) {
        if (!jets.has(id)) this.jetDirections.delete(id);
      }
    }
    this.updateRings(dt);
  }

  updateRings(dt) {
    for (let i = this.rings.length - 1; i >= 0; i--) {
      const ring = this.rings[i];
      const steps = Math.max(1, Math.ceil(AIR_BEND.RING_SPEED * dt / 16));
      for (let step = 0; step < steps; step++) {
        ring.radius += AIR_BEND.RING_SPEED * dt / steps;
        this.gust(ring.x, ring.y, ring.radius,
          ring.strength * Math.min(1, AIR_BEND.RING_SPEED * dt / steps / 16),
          null, Math.max(0, ring.radius - 32));
      }
      if (ring.radius >= AIR_BEND.RING_RANGE) this.rings.splice(i, 1);
    }
  }

  // Draw new wisps out of the air near the cursor, nearest first, up to the
  // rate and the capacity. Nothing is taken from the world — there is no
  // "air" cell to remove.
  grab(dt) {
    if (this.held.length >= AIR_BEND.CAPACITY) { this.grabAcc = 0; return; }
    const s = this.scene;
    this.grabAcc += AIR_BEND.CONJURE_RATE * dt;
    let n = Math.floor(this.grabAcc);
    if (n <= 0) return;
    this.grabAcc -= n;

    const p = s.player;
    const pgx = (p.x + p.w / 2) / PIXEL, pgy = (p.y + p.h / 2) / PIXEL;
    const pointer = s.input.activePointer;
    const cgx = Math.floor(pointer.worldX / PIXEL), cgy = Math.floor(pointer.worldY / PIXEL);
    for (const [dx, dy] of this.grabOffsets) {
      if (n <= 0 || this.held.length >= AIR_BEND.CAPACITY) break;
      const x = cgx + dx, y = cgy + dy;
      if (x <= 0 || x >= COLS - 1 || y <= 0 || y >= ROWS - 1) continue;
      if (Math.hypot(x - pgx, y - pgy) > AIR_BEND.REACH) continue;
      this.held.push({
        x: x * PIXEL + PIXEL / 2, y: y * PIXEL + PIXEL / 2, vx: 0, vy: 0,
        life: AIR_BEND.HOLD_LIFE,
      });
      n--;
    }
    this.grabAcc = Math.min(this.grabAcc, 1);
  }

  // Each wisp chases its own place in the ball exactly as a held water drop
  // does, and burns down while it's held — a wisp whose life runs out just
  // dissipates on its own.
  steerHeld(dt) {
    const { x: cx, y: cy } = this.target();
    const spin = (this.scene.time.now / 1000) * AIR_BEND.SWIRL;
    const turn = Math.min(1, AIR_BEND.RESPONSE * dt);
    for (let i = this.held.length - 1; i >= 0; i--) {
      const d = this.held[i];
      d.life -= dt;
      if (d.life <= 0) { this.dissipate(d); this.held.splice(i, 1); continue; }
      const r = AIR_BEND.SPACING * PIXEL * Math.sqrt(i + 0.5);
      const a = i * BEND_GOLDEN + spin;
      const tx = cx + Math.cos(a) * r, ty = cy + Math.sin(a) * r;
      let wx = (tx - d.x) * AIR_BEND.FOLLOW, wy = (ty - d.y) * AIR_BEND.FOLLOW;
      const w = Math.hypot(wx, wy);
      if (w > AIR_BEND.MAX_SPEED) { wx *= AIR_BEND.MAX_SPEED / w; wy *= AIR_BEND.MAX_SPEED / w; }
      d.vx += (wx - d.vx) * turn;
      d.vy += (wy - d.vy) * turn;
      if (this.moveDrop(d, dt) === 'blocked') { d.vx *= 0.5; d.vy *= 0.5; }
    }
  }

  // Orbit form: instead of chasing the cursor, each wisp takes a fixed slot on
  // a ring around the bender that spins for as long as the button is held.
  // The push itself still comes from groupPush in update() — this only moves
  // where the wisps sit.
  steerOrbit(dt) {
    const p = this.scene.player;
    const cx = p.x + p.w / 2, cy = p.y + p.h / 2;
    this.spin = (this.spin || 0) + ORBIT.SPIN * dt;
    const n = this.held.length;
    const turn = Math.min(1, AIR_BEND.RESPONSE * dt);
    for (let i = n - 1; i >= 0; i--) {
      const d = this.held[i];
      d.life -= dt;
      if (d.life <= 0) { this.dissipate(d); this.held.splice(i, 1); continue; }
      const a = (i / n) * Math.PI * 2 + this.spin;
      const tx = cx + Math.cos(a) * ORBIT.RADIUS, ty = cy + Math.sin(a) * ORBIT.RADIUS;
      let wx = (tx - d.x) * AIR_BEND.FOLLOW, wy = (ty - d.y) * AIR_BEND.FOLLOW;
      const w = Math.hypot(wx, wy);
      if (w > AIR_BEND.MAX_SPEED) { wx *= AIR_BEND.MAX_SPEED / w; wy *= AIR_BEND.MAX_SPEED / w; }
      d.vx += (wx - d.vx) * turn;
      d.vy += (wy - d.vy) * turn;
      if (this.moveDrop(d, dt) === 'blocked') { d.vx *= 0.5; d.vy *= 0.5; }
    }
  }

  updateFree(dt) {
    for (let i = this.free.length - 1; i >= 0; i--) {
      const d = this.free[i];
      d.age += dt;
      d.vy -= AIR_BEND.LOFT * dt;
      d.vx *= 1 - Math.min(1, AIR_BEND.DRAG * dt);
      d.vy *= 1 - Math.min(1, AIR_BEND.DRAG * dt);
      const res = this.moveDrop(d, dt);
      if (res === 'blocked' || d.age > AIR_BEND.FREE_LIFE) {
        this.dissipate(d);
        this.free.splice(i, 1);
      }
    }
  }

  // Moves one wisp by its velocity in sub-steps of at most one cell, blocked
  // per axis. A wisp is never matter, so nothing it touches consumes it —
  // only a wall stops it. Returns 'ok' or 'blocked'.
  moveDrop(d, dt) {
    const dist = Math.max(Math.abs(d.vx), Math.abs(d.vy)) * dt;
    const steps = Math.max(1, Math.ceil(dist / PIXEL));
    const sx = (d.vx * dt) / steps, sy = (d.vy * dt) / steps;
    let blocked = false;
    for (let k = 0; k < steps; k++) {
      if (this.solidAt(d.x + sx, d.y)) this.erodeSurface(d, d.x + sx, d.y);
      if (this.solidAt(d.x + sx, d.y)) { d.vx *= -0.1; blocked = true; } else d.x += sx;
      if (this.solidAt(d.x, d.y + sy)) this.erodeSurface(d, d.x, d.y + sy);
      if (this.solidAt(d.x, d.y + sy)) { d.vy *= -0.1; blocked = true; } else d.y += sy;
      if (blocked) break;
    }
    return blocked ? 'blocked' : 'ok';
  }

  erodeSurface(wisp, x, y) {
    const speed = Math.hypot(wisp.vx, wisp.vy);
    if (speed < 65) return;
    if (this.surfaceDamage.cell(Math.floor(x / PIXEL), Math.floor(y / PIXEL),
      0.015 * (speed / 200) ** 2, 'Air')) {
      wisp.vx *= 0.6;
      wisp.vy *= 0.6;
    }
  }

  solidAt(px, py) {
    const gx = Math.floor(px / PIXEL), gy = Math.floor(py / PIXEL);
    if (gx <= 0 || gx >= COLS - 1 || gy <= 0 || gy >= ROWS - 1) return true;
    return IS_SOLID[this.scene.grid[this.scene.idx(gx, gy)]] === 1;
  }

  // A wisp is never matter, so there is nothing to place when it goes — just
  // a small puff where it was.
  dissipate(d) {
    if (Math.random() < 0.4) this.scene.fx.burst(d.x, d.y, 2, 'Air', { speed: 30, life: 0.3, size: 1 });
  }

  // Pushes everything near a whole cluster of wisps at once, from the
  // cluster's own centre and size, so the force doesn't stack once per wisp.
  groupPush(list, strength, direction = null) {
    if (!list.length) return;
    let sx = 0, sy = 0;
    for (const d of list) { sx += d.x; sy += d.y; }
    const cx = sx / list.length, cy = sy / list.length;
    const radiusPx = AIR_BEND.SPACING * PIXEL * Math.sqrt(list.length) + AIR_BEND.PUSH_PAD;
    this.gust(cx, cy, radiusPx, strength, direction);
  }

  // Pushes bodies and loose objects away from the gust, including the caster.
  gust(cx, cy, radiusPx, strength, direction = null, innerRadius = 0) {
    const s = this.scene;
    const falloff = (distance) => {
      if (distance >= radiusPx || distance < innerRadius) return 0;
      if (!innerRadius) return 1 - distance / radiusPx;
      const half = (radiusPx - innerRadius) / 2;
      return Math.max(0, 1 - Math.abs(distance - innerRadius - half) / half);
    };
    const push = (ox, oy, obj, mass = 1) => {
      const dx = ox - cx, dy = oy - cy;
      const d = Math.max(1, Math.hypot(dx, dy));
      const mag = strength * falloff(d) / Math.sqrt(Math.max(1, mass));
      if (!mag) return;
      if (!bendClearPath(s, cx, cy, ox, oy)) return;
      obj.vx += (direction ? direction.x : dx / d) * mag;
      obj.vy += (direction ? direction.y : dx === 0 && dy === 0 ? -1 : dy / d) * mag;
      return mag;
    };
    const bodyForce = (body) => {
      const nearX = Math.max(body.x, Math.min(cx, body.x + body.w));
      const nearY = Math.max(body.y, Math.min(cy, body.y + body.h));
      const distance = Math.hypot(nearX - cx, nearY - cy);
      const fall = falloff(distance);
      if (!fall) return null;
      const dx = body.x + body.w / 2 - cx;
      const dy = body.y + body.h / 2 - cy;
      const d = Math.hypot(dx, dy);
      const mag = strength * fall;
      return { ix: direction ? direction.x * mag : d > 0.01 ? dx / d * mag : 0,
        iy: direction ? direction.y * mag : d > 0.01 ? dy / d * mag : -mag };
    };
    for (const e of s.enemies.list) {
      if (e.dead) continue;
      const force = bodyForce(e);
      if (!force) continue;
      e.impulseX = (e.impulseX || 0) + force.ix;
      e.vy += force.iy;
    }
    if (!s.player.dead) {
      const force = bodyForce(s.player);
      if (force) s.receiveHit({ element: 'Air', amount: 0, bend: force });
    }
    for (const d of [...s.debris]) {
      const force = push(d.x, d.y, d);
      if (force) this.surfaceDamage.object(d, force * BEND_DAMAGE.AIR_POWER, 'Air');
    }
    for (const pr of s.projectiles) push(pr.x, pr.y, pr);
    const earth = s.benders?.Earth;
    if (earth) {
      if (earth.rock) push(earth.rock.x, earth.rock.y, earth.rock, earth.rock.cells.length);
      for (const rock of earth.thrown || []) push(rock.x, rock.y, rock, rock.cells.length);
      for (const piece of earth.loosePieces || []) push(piece.x, piece.y, piece);
    }
    for (const ball of s.benders?.Fire?.fireballs || []) {
      push(ball.x, ball.y, ball, Math.max(1, ball.mass * 0.1));
    }
    const now = s.time.now;
    if (!this.hitCooldowns) this.hitCooldowns = new Map();
    for (const target of bendContacts(s, [{ x: cx, y: cy }], radiusPx)) {
      const force = bodyForce(target.body);
      if (!target.id || !force || !bendHitReady(this.hitCooldowns, target.id, now, 80)) continue;
      s.reportHit(target.id, 'Air', 0, null, force);
    }
    this.blowGas(cx, cy, radiusPx, direction, strength, innerRadius);
  }

  // Wind moves smoke, gas, and flames while lightly wearing exposed surfaces.
  // The candidate budget keeps broad gusts from damaging an unbounded area.
  blowGas(cx, cy, radiusPx, direction = null, strength = 0, innerRadius = 0) {
    const s = this.scene;
    const gx0 = Math.max(1, Math.floor((cx - radiusPx) / PIXEL));
    const gx1 = Math.min(COLS - 2, Math.floor((cx + radiusPx) / PIXEL));
    const gy0 = Math.max(1, Math.floor((cy - radiusPx) / PIXEL));
    const gy1 = Math.min(ROWS - 2, Math.floor((cy + radiusPx) / PIXEL));
    let budget = AIR_BEND.GAS_BUDGET;
    for (let y = gy0; y <= gy1 && budget > 0; y++) {
      for (let x = gx0; x <= gx1 && budget > 0; x++) {
        const id = s.idx(x, y);
        const m = s.grid[id];
        const surface = IS_SOLID[m] && Number.isFinite(PixelWorld.IMPACT_RESISTANCE[m]);
        if (m !== SMOKE && m !== GAS && m !== FIRE && !surface) continue;
        const wx = x * PIXEL + PIXEL / 2, wy = y * PIXEL + PIXEL / 2;
        const dx = wx - cx, dy = wy - cy;
        const d = Math.hypot(dx, dy);
        if (d >= radiusPx || d < innerRadius) continue;
        if (surface) {
          if (!strength || !bendExposedCell(s, x, y) || !bendClearPath(s, cx, cy, wx, wy)) continue;
          budget--;
          this.surfaceDamage.cell(x, y, strength * BEND_DAMAGE.AIR_POWER * (1 - d / radiusPx), 'Air');
          continue;
        }
        budget--;
        if (Math.random() > AIR_BEND.GAS_CHANCE) continue;
        const ux = direction ? direction.x : d > 0.01 ? dx / d : 0;
        const uy = direction ? direction.y : d > 0.01 ? dy / d : -1;
        const nx = x + Math.round(ux), ny = y + Math.round(uy);
        if (nx === x && ny === y) continue;
        if (nx <= 0 || nx >= COLS - 1 || ny <= 0 || ny >= ROWS - 1) continue;
        const nid = s.idx(nx, ny);
        if (s.grid[nid] !== EMPTY) continue;
        const life = s.life[id];
        s.setCell(nid, m, life);
        s.setCell(id, EMPTY);
      }
    }
  }

  draw() {
    const g = this.gfx;
    g.clear();
    if (!this.held.length && !this.free.length) return;
    const pal = FX_PALETTE.Air;
    // A faint halo around the held ball, so a swirl of wisps reads as one
    // held mass rather than a scatter of loose motes.
    if (this.held.length > 4) {
      let sx = 0, sy = 0;
      for (const d of this.held) { sx += d.x; sy += d.y; }
      const r = AIR_BEND.SPACING * PIXEL * Math.sqrt(this.held.length) + 6;
      g.fillStyle(pal.glow, 0.12);
      g.fillCircle(sx / this.held.length, sy / this.held.length, r);
    }
    for (const list of [this.held, this.free]) {
      for (const d of list) {
        const speed = Math.abs(d.vx) + Math.abs(d.vy);
        g.fillStyle(speed > 320 ? pal.core : pal.glow, speed > 320 ? 1 : 0.85);
        // A hair larger than a cell, so wisps at fractional positions do not
        // leave seams between them.
        g.fillRect(d.x - PIXEL / 2 - 0.5, d.y - PIXEL / 2 - 0.5, PIXEL + 1, PIXEL + 1);
      }
    }
  }
}
