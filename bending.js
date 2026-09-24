// Bending: hold the left mouse button over water or earth and it comes with you.
//
// B cycles the left mouse button through dig -> bend water -> bend earth -> dig. Water
// is below; earth (EarthBending) follows the same principle but fuses what it lifts
// into one solid rock.
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

class WaterBending {
  constructor(scene) {
    this.scene = scene;
    this.element = 'Water';
    this.grabRadius = BEND.GRAB_RADIUS;
    this.held = [];    // drops following the cursor: { x, y, vx, vy }
    this.free = [];    // released drops, falling until they land: { x, y, vx, vy, age }
    this.active = false;
    this.grabAcc = 0;
    this.grabOffsets = bendDiscOffsets(BEND.GRAB_RADIUS);
    this.settleOffsets = bendDiscOffsets(BEND.SETTLE_RADIUS);
    this.gfx = scene.add.graphics().setDepth(8.5);
  }

  begin() {
    this.active = true;
    this.grabAcc = 0;
  }

  // Let go of everything held. Drops keep their velocity, which is the throw.
  release() {
    if (!this.active && !this.held.length) return;
    this.active = false;
    for (const d of this.held) {
      d.age = 0;
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
    if (this.held.length) this.steerHeld(dt);
    if (this.free.length) this.updateFree(dt);
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

  release() {
    if (!this.active && !this.rock) return;
    this.active = false;
    if (this.rock && this.rock.cells.length) {
      this.rock.age = 0;
      this.thrown.push(this.rock);
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
      this.steerRock(dt);
    }
    if (this.thrown.length) this.updateThrown(dt);
    if (this.loosePieces.length) this.updateLoose(dt);
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
        if (this.solidAt(px + dx, py + dy)) after++;
      }
      return after > before && after > Math.max(1, rock.cells.length * 0.15);
    }
    for (const c of rock.cells) {
      const px = rock.x + c.ox * PIXEL, py = rock.y + c.oy * PIXEL;
      if (this.solidAt(px + dx, py + dy) && !this.solidAt(px, py)) return true;
    }
    return false;
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
