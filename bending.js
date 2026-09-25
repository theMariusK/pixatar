// Bending: hold the left mouse button over water or earth and it comes with you.
//
// B cycles the left mouse button through dig -> bend water -> bend earth -> bend
// fire -> bend air -> dig. Water is below; earth (EarthBending) follows the same
// principle but fuses what it lifts into one solid rock; fire (FireBending) is
// conjured rather than lifted, since there is no fire lying around to take; air
// (AirBending, last) holds and throws a swirling ball of wisps the same way, but
// the wisps are pure force rather than matter — they push what they pass instead
// of landing as a cell.
//
// Every element also has a Form (game.js, Q while bending opens the picker):
// Bolt is everything described above; Orbit pins the same held matter to the
// bender instead of the cursor and spins it in place for as long as the button
// stays down, striking anything it swings past. See the "forms" section below.
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

// True while this element's bending owns the left mouse button.
function bendSelected(scene, element) {
  return scene.leftClickMode === 'bend' && scene.bendElement === element
    && !scene.player.dead && !scene.wheelOpen;
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
// throwing one mass in one direction. Modifiers aren't wired up yet; Form is
// the first slice of giving bending the same wheel-driven depth spells have
// (see game.js, openBendWheel).
const ORBIT = {
  RADIUS: 34,          // px the ring sits at around the bender
  SPIN: 3.2,           // rad/s
  RELEASE_KICK: 160,   // px/s outward speed given to each piece when the ring is let go
  HIT_RADIUS: 10,      // px around an orbiting piece that can strike a body
  HIT_COOLDOWN: 0.35,  // s before the same piece can strike again
};

// Shoves anything caught within ORBIT.HIT_RADIUS of (x, y) — the ring's own
// strike. Modest and knockback-only by design, not a new damage system.
// Returns whether it hit anything, so callers can throttle per piece.
function orbitStrike(scene, x, y, strength) {
  const hits = scene.bodiesInRadius(x, y, ORBIT.HIT_RADIUS);
  let hit = false;
  for (const t of hits) {
    if (!t.self) hit = true;
  }
  if (hit) scene.knockback(x, y, ORBIT.HIT_RADIUS * 2.4, strength);
  return hit;
}

// Test the visible bent matter against body rectangles, rather than body centres.
// A single body appears once even when a whole blob of particles overlaps it.
function bendContacts(scene, points, pad = PIXEL) {
  if (!points.length) return [];
  const targets = [];
  if (!scene.player.dead) targets.push({ self: true, body: scene.player });
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
  }

  touchBodies() {
    const s = this.scene;
    const now = s.time.now;
    for (const target of bendContacts(s, [...this.held, ...this.free])) {
      const key = target.self ? 'self' : target.id || target.enemy;
      if (!bendHitReady(this.hitCooldowns, key, now, 170)) continue;
      if (target.self) s.receiveHit({ element: 'Water', amount: 0, bend: { wetMs: 450 } });
      else if (target.enemy) target.enemy.wetUntil = now + 450;
      else s.reportHit(target.id, 'Water', 0, null, { wetMs: 450 });
      s.fx.burst(target.body.x + target.body.w / 2, target.body.y + target.body.h / 2,
        3, 'Water', { speed: 35, life: 0.25, size: 1 });
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
      if (this.solidAt(d.x + sx, d.y)) { d.vx *= -0.15; blocked = true; } else d.x += sx;
      if (this.solidAt(d.x, d.y + sy)) { d.vy *= -0.15; blocked = true; } else d.y += sy;
      const gx = Math.floor(d.x / PIXEL), gy = Math.floor(d.y / PIXEL);
      const id = s.idx(gx, gy);
      const m = s.grid[id];
      if (m === FIRE) { s.setCell(id, SMOKE, SMOKE_LIFE); return 'consumed'; }
      if (m === LAVA) { s.setCell(id, STONE); return 'consumed'; }
      if (blocked) break;
    }
    return blocked ? 'blocked' : 'ok';
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
      const key = target.self ? 'self' : target.id || target.enemy;
      if (!bendHitReady(this.hitCooldowns, key, now, 400)) continue;
      const cx = target.body.x + target.body.w / 2;
      const cy = target.body.y + target.body.h / 2;
      const ix = Math.max(-240, Math.min(240, rock.vx * 0.65));
      const iy = Math.max(-260, Math.min(120, rock.vy * 0.4 - 90));
      if (target.self) {
        s.receiveHit({ element: 'Earth', amount: damage, bend: { ix, iy } });
      } else if (target.enemy) {
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
    if (speed < 85) return;
    const s = this.scene;
    const M = PixelWorld.MAT;
    for (let i = s.debris.length - 1; i >= 0; i--) {
      const d = s.debris[i];
      if (!points.some((p) => Math.hypot(p.x - d.x, p.y - d.y) < PIXEL * 2.5)) continue;
      if (!bendHitReady(this.hitCooldowns, d, s.time.now, 180)) continue;
      if (d.mat === M.GLASS || d.mat === M.LEAVES || d.mat === M.SNOW
        || (rock.cells.length >= 6 && (d.mat === M.WOOD || d.mat === M.TIMBER))) {
        s.debris.splice(i, 1);
        s.fx.shards(d.x, d.y, 4, 'Earth');
      } else {
        d.vx += rock.vx * 0.5;
        d.vy += rock.vy * 0.5 - 40;
      }
    }
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
    const impactSpeed = Math.hypot(rock.vx, rock.vy);
    this.moveRock(rock, dt, 'held');
    this.strikeBodies(rock, impactSpeed);
  }

  // Orbit form: the rock never chases the cursor at all. It pins to the
  // bender and its cells rotate in place around that centre — a spinning
  // clump rather than a followed boulder — striking anything it swings past.
  // (Cells clipping slightly into terrain while spinning is an accepted
  // cosmetic quirk here, the same tolerance a held Bolt rock already has.)
  steerOrbitRock(dt) {
    const rock = this.rock;
    const p = this.scene.player;
    rock.x = p.x + p.w / 2;
    rock.y = p.y + p.h / 2;
    rock.vx = 0;
    rock.vy = 0;
    const dtheta = ORBIT.SPIN * dt;
    const cos = Math.cos(dtheta), sin = Math.sin(dtheta);
    for (const c of rock.cells) {
      const nx = c.ox * cos - c.oy * sin;
      const ny = c.ox * sin + c.oy * cos;
      c.ox = nx; c.oy = ny;
      c.hitCd = (c.hitCd || 0) - dt;
      if (c.hitCd <= 0) {
        const px = rock.x + c.ox * PIXEL, py = rock.y + c.oy * PIXEL;
        if (orbitStrike(this.scene, px, py, 220)) c.hitCd = ORBIT.HIT_COOLDOWN;
      }
    }
    this.strikeBodies(rock);
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
      const impactSpeed = Math.hypot(rock.vx, rock.vy);
      const hit = this.moveRock(rock, dt, 'thrown');
      this.strikeBodies(rock, impactSpeed);
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
      if (hit.down) break;
    }
    return hit;
  }

  // Two rules, because a held rock and a thrown one have different problems.
  //
  //  held:   it may scrape but not bury itself. A move is refused only if it would
  //          leave more of the rock inside terrain than before AND more than 15% of
  //          it. That lets it rise out of the hole it is the exact shape of (the rim
  //          catches a cell or two) while a wall still stops it.
  //  thrown: any cell newly entering terrain stops it on that axis. Cells already
  //          inside something (it was let go scraping a wall) are ignored, so a rock
  //          released against a cliff still falls instead of sticking to it.
  rockCollides(rock, dx, dy, mode) {
    if (mode === 'held') {
      let before = 0, after = 0;
      for (const c of rock.cells) {
        const px = rock.x + c.ox * PIXEL, py = rock.y + c.oy * PIXEL;
        if (this.solidAt(px, py)) before++;
        if (this.solidAt(px + dx, py + dy)) {
          const gx = Math.floor((px + dx) / PIXEL), gy = Math.floor((py + dy) / PIXEL);
          if (!this.breakLightCell(gx, gy, rock)) after++;
        }
      }
      return after > before && after > Math.max(1, rock.cells.length * 0.15);
    }
    for (const c of rock.cells) {
      const px = rock.x + c.ox * PIXEL, py = rock.y + c.oy * PIXEL;
      if (this.solidAt(px + dx, py + dy) && !this.solidAt(px, py)) {
        const gx = Math.floor((px + dx) / PIXEL), gy = Math.floor((py + dy) / PIXEL);
        if (this.breakLightCell(gx, gy, rock)) continue;
        return true;
      }
    }
    return false;
  }

  breakLightCell(gx, gy, rock) {
    if (gx <= 0 || gx >= COLS - 1 || gy <= 0 || gy >= ROWS - 1) return false;
    const s = this.scene;
    const M = PixelWorld.MAT;
    const id = s.idx(gx, gy);
    const m = s.grid[id];
    const speed = Math.hypot(rock.vx, rock.vy);
    const fragile = m === M.GLASS || m === M.LEAVES || m === M.SNOW;
    const timber = m === M.WOOD || m === M.TIMBER;
    if (!((fragile && speed > 85) || (timber && speed > 180 && rock.cells.length >= 6))) return false;
    s.setCell(id, EMPTY);
    if (Math.random() < 0.18) s.fx.shards(gx * PIXEL, gy * PIXEL, 2, 'Earth');
    return true;
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
      const steps = Math.max(1, Math.ceil((Math.abs(pc.vy) * dt) / PIXEL));
      let landed = false;
      for (let k = 0; k < steps && !landed; k++) {
        const ny = pc.y + (pc.vy * dt) / steps;
        if (this.solidAt(pc.x, ny)) landed = true; else pc.y = ny;
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
// Holding the button kindles embers out of thin air at the cursor. They swirl
// into a blob the same way held water does, but a kindled ember is burning on
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
  GRAB_RADIUS: 6,        // cells around the cursor new embers are kindled in
  CONJURE_RATE: 90,      // embers created per second while the button is held
  CAPACITY: 120,         // embers held at once — less than water or earth, since
                          // this mass is free and needs some cap of its own
  REACH: 95,             // cells from the bender embers may be kindled or held at
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
};

class FireBending {
  constructor(scene) {
    this.scene = scene;
    this.element = 'Fire';
    this.form = 'Bolt'; // 'Bolt' | 'Orbit' — set by game.js's bend-form wheel
    this.grabRadius = FIRE_BEND.GRAB_RADIUS;
    this.held = [];    // embers following the cursor: { x, y, vx, vy, life }
    this.free = [];    // released embers, flying until they land or burn out: { x, y, vx, vy, age }
    this.active = false;
    this.grabAcc = 0;
    this.grabOffsets = bendDiscOffsets(FIRE_BEND.GRAB_RADIUS);
    this.settleOffsets = bendDiscOffsets(FIRE_BEND.SETTLE_RADIUS);
    this.gfx = scene.add.graphics().setDepth(8.5);
    this.hitCooldowns = new Map();
    this.casterFxAcc = 0;
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
    this.touchBodies();
    this.touchObjects();
  }

  touchBodies() {
    const s = this.scene;
    const now = s.time.now;
    for (const target of bendContacts(s, [...this.held, ...this.free])) {
      const key = target.self ? 'self' : target.id || target.enemy;
      if (!bendHitReady(this.hitCooldowns, key, now, 230)) continue;
      if (target.self) {
        s.receiveHit({ element: 'Fire', amount: 3, bend: { burnMs: 1200 } });
      } else if (target.enemy) {
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
    for (let i = s.debris.length - 1; i >= 0; i--) {
      const obj = s.debris[i];
      if (!PixelWorld.FLAMMABILITY[obj.mat]) continue;
      let ember = null;
      let list = null;
      for (const particles of [this.held, this.free]) {
        const found = particles.findIndex((d) => Math.hypot(d.x - obj.x, d.y - obj.y) < PIXEL * 2);
        if (found >= 0) { ember = found; list = particles; break; }
      }
      if (!list) continue;
      list.splice(ember, 1);
      s.debris.splice(i, 1);
      const gx = Math.floor(obj.x / PIXEL), gy = Math.floor(obj.y / PIXEL);
      if (gx > 0 && gx < COLS - 1 && gy > 0 && gy < ROWS - 1) {
        const id = s.idx(gx, gy);
        if (s.grid[id] === EMPTY) s.setCell(id, FIRE, Math.min(255, PixelWorld.BURN_LIFE[obj.mat]));
      }
      s.fx.burst(obj.x, obj.y, 6, 'Fire', { speed: 60, life: 0.4, rise: 40 });
    }
  }

  // Kindle new embers near the cursor, nearest first, up to the rate and the
  // capacity. Nothing is removed from the world — this is the one bend that
  // creates instead of drawing on what's already there.
  grab(dt) {
    if (this.held.length >= FIRE_BEND.CAPACITY) { this.grabAcc = 0; return; }
    const s = this.scene;
    this.grabAcc += FIRE_BEND.CONJURE_RATE * dt;
    let n = Math.floor(this.grabAcc);
    if (n <= 0) return;
    this.grabAcc -= n;

    const p = s.player;
    const pgx = (p.x + p.w / 2) / PIXEL, pgy = (p.y + p.h / 2) / PIXEL;
    const pointer = s.input.activePointer;
    const cgx = Math.floor(pointer.worldX / PIXEL), cgy = Math.floor(pointer.worldY / PIXEL);
    for (const [dx, dy] of this.grabOffsets) {
      if (n <= 0 || this.held.length >= FIRE_BEND.CAPACITY) break;
      const x = cgx + dx, y = cgy + dy;
      if (x <= 0 || x >= COLS - 1 || y <= 0 || y >= ROWS - 1) continue;
      if (Math.hypot(x - pgx, y - pgy) > FIRE_BEND.REACH) continue;
      this.held.push({
        x: x * PIXEL + PIXEL / 2, y: y * PIXEL + PIXEL / 2, vx: 0, vy: 0,
        life: FIRE_BEND.HOLD_LIFE,
      });
      n--;
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
  // axis like a water drop. An ember that touches water is snuffed, and one that
  // touches — or bumps into — anything flammable sets it alight and is spent
  // doing it. Returns 'ok', 'blocked' or 'consumed'.
  moveDrop(d, dt) {
    const s = this.scene;
    const dist = Math.max(Math.abs(d.vx), Math.abs(d.vy)) * dt;
    const steps = Math.max(1, Math.ceil(dist / PIXEL));
    const sx = (d.vx * dt) / steps, sy = (d.vy * dt) / steps;
    let blocked = false;
    for (let k = 0; k < steps; k++) {
      if (this.solidAt(d.x + sx, d.y)) {
        if (this.igniteCell(Math.floor((d.x + sx) / PIXEL), Math.floor(d.y / PIXEL))) return 'consumed';
        blocked = true;
      } else d.x += sx;
      if (this.solidAt(d.x, d.y + sy)) {
        if (this.igniteCell(Math.floor(d.x / PIXEL), Math.floor((d.y + sy) / PIXEL))) return 'consumed';
        blocked = true;
      } else d.y += sy;
      const gx = Math.floor(d.x / PIXEL), gy = Math.floor(d.y / PIXEL);
      const id = s.idx(gx, gy);
      if (s.grid[id] === WATER) return 'consumed';
      if (this.igniteCell(gx, gy)) return 'consumed';
      if (blocked) break;
    }
    return blocked ? 'blocked' : 'ok';
  }

  // Direct contact always lights fuel — no roll, unlike the slower chance fire
  // has to catch a neighbour it's spreading to on its own (world.js, ignite).
  // Grass burns down to dirt with a flame standing over it, the same as ambient
  // fire; anything else flammable simply becomes fire.
  igniteCell(gx, gy) {
    if (gx <= 0 || gx >= COLS - 1 || gy <= 0 || gy >= ROWS - 1) return false;
    const s = this.scene;
    const M = PixelWorld.MAT;
    const id = s.idx(gx, gy);
    const m = s.grid[id];
    if (m === M.GRASS) {
      s.setCell(id, M.DIRT, 1);
      const up = id - COLS;
      if (up >= 0 && s.grid[up] === M.EMPTY) s.setCell(up, M.FIRE, PixelWorld.FIRE_LIFE);
      return true;
    }
    if (PixelWorld.FLAMMABILITY[m] > 0) {
      s.setCell(id, M.FIRE, Math.min(255, PixelWorld.BURN_LIFE[m]));
      return true;
    }
    return false;
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
    if (!this.held.length && !this.free.length) return;
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
    if (this.free.length) { this.updateFree(dt); this.groupPush(this.free, AIR_BEND.THROW_ACCEL * dt); }
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
      if (this.solidAt(d.x + sx, d.y)) { d.vx *= -0.1; blocked = true; } else d.x += sx;
      if (this.solidAt(d.x, d.y + sy)) { d.vy *= -0.1; blocked = true; } else d.y += sy;
      if (blocked) break;
    }
    return blocked ? 'blocked' : 'ok';
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
  groupPush(list, strength) {
    if (!list.length) return;
    let sx = 0, sy = 0;
    for (const d of list) { sx += d.x; sy += d.y; }
    const cx = sx / list.length, cy = sy / list.length;
    const radiusPx = AIR_BEND.SPACING * PIXEL * Math.sqrt(list.length) + AIR_BEND.PUSH_PAD;
    this.gust(cx, cy, radiusPx, strength);
  }

  // Pushes bodies and loose objects away from the gust, including the caster.
  gust(cx, cy, radiusPx, strength) {
    const s = this.scene;
    const push = (ox, oy, obj) => {
      const dx = ox - cx, dy = oy - cy;
      const d = Math.max(1, Math.hypot(dx, dy));
      if (d >= radiusPx) return;
      const mag = strength * (1 - d / radiusPx);
      obj.vx += (dx / d) * mag;
      obj.vy += (dx === 0 && dy === 0 ? -1 : dy / d) * mag;
    };
    const bodyForce = (body) => {
      const nearX = Math.max(body.x, Math.min(cx, body.x + body.w));
      const nearY = Math.max(body.y, Math.min(cy, body.y + body.h));
      const distance = Math.hypot(nearX - cx, nearY - cy);
      if (distance >= radiusPx) return null;
      const dx = body.x + body.w / 2 - cx;
      const dy = body.y + body.h / 2 - cy;
      const d = Math.hypot(dx, dy);
      const mag = strength * (1 - distance / radiusPx);
      return { ix: d > 0.01 ? dx / d * mag : 0, iy: d > 0.01 ? dy / d * mag : -mag };
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
    for (const d of s.debris) push(d.x, d.y, d);
    for (const pr of s.projectiles) push(pr.x, pr.y, pr);
    const now = s.time.now;
    if (!this.hitCooldowns) this.hitCooldowns = new Map();
    for (const target of bendContacts(s, [{ x: cx, y: cy }], radiusPx)) {
      const force = bodyForce(target.body);
      if (!target.id || !force || !bendHitReady(this.hitCooldowns, target.id, now, 80)) continue;
      s.reportHit(target.id, 'Air', 0, null, force);
    }
    this.blowGas(cx, cy, radiusPx);
  }

  // The one way a gust touches the grid: any smoke, gas or fire cell in range
  // may drift one cell further from (cx, cy), same idea as everything else the
  // gust pushes. Bounded per call so a wide gust can't become an unbounded
  // scan every frame.
  blowGas(cx, cy, radiusPx) {
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
        if (m !== SMOKE && m !== GAS && m !== FIRE) continue;
        const wx = x * PIXEL + PIXEL / 2, wy = y * PIXEL + PIXEL / 2;
        const dx = wx - cx, dy = wy - cy;
        const d = Math.hypot(dx, dy);
        if (d >= radiusPx) continue;
        budget--;
        if (Math.random() > AIR_BEND.GAS_CHANCE) continue;
        const ux = d > 0.01 ? dx / d : 0, uy = d > 0.01 ? dy / d : -1;
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
