// Shared world model for the falling-sand demo: material definitions, the
// cellular simulation, and procedural world generation.
//
// Loaded as a plain <script> in the browser (exposes `PixelWorld`) and via
// require() on the multiplayer server, so both sides run identical rules and every
// room on the server generates the same kind of world a solo game does.
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.PixelWorld = api;
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  const COLS = 560;
  const ROWS = 320;
  const SIZE = COLS * ROWS;

  // ---------- materials ----------

  // Ids 0-11 are the originals and must not move: they travel over the network and
  // spells.js refers to them. New materials are appended after them.
  const MAT = {
    EMPTY: 0, SAND: 1, WATER: 2, STONE: 3, WOOD: 4, FIRE: 5, SMOKE: 6, BEDROCK: 7,
    LAVA: 8, ACID: 9, GAS: 10, ICE: 11,
    DIRT: 12, GRASS: 13, LEAVES: 14, BRICK: 15, GLASS: 16, COAL: 17, GOLD: 18,
    SNOW: 19, PACKED_ICE: 20, OIL: 21, SANDSTONE: 22, TIMBER: 23,
  };
  const {
    EMPTY, SAND, WATER, STONE, WOOD, FIRE, SMOKE, BEDROCK, LAVA, ACID, GAS, ICE,
    DIRT, GRASS, LEAVES, BRICK, GLASS, COAL, GOLD, SNOW, PACKED_ICE, OIL, SANDSTONE, TIMBER,
  } = MAT;
  const MAT_COUNT = 24;

  const FIRE_LIFE = 45;
  const SMOKE_LIFE = 70;
  // Spell ice is solid and standable but temporary — it thaws back into the water it
  // came from. (setCell caps life at 255, so in practice this is 255 ticks.)
  const ICE_LIFE = 340;

  // Fire, smoke and spell ice use a cell's `life` byte as a countdown. Every other
  // material uses it as a palette variant, so generated structures keep their
  // patterns (planks, brick courses, roof tiles) even when the cells fall or move.
  const V = {
    WOOD_BARK: 0, WOOD_PLANK: 1, WOOD_SEAM: 2, WOOD_DARK: 3,
    LEAF_OAK: 0, LEAF_PINE: 3, LEAF_CACTUS: 5, LEAF_AUTUMN: 6, LEAF_PALM: 8,
    DOOR: 4, DOOR_FRAME: 5,
    BRICK_RED: 0, BRICK_MORTAR: 1, BRICK_RED_DARK: 2, BRICK_STONE: 3, BRICK_STONE_DARK: 4,
    BRICK_ROOF: 5, BRICK_ROOF_DARK: 6, BRICK_MORTAR_DARK: 7,
  };

  // kind: how a cell moves. 'static' solids only move when nothing holds them
  // up (see checkStructuralSupport); 'timed' solids (spell ice) never fall and
  // expire on their own. flammable: chance per tick that a burning neighbour
  // ignites it. acid: chance per tick that touching acid dissolves it.
  // passable: solid to the simulation and to projectiles, but bodies walk through
  // it — trees and foliage, which would otherwise wall off every forest.
  const DEFS = [];
  function def(m, name, props) {
    DEFS[m] = Object.assign({
      name, kind: 'static', solid: true, passable: false, flammable: 0, burnLife: FIRE_LIFE, acid: 0, palette: [[255, 0, 255]],
    }, props);
  }
  def(EMPTY, 'Empty', { kind: 'empty', solid: false, palette: [[16, 16, 24]] });
  def(SAND, 'Sand', { kind: 'powder', acid: 0.05, palette: [[214, 190, 130], [204, 179, 119], [223, 200, 141]] });
  def(WATER, 'Water', { kind: 'liquid', solid: false, palette: [[58, 118, 209]] });
  def(STONE, 'Stone', { palette: [[118, 118, 128], [105, 105, 115], [90, 90, 100], [132, 126, 120]] });
  def(WOOD, 'Wood', { flammable: 0.045, acid: 0.05, palette: [[117, 79, 49], [152, 108, 66], [112, 76, 46], [90, 60, 38]] });
  def(FIRE, 'Fire', { kind: 'fire', solid: false, palette: [[255, 160, 20]] });
  def(SMOKE, 'Smoke', { kind: 'gas', solid: false, palette: [[95, 95, 100]] });
  def(BEDROCK, 'Bedrock', { kind: 'bedrock', palette: [[55, 55, 62], [47, 47, 54]] });
  def(LAVA, 'Lava', { kind: 'liquid', solid: false, palette: [[255, 100, 20]] });
  def(ACID, 'Acid', { kind: 'liquid', solid: false, palette: [[150, 220, 60]] });
  def(GAS, 'Gas', { kind: 'gas', solid: false, flammable: 0.5, burnLife: FIRE_LIFE * 1.4, palette: [[180, 150, 210]] });
  def(ICE, 'Ice', { kind: 'timed', palette: [[150, 214, 240]] });
  def(DIRT, 'Dirt', { acid: 0.05, palette: [[112, 78, 52], [100, 68, 45], [124, 88, 59]] });
  def(GRASS, 'Grass', { flammable: 0.06, acid: 0.05, palette: [[76, 150, 60], [64, 134, 50], [92, 166, 70]] });
  def(LEAVES, 'Leaves', {
    passable: true, flammable: 0.18, burnLife: FIRE_LIFE * 0.7, acid: 0.08,
    palette: [
      [58, 128, 48], [46, 110, 40], [72, 146, 58], // oak
      [34, 84, 52], [27, 70, 44], // pine
      [82, 142, 70], // cactus
      [196, 120, 42], [168, 82, 38], // autumn
      [96, 156, 62], // palm
    ],
  });
  def(BRICK, 'Brick', {
    acid: 0.004,
    palette: [
      [150, 72, 56], [124, 114, 104], [132, 62, 48], [116, 116, 122], [100, 100, 108],
      [132, 50, 42], [108, 40, 35], [74, 72, 74],
    ],
  });
  def(GLASS, 'Glass', { palette: [[168, 208, 228], [214, 236, 246]] });
  def(COAL, 'Coal', { flammable: 0.012, burnLife: 230, acid: 0.02, palette: [[36, 34, 38], [52, 50, 54]] });
  def(GOLD, 'Gold', { palette: [[226, 184, 58], [246, 210, 88], [198, 156, 40]] });
  def(SNOW, 'Snow', { kind: 'powder', acid: 0.08, palette: [[236, 240, 248], [222, 229, 241], [248, 250, 255]] });
  // Lake ice: unlike spell ice it never thaws on its own, only when heated.
  def(PACKED_ICE, 'Packed ice', { acid: 0.03, palette: [[168, 212, 238], [150, 198, 230], [196, 230, 248]] });
  def(OIL, 'Oil', { kind: 'liquid', solid: false, flammable: 0.3, burnLife: FIRE_LIFE * 2, palette: [[54, 42, 32], [64, 52, 40]] });
  def(SANDSTONE, 'Sandstone', { acid: 0.02, palette: [[196, 160, 104], [170, 136, 86], [208, 174, 118], [158, 124, 78]] });
  // Timber: tree trunks, branches and doors. Burns and bears load like wood, but
  // bodies pass through it — so forests aren't walls, and a door holds up the wall
  // above it while still letting you walk in.
  def(TIMBER, 'Timber', {
    passable: true, flammable: 0.045, acid: 0.05,
    palette: [[117, 79, 49], [138, 96, 58], [104, 70, 43], [90, 60, 38], [128, 86, 50], [96, 62, 36]],
  });

  const IS_SOLID = new Uint8Array(MAT_COUNT); // blocks projectiles/powders and holds structures up
  const BLOCKS_BODY = new Uint8Array(MAT_COUNT); // what players and enemies collide with
  const IS_RIGID = new Uint8Array(MAT_COUNT); // static solids that fall when unsupported and fly as debris
  const IS_OPEN = new Uint8Array(MAT_COUNT); // what a falling rigid cell or a debris chunk passes through
  const IS_LIQUID = new Uint8Array(MAT_COUNT);
  const FLAMMABILITY = new Float32Array(MAT_COUNT);
  const BURN_LIFE = new Uint8Array(MAT_COUNT);
  const ACID_RATE = new Float32Array(MAT_COUNT);
  const PALETTE = [];
  const NAMES = [];
  for (let m = 0; m < MAT_COUNT; m++) {
    const d = DEFS[m];
    IS_SOLID[m] = d.solid ? 1 : 0;
    BLOCKS_BODY[m] = d.solid && !d.passable ? 1 : 0;
    IS_RIGID[m] = d.kind === 'static' ? 1 : 0;
    IS_OPEN[m] = d.kind === 'empty' || d.kind === 'liquid' || d.kind === 'gas' || d.kind === 'fire' ? 1 : 0;
    IS_LIQUID[m] = d.kind === 'liquid' ? 1 : 0;
    FLAMMABILITY[m] = d.flammable;
    BURN_LIFE[m] = Math.min(255, d.burnLife);
    ACID_RATE[m] = d.acid;
    PALETTE[m] = d.palette;
    NAMES[m] = d.name;
  }

  const moveTable = (...mats) => {
    const t = new Uint8Array(MAT_COUNT);
    for (const m of mats) t[m] = 1;
    return t;
  };
  const INTO_EMPTY = moveTable(EMPTY);
  const SAND_INTO = moveTable(EMPTY, WATER, OIL);
  const WATER_DOWN = moveTable(EMPTY, OIL); // water sinks below oil

  const NEIGHBORS4 = [[1, 0], [-1, 0], [0, 1], [0, -1]];
  const NEIGHBORS8 = [[1, 0], [-1, 0], [0, 1], [0, -1], [1, 1], [-1, -1], [1, -1], [-1, 1]];

  // Background layer: purely visual, shown wherever a cell is EMPTY.
  const BG = { SKY: 0, DIRT: 1, CAVE: 2, WOOD: 3, BRICK: 4, SANDSTONE: 5, WINDOW: 6, BEAM: 7, ROOF: 8 };

  // ---------- simulation ----------

  class World {
    constructor(opts = {}) {
      this.grid = new Uint8Array(SIZE);
      this.life = new Uint8Array(SIZE);
      this.falling = new Uint8Array(SIZE);
      // Distance traveled since an unsupported rigid cell began falling. This
      // follows the cell through swaps and resets when it lands or is replaced.
      this.fallDistance = new Uint16Array(SIZE);
      this.onRigidImpact = null;
      this.updated = new Uint8Array(SIZE);
      this.bg = new Uint8Array(SIZE);
      this.visited = new Uint8Array(SIZE);
      this.stack = new Int32Array(SIZE);
      // the server tracks which cells changed so it can broadcast deltas
      this.dirty = opts.trackDirty ? new Set() : null;
      this.seed = 0;
    }

    idx(x, y) {
      return y * COLS + x;
    }

    mark(id) {
      if (this.dirty) this.dirty.add(id);
    }

    setCell(id, mat, customLife) {
      this.grid[id] = mat;
      this.life[id] = customLife !== undefined
        ? Math.min(customLife, 255)
        : (mat === FIRE ? FIRE_LIFE : mat === SMOKE ? SMOKE_LIFE : mat === ICE ? ICE_LIFE : 0);
      this.falling[id] = 0;
      this.fallDistance[id] = 0;
      this.mark(id);
    }

    swap(a, b) {
      const g = this.grid, l = this.life, f = this.falling;
      let t = g[a]; g[a] = g[b]; g[b] = t;
      t = l[a]; l[a] = l[b]; l[b] = t;
      t = f[a]; f[a] = f[b]; f[b] = t;
      t = this.fallDistance[a]; this.fallDistance[a] = this.fallDistance[b]; this.fallDistance[b] = t;
      this.mark(a);
      this.mark(b);
    }

    // Flood from the bedrock border through solid-connected cells. Leaves
    // `visited` set for every cell that is held up by something.
    markSupported() {
      const g = this.grid, visited = this.visited, stack = this.stack;
      visited.fill(0);
      let sp = 0;
      const seed = (id) => {
        if (!visited[id] && IS_SOLID[g[id]]) {
          visited[id] = 1;
          stack[sp++] = id;
        }
      };
      for (let x = 0; x < COLS; x++) {
        seed(x);
        seed((ROWS - 1) * COLS + x);
      }
      for (let y = 0; y < ROWS; y++) {
        seed(y * COLS);
        seed(y * COLS + COLS - 1);
      }
      while (sp > 0) {
        const id = stack[--sp];
        const x = id % COLS;
        if (x > 0) seed(id - 1);
        if (x < COLS - 1) seed(id + 1);
        if (id >= COLS) seed(id - COLS);
        if (id < SIZE - COLS) seed(id + COLS);
      }
      return visited;
    }

    // Any rigid cell that isn't connected to the border has nothing holding it
    // up and starts falling.
    checkStructuralSupport() {
      const visited = this.markSupported();
      const g = this.grid, f = this.falling;
      for (let i = 0; i < SIZE; i++) {
        if (!visited[i] && !f[i] && IS_RIGID[g[i]]) f[i] = 1;
      }
    }

    simulate() {
      const g = this.grid, u = this.updated, f = this.falling;
      u.fill(0);
      for (let y = ROWS - 2; y >= 1; y--) {
        const ltr = Math.random() < 0.5;
        for (let i = 0; i < COLS - 2; i++) {
          const x = 1 + (ltr ? i : COLS - 3 - i);
          const id = y * COLS + x;
          if (u[id]) continue;
          const m = g[id];
          if (m === EMPTY) continue;
          if (f[id] && IS_RIGID[m]) {
            this.updateFallingRigid(x, y, id);
            continue;
          }
          switch (m) {
            case SAND: this.updateSand(x, y, id); break;
            case SNOW: this.updateSnow(x, y, id); break;
            case WATER: this.updateWater(x, y, id); break;
            case FIRE: this.updateFire(x, y, id); break;
            case SMOKE: this.updateSmoke(x, y, id); break;
            case LAVA: this.updateLava(x, y, id); break;
            case ACID: this.updateAcid(x, y, id); break;
            case GAS: this.updateGas(x, y, id); break;
            case OIL: this.updateOil(x, y, id); break;
            case ICE: this.updateIce(x, y, id); break;
            default: break;
          }
        }
      }
    }

    trySwapInto(id, nx, ny, allow) {
      if (nx < 0 || nx >= COLS || ny < 0 || ny >= ROWS) return false;
      const nid = ny * COLS + nx;
      if (this.updated[nid]) return false;
      if (!allow[this.grid[nid]]) return false;
      this.swap(id, nid);
      this.updated[id] = 1;
      this.updated[nid] = 1;
      return true;
    }

    updateFallingRigid(x, y, id) {
      const below = id + COLS;
      if (IS_OPEN[this.grid[below]]) {
        const fromX = x * 3 + 1.5, fromY = y * 3 + 1.5;
        const traveled = Math.min(65535, this.fallDistance[id] + 3);
        const mat = this.grid[id];
        this.swap(id, below);
        this.fallDistance[below] = traveled;
        if (traveled >= 12 && mat !== LEAVES && typeof this.onRigidImpact === 'function') {
          // The cellular step is 3px. Estimate impact velocity from accumulated
          // free-fall distance, then report the actual movement segment so bodies
          // can be tested without inferring a hit from nearby terrain.
          const speed = Math.min(420, Math.sqrt(2 * 900 * traveled));
          this.onRigidImpact({
            fromX, fromY, toX: fromX, toY: fromY + 3,
            mat, speed, fallDistance: traveled,
          });
        }
        this.updated[id] = 1;
        this.updated[below] = 1;
      } else {
        this.falling[id] = 0;
        this.fallDistance[id] = 0;
        this.updated[id] = 1;
      }
    }

    updateSand(x, y, id) {
      if (this.trySwapInto(id, x, y + 1, SAND_INTO)) return;
      const dir = Math.random() < 0.5 ? 1 : -1;
      if (this.trySwapInto(id, x + dir, y + 1, SAND_INTO)) return;
      this.trySwapInto(id, x - dir, y + 1, SAND_INTO);
    }

    // Snow: a light powder that only occasionally slides sideways, so it
    // piles up steeper than sand and caps peaks and branches.
    updateSnow(x, y, id) {
      if (this.trySwapInto(id, x, y + 1, INTO_EMPTY)) return;
      if (Math.random() < 0.3) {
        const dir = Math.random() < 0.5 ? 1 : -1;
        if (this.trySwapInto(id, x + dir, y + 1, INTO_EMPTY)) return;
        this.trySwapInto(id, x - dir, y + 1, INTO_EMPTY);
      }
    }

    updateWater(x, y, id) {
      if (this.trySwapInto(id, x, y + 1, WATER_DOWN)) return;
      const dir = Math.random() < 0.5 ? 1 : -1;
      if (this.trySwapInto(id, x + dir, y + 1, WATER_DOWN)) return;
      if (this.trySwapInto(id, x - dir, y + 1, WATER_DOWN)) return;
      if (this.trySwapInto(id, x + dir, y, INTO_EMPTY)) return;
      this.trySwapInto(id, x - dir, y, INTO_EMPTY);
    }

    // Oil: a runny liquid lighter than water (water sinks through it), and
    // very flammable — see the fire/lava rules.
    updateOil(x, y, id) {
      if (this.trySwapInto(id, x, y + 1, INTO_EMPTY)) return;
      const dir = Math.random() < 0.5 ? 1 : -1;
      if (this.trySwapInto(id, x + dir, y + 1, INTO_EMPTY)) return;
      if (this.trySwapInto(id, x - dir, y + 1, INTO_EMPTY)) return;
      if (this.trySwapInto(id, x + dir, y, INTO_EMPTY)) return;
      this.trySwapInto(id, x - dir, y, INTO_EMPTY);
    }

    // Sets a flammable neighbour on fire. Grass scorches to dirt instead of
    // burning away, passing the flame to the air above so grass fires roll
    // across a meadow without eating holes in the ground.
    ignite(nid, nm, fireLife) {
      if (nm === GRASS) {
        this.setCell(nid, DIRT, 1);
        const up = nid - COLS;
        if (up >= COLS && this.grid[up] === EMPTY) this.setCell(up, FIRE, fireLife);
        return;
      }
      this.setCell(nid, FIRE, fireLife);
    }

    updateFire(x, y, id) {
      const g = this.grid;
      this.life[id]--;
      this.mark(id);
      if (this.life[id] <= 0) {
        this.setCell(id, Math.random() < 0.6 ? SMOKE : EMPTY);
        this.updated[id] = 1;
        return;
      }
      for (const [dx, dy] of NEIGHBORS8) {
        const nx = x + dx, ny = y + dy;
        if (nx < 0 || nx >= COLS || ny < 0 || ny >= ROWS) continue;
        const nid = ny * COLS + nx;
        const nm = g[nid];
        const flam = FLAMMABILITY[nm];
        if (flam > 0) {
          if (Math.random() < flam) this.ignite(nid, nm, BURN_LIFE[nm]);
        } else if (nm === WATER) {
          this.setCell(id, SMOKE);
          this.updated[id] = 1;
          return;
        } else if (nm === SNOW || nm === PACKED_ICE) {
          if (Math.random() < (nm === SNOW ? 0.08 : 0.03)) this.setCell(nid, WATER);
        }
      }
      if (y - 1 >= 0 && g[id - COLS] === EMPTY && Math.random() < 0.25) {
        this.swap(id, id - COLS);
        this.updated[id] = 1;
        return;
      }
      this.updated[id] = 1;
    }

    updateSmoke(x, y, id) {
      this.life[id]--;
      this.mark(id);
      if (this.life[id] <= 0) {
        this.setCell(id, EMPTY);
        this.updated[id] = 1;
        return;
      }
      if (this.trySwapInto(id, x, y - 1, INTO_EMPTY)) return;
      const dir = Math.random() < 0.5 ? 1 : -1;
      if (this.trySwapInto(id, x + dir, y - 1, INTO_EMPTY)) return;
      if (this.trySwapInto(id, x - dir, y - 1, INTO_EMPTY)) return;
      this.updated[id] = 1;
    }

    // Lava: a slow, viscous liquid that ignites anything flammable, melts sand
    // into glass and snow/lake ice into water, and turns to stone (with a burst of
    // steam) the moment it touches water.
    updateLava(x, y, id) {
      const g = this.grid;
      for (const [dx, dy] of NEIGHBORS8) {
        const nx = x + dx, ny = y + dy;
        if (nx < 0 || nx >= COLS || ny < 0 || ny >= ROWS) continue;
        const nid = ny * COLS + nx;
        const nm = g[nid];
        const flam = FLAMMABILITY[nm];
        if (flam > 0) {
          if (Math.random() < Math.min(0.6, flam * 2.7)) this.ignite(nid, nm, Math.max(BURN_LIFE[nm], FIRE_LIFE * 1.5));
        } else if (nm === SAND) {
          if (Math.random() < 0.02) this.setCell(nid, GLASS);
        } else if (nm === SNOW || nm === PACKED_ICE) {
          if (Math.random() < 0.1) this.setCell(nid, WATER);
        } else if (nm === WATER) {
          this.setCell(nid, SMOKE, SMOKE_LIFE);
          this.setCell(id, STONE);
          this.updated[id] = 1;
          return;
        }
      }

      if (y - 1 >= 0 && g[id - COLS] === EMPTY && Math.random() < 0.01) {
        this.setCell(id - COLS, FIRE, FIRE_LIFE * 0.6);
      }

      // viscous: moves far less often than water
      if (Math.random() < 0.5) {
        this.updated[id] = 1;
        return;
      }
      if (this.trySwapInto(id, x, y + 1, INTO_EMPTY)) return;
      const dir = Math.random() < 0.5 ? 1 : -1;
      if (this.trySwapInto(id, x + dir, y + 1, INTO_EMPTY)) return;
      if (this.trySwapInto(id, x - dir, y + 1, INTO_EMPTY)) return;
      this.updated[id] = 1;
    }

    // Acid: flows like water but slowly dissolves what it touches. Stone, gold
    // and glass resist it, so glass makes a safe container.
    updateAcid(x, y, id) {
      const g = this.grid;
      for (const [dx, dy] of NEIGHBORS4) {
        const nx = x + dx, ny = y + dy;
        if (nx < 0 || nx >= COLS || ny < 0 || ny >= ROWS) continue;
        const nid = ny * COLS + nx;
        const rate = ACID_RATE[g[nid]];
        if (rate > 0 && Math.random() < rate) this.setCell(nid, EMPTY);
      }

      if (this.trySwapInto(id, x, y + 1, INTO_EMPTY)) return;
      const dir = Math.random() < 0.5 ? 1 : -1;
      if (this.trySwapInto(id, x + dir, y + 1, INTO_EMPTY)) return;
      if (this.trySwapInto(id, x - dir, y + 1, INTO_EMPTY)) return;
      if (this.trySwapInto(id, x + dir, y, INTO_EMPTY)) return;
      this.trySwapInto(id, x - dir, y, INTO_EMPTY);
    }

    // Spell ice: solid and standable, but temporary. It thaws back into the water it
    // was made from, so a frozen wall is a strong play that you know will not last.
    // Fire and lava melt it on contact rather than waiting out the timer.
    updateIce(x, y, id) {
      this.life[id]--;
      this.mark(id);
      if (this.life[id] <= 0) {
        this.setCell(id, WATER);
        this.updated[id] = 1;
        return;
      }
      const g = this.grid;
      for (const [dx, dy] of NEIGHBORS8) {
        const nx = x + dx, ny = y + dy;
        if (nx < 0 || nx >= COLS || ny < 0 || ny >= ROWS) continue;
        const nm = g[ny * COLS + nx];
        if (nm === FIRE || nm === LAVA) {
          this.setCell(id, WATER);
          this.updated[id] = 1;
          return;
        }
      }
      this.updated[id] = 1;
    }

    // Gas: rises like smoke, but ignites into fire the instant it touches fire/lava —
    // a chain reaction that can rip through an entire cloud in a couple of ticks.
    updateGas(x, y, id) {
      const g = this.grid;
      for (const [dx, dy] of NEIGHBORS8) {
        const nx = x + dx, ny = y + dy;
        if (nx < 0 || nx >= COLS || ny < 0 || ny >= ROWS) continue;
        const nm = g[ny * COLS + nx];
        if (nm === FIRE || nm === LAVA) {
          this.setCell(id, FIRE, FIRE_LIFE * 1.4);
          this.updated[id] = 1;
          return;
        }
      }

      if (this.trySwapInto(id, x, y - 1, INTO_EMPTY)) return;
      const dir = Math.random() < 0.5 ? 1 : -1;
      if (this.trySwapInto(id, x + dir, y - 1, INTO_EMPTY)) return;
      if (this.trySwapInto(id, x - dir, y - 1, INTO_EMPTY)) return;
      this.updated[id] = 1;
    }
  }

  // ---------- noise / randomness ----------

  function mulberry32(seed) {
    let a = seed >>> 0;
    return () => {
      a = (a + 0x6D2B79F5) | 0;
      let t = Math.imul(a ^ (a >>> 15), 1 | a);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  function hash2(seed, x, y) {
    let h = (seed | 0) ^ Math.imul(x | 0, 0x27d4eb2d) ^ Math.imul(y | 0, 0x165667b1);
    h = Math.imul(h ^ (h >>> 15), 0x2c1b3c6d);
    h = Math.imul(h ^ (h >>> 12), 0x297a2d39);
    h ^= h >>> 15;
    return (h >>> 0) / 4294967296;
  }

  // smooth value noise in [0, 1]
  function noise2(seed, x, y) {
    const xi = Math.floor(x), yi = Math.floor(y);
    const xf = x - xi, yf = y - yi;
    const u = xf * xf * (3 - 2 * xf), v = yf * yf * (3 - 2 * yf);
    const a = hash2(seed, xi, yi), b = hash2(seed, xi + 1, yi);
    const c = hash2(seed, xi, yi + 1), d = hash2(seed, xi + 1, yi + 1);
    const top = a + (b - a) * u;
    return top + (c + (d - c) * u - top) * v;
  }

  function fbm(seed, x, y, octaves) {
    let sum = 0, amp = 1, norm = 0, f = 1;
    for (let o = 0; o < octaves; o++) {
      sum += noise2(seed + o * 101, x * f, y * f) * amp;
      norm += amp;
      amp *= 0.5;
      f *= 2;
    }
    return sum / norm;
  }

  const clamp = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v);
  // A moving object hits only when its center enters the target's expanded box.
  // Starting inside returns false, preventing spawn overlap and repeated hits as a
  // falling cell continues through the same body.
  function segmentRectEntry(x0, y0, x1, y1, rx, ry, rw, rh, pad = 0) {
    const left = rx - pad, right = rx + rw + pad;
    const top = ry - pad, bottom = ry + rh + pad;
    if (x0 > left && x0 < right && y0 > top && y0 < bottom) return null;
    const dx = x1 - x0, dy = y1 - y0;
    let lo = 0, hi = 1;
    for (const [start, delta, min, max] of [[x0, dx, left, right], [y0, dy, top, bottom]]) {
      if (Math.abs(delta) < 1e-9) {
        if (start < min || start > max) return null;
        continue;
      }
      let a = (min - start) / delta, b = (max - start) / delta;
      if (a > b) { const t = a; a = b; b = t; }
      lo = Math.max(lo, a);
      hi = Math.min(hi, b);
      if (lo > hi) return null;
    }
    return hi >= 0 && lo <= 1 && hi > 0 ? Math.max(0, lo) : null;
  }

  function segmentEntersRect(x0, y0, x1, y1, rx, ry, rw, rh, pad = 0) {
    return segmentRectEntry(x0, y0, x1, y1, rx, ry, rw, rh, pad) !== null;
  }

  function impactDamage(speed, mat, sizeFactor = 1) {
    if (!(speed >= 140) || (!IS_RIGID[mat] && mat !== ICE) || mat === LEAVES) return 0;
    let mass = 1;
    if (mat === WOOD || mat === TIMBER) mass = 0.9;
    else if (mat === GLASS) mass = 0.75;
    else if (mat === STONE || mat === BRICK || mat === GOLD
      || mat === PACKED_ICE || mat === SANDSTONE || mat === BEDROCK) mass = 1.35;
    return clamp((speed - 120) * 0.045 * mass * sizeFactor, 1, 22);
  }
  const lerp = (a, b, t) => a + (b - a) * t;
  const smoothstep = (t) => {
    t = clamp(t, 0, 1);
    return t * t * (3 - 2 * t);
  };

  // ---------- procedural generation ----------

  const BIOME = { PLAINS: 0, FOREST: 1, DESERT: 2, TUNDRA: 3 };
  const BIOME_NAMES = ['plains', 'forest', 'desert', 'tundra'];
  // offset: raises (negative) or lowers the ground; amp: hill height; ridge: blend
  // toward sharp ridged peaks; dunes: height of sharp-crested dune ripples.
  const BIOME_TERRAIN = [
    { offset: 4, amp: 14, ridge: 0, dunes: 0 },
    { offset: -4, amp: 26, ridge: 0.15, dunes: 0 },
    { offset: 10, amp: 12, ridge: 0, dunes: 6 },
    { offset: -34, amp: 52, ridge: 0.85, dunes: 0 },
  ];
  // Characters are drawn at CHAR_SCALE (sprites.js); their collision box is
  // 10x16 art pixels times that, in world units. The server has no sprites.js, so
  // this default must match CHAR_SCALE — the client passes the real value and
  // warns if they ever disagree.
  const DEFAULT_BODY_SCALE = 2;

  class Generator {
    constructor(world, seed, opts = {}) {
      // Everything a body has to walk through is sized from the body itself:
      // doors, rooms, shafts, tunnels. Ledges are spaced within one jump.
      const S = opts.bodyScale || DEFAULT_BODY_SCALE;
      const cell = opts.cellSize || 3;
      this.S = S;
      this.bodyW = Math.ceil((10 * S) / cell);
      this.bodyH = Math.ceil((16 * S) / cell);
      this.jump = opts.jumpCells || 12; // jump apex in cells (190 px/s at 500 px/s², 3 px cells)
      this.stepUp = opts.stepUpCells || S + 1; // ledge height a body walks up without jumping
      // Rooms leave headroom to step up onto a crate. Upper floors are reached by a
      // few crate steps under a stairwell and a jump: a real staircase would wall
      // off the ground floor, and every building has to be walkable end to end.
      this.roomH = this.bodyH + this.stepUp + 1; // clear height inside a room
      this.doorH = this.bodyH + 2;
      this.storey = this.roomH + 1; // a room plus the slab it stands on
      this.reach = this.jump - 0.5; // what a jump actually clears, allowing for frame timing
      this.stairSteps = Math.max(0, Math.ceil((this.storey - this.reach) / this.stepUp));
      // Vertical spacing of climbable ledges. A jump clears less than a body's height,
      // so a ledge can never be directly above where you stand — ledges alternate
      // walls, and each is reachable from the one on the opposite wall below it.
      this.ledgeGap = Math.min(this.jump - 3, this.bodyH);
      this.ledgeW = Math.max(3, Math.ceil(this.bodyW * 0.7));
      this.shaftW = this.ledgeW + this.bodyW + 3; // room to climb past a ledge
      this.treeScale = 1 + (S - 1) * 0.6;

      this.world = world;
      this.grid = world.grid;
      this.life = world.life;
      this.bg = world.bg;
      this.seed = seed >>> 0;
      this.rng = mulberry32(this.seed);
      this.heights = new Int32Array(COLS); // first solid row of each column
      this.biome = new Uint8Array(COLS);
      this.used = new Uint8Array(COLS); // surface columns claimed by a structure or lake
      this.lakeCol = new Uint8Array(COLS);
      this.protect = new Uint8Array(SIZE); // cells caves and cave pools must leave alone
      this.regions = [];
      this.sites = [];
      this.lakes = [];
    }

    // -- random helpers --
    rand() { return this.rng(); }
    range(a, b) { return a + this.rng() * (b - a); }
    int(a, b) { return b <= a ? a : a + Math.floor(this.rng() * (b - a + 1)); }
    chance(p) { return this.rng() < p; }
    pick(arr) { return arr[Math.floor(this.rng() * arr.length)]; }
    shuffle(arr) {
      for (let i = arr.length - 1; i > 0; i--) {
        const j = Math.floor(this.rng() * (i + 1));
        [arr[i], arr[j]] = [arr[j], arr[i]];
      }
      return arr;
    }
    noise(salt, x, y, octaves = 1) {
      return octaves > 1 ? fbm(this.seed + salt, x, y, octaves) : noise2(this.seed + salt, x, y);
    }
    hash(x, y, salt = 0) { return hash2(this.seed + salt, x, y); }

    // -- cell helpers --
    inside(x, y) { return x > 0 && x < COLS - 1 && y > 0 && y < ROWS - 1; }
    get(x, y) { return this.inside(x, y) ? this.grid[y * COLS + x] : BEDROCK; }
    set(x, y, mat, variant = 0) {
      if (!this.inside(x, y)) return;
      const id = y * COLS + x;
      this.grid[id] = mat;
      this.life[id] = variant;
    }
    setBg(x, y, type) {
      if (this.inside(x, y)) this.bg[y * COLS + x] = type;
    }
    claim(x0, x1) {
      for (let x = Math.max(1, x0); x <= Math.min(COLS - 2, x1); x++) this.used[x] = 1;
    }
    isFree(x0, x1) {
      if (x0 < 2 || x1 > COLS - 3) return false;
      for (let x = x0; x <= x1; x++) if (this.used[x]) return false;
      return true;
    }
    protectRect(x0, y0, x1, y1) {
      for (let y = Math.max(0, y0); y <= Math.min(ROWS - 1, y1); y++) {
        for (let x = Math.max(0, x0); x <= Math.min(COLS - 1, x1); x++) this.protect[y * COLS + x] = 1;
      }
    }
    randVariant(mat, x, y) {
      return Math.floor(this.hash(x, y, mat * 7) * PALETTE[mat].length);
    }
    // brick courses 3 rows tall, staggered every other course
    brickVariant(x, y, base) {
      const course = Math.floor(y / 3);
      const mortar = y % 3 === 0 || (x + (course % 2) * 3) % 6 === 0;
      if (mortar) return base === V.BRICK_STONE ? V.BRICK_MORTAR_DARK : V.BRICK_MORTAR;
      return this.hash(x, course, 3) < 0.3 ? base + (base === V.BRICK_RED ? 2 : 1) : base;
    }
    // big sandstone blocks for the pyramid
    blockVariant(x, y) {
      const course = Math.floor(y / 3);
      if (y % 3 === 0 || (x + (course % 2) * 4) % 8 === 0) return 1;
      const h = this.hash(Math.floor((x + (course % 2) * 4) / 8), course, 5);
      return h < 0.25 ? 3 : h < 0.6 ? 0 : 2;
    }

    run() {
      const w = this.world;
      this.grid.fill(EMPTY);
      this.life.fill(0);
      this.bg.fill(BG.SKY);
      w.falling.fill(0);
      w.fallDistance.fill(0);

      this.planBiomes();
      this.shapeTerrain();
      this.planStructures();
      this.planLakes();
      this.fillTerrain();
      this.paintBackdrop();
      this.carveCaves();
      this.placeOres();
      this.buildCrypt();
      this.buildStructures();
      this.placePockets();
      this.fillCavePools();
      this.fillLakes();
      this.plantVegetation();
      this.addBedrock();
      this.pruneUnsupported();

      w.falling.fill(0);
      w.fallDistance.fill(0);
      if (w.dirty) w.dirty.clear();
      w.seed = this.seed;
    }

    // -- biomes and terrain shape --

    planBiomes() {
      // Horizontal regions 110-190 columns wide; the middle one (where players
      // spawn) is always plains, the rest cycle through the other biomes.
      const bounds = [1];
      let x = 1;
      for (;;) {
        const w = this.int(110, 190);
        if (x + w > COLS - 2 - 80) break;
        x += w;
        bounds.push(x);
      }
      bounds.push(COLS - 1);
      const n = bounds.length - 1;
      let center = 0;
      for (let i = 0; i < n; i++) if (COLS / 2 >= bounds[i] && COLS / 2 < bounds[i + 1]) center = i;

      const pool = this.shuffle([BIOME.FOREST, BIOME.DESERT, BIOME.TUNDRA]).concat(this.shuffle([BIOME.FOREST, BIOME.DESERT, BIOME.TUNDRA]));
      let prev = -1;
      for (let i = 0; i < n; i++) {
        let b;
        if (i === center) {
          b = BIOME.PLAINS;
        } else {
          const at = pool.findIndex((p) => p !== prev);
          b = pool.splice(at, 1)[0];
        }
        this.regions.push({ x0: bounds[i], x1: bounds[i + 1] - 1, biome: b });
        prev = b;
      }
      this.centerRegion = this.regions[center];
    }

    shapeTerrain() {
      const T = 30; // half-width of the blend band between neighbouring regions
      const groundBase = Math.floor(ROWS * 0.5);
      const duneFreq = this.range(0.04, 0.06), dunePhase = this.range(0, 100);
      for (let x = 1; x < COLS - 1; x++) {
        let offset = 0, amp = 0, ridge = 0, dunes = 0, wsum = 0;
        for (let r = 0; r < this.regions.length; r++) {
          const reg = this.regions[r];
          // distance inside the region; the world edges don't count as boundaries
          const dl = r === 0 ? Infinity : x - reg.x0;
          const dr = r === this.regions.length - 1 ? Infinity : reg.x1 - x;
          const d = Math.min(dl, dr);
          const wgt = smoothstep((d + T) / (2 * T));
          if (wgt <= 0) continue;
          const p = BIOME_TERRAIN[reg.biome];
          offset += p.offset * wgt;
          amp += p.amp * wgt;
          ridge += p.ridge * wgt;
          dunes += p.dunes * wgt;
          wsum += wgt;
        }
        offset /= wsum; amp /= wsum; ridge /= wsum; dunes /= wsum;

        const hills = this.noise(11, x * 0.008, 0, 4) * 2 - 1;
        const detail = (this.noise(12, x * 0.07, 0, 2) * 2 - 1) * 0.08;
        const ridged = 1 - Math.abs(this.noise(13, x * 0.01, 3.7, 3) * 2 - 1) * 2.2;
        const shape = (1 - ridge) * hills * 1.6 + ridge * ridged;
        const dune = Math.pow(1 - Math.abs(Math.sin(x * duneFreq + dunePhase)), 1.8) * dunes;
        const h = groundBase + offset - amp * (shape + detail) - dune;
        this.heights[x] = clamp(Math.round(h), 70, ROWS - 110);
      }
      // surface materials switch at one point per boundary, nudged off the
      // exact region edge so it doesn't line up with the terrain blend
      let r = 0;
      const shift = this.regions.map(() => this.int(-12, 12));
      for (let x = 1; x < COLS - 1; x++) {
        while (r < this.regions.length - 1 && x >= this.regions[r + 1].x0 + shift[r + 1]) r++;
        this.biome[x] = this.regions[r].biome;
      }
      this.heights[0] = this.heights[1];
      this.heights[COLS - 1] = this.heights[COLS - 2];
    }

    // cut and fill the heightmap to a flat pad, easing back into the natural
    // ground over a few columns on each side
    flatten(x0, x1, floor, margin = 6) {
      for (let x = x0; x <= x1; x++) if (x > 0 && x < COLS - 1) this.heights[x] = floor;
      for (let i = 1; i <= margin; i++) {
        const t = smoothstep(i / (margin + 1));
        for (const x of [x0 - i, x1 + i]) {
          if (x < 1 || x > COLS - 2 || this.used[x]) continue;
          this.heights[x] = Math.round(lerp(floor, this.heights[x], t));
        }
      }
    }

    medianHeight(x0, x1) {
      const hs = [];
      for (let x = x0; x <= x1; x++) hs.push(this.heights[x]);
      hs.sort((a, b) => a - b);
      return hs[hs.length >> 1];
    }

    // pick the flattest free stretch of `width` columns inside [lo, hi]
    findSite(lo, hi, width, pad = 4, tries = 40) {
      lo = Math.max(lo, 4 + pad);
      hi = Math.min(hi, COLS - 5 - pad - width);
      if (hi <= lo) return null;
      let best = -1, bestRough = Infinity;
      for (let t = 0; t < tries; t++) {
        const x0 = this.int(lo, hi);
        if (!this.isFree(x0 - pad, x0 + width - 1 + pad)) continue;
        let mn = Infinity, mx = -Infinity;
        for (let x = x0; x < x0 + width; x++) {
          mn = Math.min(mn, this.heights[x]);
          mx = Math.max(mx, this.heights[x]);
        }
        if (mx - mn < bestRough) {
          bestRough = mx - mn;
          best = x0;
        }
      }
      return best < 0 ? null : { x0: best, rough: bestRough };
    }

    planStructures() {
      // keep the spawn column clear so new players land on open ground
      this.claim(COLS / 2 - this.bodyW - 4, COLS / 2 + this.bodyW + 4);

      const village = this.centerRegion;
      const vc = (village.x0 + village.x1) >> 1;
      const lo = Math.max(village.x0, vc - 85), hi = Math.min(village.x1, vc + 85);
      const houses = this.int(3, 4);
      const bw = this.bodyW;
      for (let i = 0; i < houses; i++) {
        // two storeys need room for a staircase between the doors
        if (this.chance(0.45)) this.planHouse(lo, hi, this.int(bw * 5 + 4, bw * 6 + 4), 2, 'village');
        else this.planHouse(lo, hi, this.int(bw * 4, bw * 5), 1, 'village');
      }
      const well = this.findSite(lo, hi, 8, 3);
      if (well && well.rough <= 8) {
        const floor = this.medianHeight(well.x0, well.x0 + 7);
        this.flatten(well.x0 - 1, well.x0 + 8, floor, 4);
        this.claim(well.x0 - 2, well.x0 + 9);
        this.protectRect(well.x0 - 3, floor - 14, well.x0 + 10, floor + 24);
        this.sites.push({ type: 'well', x: well.x0 + 4, floor });
      }

      let mines = 0;
      for (const r of this.regions) {
        if (r.biome === BIOME.DESERT) this.planPyramid(r);
        if (r.biome === BIOME.TUNDRA) this.planHouse(r.x0, r.x1, this.int(this.bodyW * 3 + 4, this.bodyW * 4), 1, 'cabin', 14);
        if ((r.biome === BIOME.FOREST || r.biome === BIOME.TUNDRA) && this.chance(0.85)) this.planTower(r);
        if (r.biome !== BIOME.DESERT && (this.chance(0.6) || (mines === 0 && r === this.regions[this.regions.length - 1]))) {
          if (this.planMine(r)) mines++;
        }
      }
      for (const r of this.regions) {
        if (mines === 0 && r.biome !== BIOME.DESERT && this.planMine(r, 16)) mines++;
      }
    }

    // Flat ground outside a doorway, wide enough to stand on without your head in
    // the wall above the door.
    get apron() {
      return this.bodyW + 2;
    }

    planHouse(lo, hi, w, storeys, style, maxRough = 12) {
      const a = this.apron;
      const site = this.findSite(lo, hi, w + 2 * a, 5);
      if (!site || site.rough > maxRough) return;
      const x0 = site.x0 + a;
      const floor = this.medianHeight(x0, x0 + w - 1);
      this.flatten(x0 - a, x0 + w - 1 + a, floor);
      this.claim(x0 - a - 1, x0 + w + a);
      this.protectRect(x0 - 5, floor - storeys * this.storey - (w >> 1) - 10, x0 + w + 4, floor + 22);
      this.sites.push({ type: 'house', x0, w, floor, storeys, style });
    }

    planPyramid(r) {
      const w = this.int(Math.max(48, this.roomH * 4), Math.max(64, this.roomH * 5 + 4));
      const a = this.apron;
      const site = this.findSite(r.x0 + 8, r.x1 - 8, w + 2 * a, 6);
      if (!site || site.rough > 16) return;
      site.x0 += a;
      const floor = this.medianHeight(site.x0, site.x0 + w);
      this.flatten(site.x0 - a, site.x0 + w + a, floor, 8);
      this.claim(site.x0 - a - 1, site.x0 + w + a + 1);
      this.protectRect(site.x0 - 4, floor - (w >> 1) - 8, site.x0 + w + 4, floor + 26);
      this.sites.push({ type: 'pyramid', x0: site.x0, w, floor });
    }

    planTower(r) {
      const inner = this.shaftW;
      const w = inner + 4 + this.int(0, 2);
      const a = this.apron;
      const site = this.findSite(r.x0, r.x1, w + 2 * a, 4);
      if (!site || site.rough > 14) return;
      const x0 = site.x0 + a;
      const floor = this.medianHeight(x0, x0 + w - 1);
      const height = Math.min(this.int(this.ledgeGap * 3, this.ledgeGap * 5), floor - 12);
      this.flatten(x0 - a, x0 + w - 1 + a, floor, 5);
      this.claim(x0 - a - 1, x0 + w + a);
      this.protectRect(x0 - 5, floor - height - 6, x0 + w + 4, floor + 20);
      this.sites.push({ type: 'tower', x0, w, floor, height });
    }

    planMine(r, maxRough = 10) {
      const span = this.shaftW + 6;
      const site = this.findSite(r.x0, r.x1, span, 4);
      if (!site || site.rough > maxRough) return false;
      const x = site.x0 + (span >> 1);
      const floor = this.medianHeight(site.x0, site.x0 + span - 1);
      this.flatten(site.x0, site.x0 + span - 1, floor, 5);
      this.claim(site.x0 - 1, site.x0 + span);
      const dir = x < COLS / 2 ? 1 : -1;
      const depth = Math.min(this.int(this.ledgeGap * 4, this.ledgeGap * 6), ROWS - 40 - floor);
      const room = dir > 0 ? COLS - 12 - (x + this.shaftW) : x - this.shaftW - 12;
      this.sites.push({ type: 'mine', x, floor, depth, len: Math.min(this.int(45, 85), room), dir });
      return true;
    }

    planLakes() {
      for (const r of this.regions) {
        const desert = r.biome === BIOME.DESERT;
        const count = desert ? (this.chance(0.75) ? 1 : 0) : this.int(1, 2);
        for (let i = 0; i < count; i++) {
          const w = desert ? this.int(16, 22) : this.int(22, 46);
          // settle into a valley: of a few free spots, keep the lowest ground
          let bestX = -1, bestH = -1;
          for (let t = 0; t < 30; t++) {
            const x0 = this.int(r.x0 + 3, r.x1 - w - 3);
            if (!this.isFree(x0 - 3, x0 + w + 3)) continue;
            const hMid = this.heights[x0 + (w >> 1)];
            if (hMid > bestH) {
              bestH = hMid;
              bestX = x0;
            }
          }
          if (bestX < 0) continue;
          const x0 = bestX, x1 = bestX + w;
          const level = Math.max(this.heights[x0], this.heights[x1]); // the lower lip sets the waterline
          const depth = desert ? this.int(3, 5) : this.int(5, 10);
          let deepest = level;
          for (let x = x0 + 1; x < x1; x++) {
            const t = (x - x0) / (x1 - x0);
            const bottom = level + Math.round(depth * Math.pow(Math.sin(Math.PI * t), 0.5));
            this.heights[x] = Math.max(this.heights[x], bottom);
            deepest = Math.max(deepest, this.heights[x]);
            this.lakeCol[x] = 1;
          }
          this.claim(x0 - 2, x1 + 2);
          this.protectRect(x0 - 3, level - 6, x1 + 3, deepest + 6);
          this.lakes.push({ x0, x1, level, biome: r.biome, bridge: !desert && r.biome !== BIOME.TUNDRA && w >= 30 && this.chance(0.6) });
        }
      }
    }

    // -- ground layers --

    fillTerrain() {
      const hs = this.heights;
      for (let x = 1; x < COLS - 1; x++) {
        const h = hs[x];
        const b = this.biome[x];
        const steep = Math.max(Math.abs(hs[x + 1] - h), Math.abs(hs[x - 1] - h)) >= 2;
        const n = this.noise(21, x * 0.07, 0);
        const jitter = this.hash(x, 0, 22) < 0.3 ? 1 : 0;
        let layers;
        if (this.lakeCol[x]) {
          layers = steep ? [[DIRT, 4]] : [[SAND, 2 + jitter], [DIRT, 4]];
        } else if (b === BIOME.DESERT) {
          layers = steep
            ? [[SANDSTONE, 12 + Math.round(n * 6)]]
            : [[SAND, 5 + Math.round(n * 6) + jitter], [SANDSTONE, 7 + Math.round(n * 6)]];
        } else if (b === BIOME.TUNDRA) {
          layers = steep ? [] : [[SNOW, 2 + Math.round(n * 2)], [DIRT, 2 + Math.round(n * 2) + jitter]];
        } else {
          layers = [[GRASS, 1], [DIRT, 4 + Math.round(n * 5) + jitter]];
        }
        let y = h;
        for (const [mat, thick] of layers) {
          for (let k = 0; k < thick && y < ROWS - 1; k++, y++) {
            this.set(x, y, mat, mat === SANDSTONE ? this.sandstoneVariant(x, y) : this.randVariant(mat, x, y));
          }
        }
        for (; y < ROWS - 1; y++) this.set(x, y, STONE, this.stoneVariant(x, y, h));
      }
    }

    // stone darkens with depth, with some speckle
    stoneVariant(x, y, h) {
      if (this.hash(x, y, 31) < 0.05) return 3;
      const depth = (y - h) / (ROWS - h) + (this.noise(32, x * 0.05, y * 0.05) - 0.5) * 0.35;
      return depth < 0.22 ? 0 : depth < 0.55 ? 1 : 2;
    }

    // sedimentary stripes
    sandstoneVariant(x, y) {
      const band = (y + Math.round(this.noise(33, x * 0.04, 0) * 4)) % 4;
      return band === 0 ? 1 : this.hash(x, y, 34) < 0.5 ? 0 : 2;
    }

    paintBackdrop() {
      for (let x = 1; x < COLS - 1; x++) {
        const h = this.heights[x];
        const soil = h + 6 + Math.floor(this.hash(x, 0, 35) * 3);
        for (let y = 1; y < ROWS - 1; y++) {
          this.bg[y * COLS + x] = y < h ? BG.SKY : y < soil ? BG.DIRT : BG.CAVE;
        }
      }
    }

    // -- underground --

    carveCell(x, y, anything = false) {
      if (!this.inside(x, y)) return;
      const id = y * COLS + x;
      if (this.protect[id]) return;
      const m = this.grid[id];
      if (anything ? m !== BEDROCK : (m === STONE || m === DIRT || m === SANDSTONE || m === COAL)) {
        this.grid[id] = EMPTY;
        this.life[id] = 0;
      }
    }

    carveDisc(cx, cy, r, anything = false) {
      const gx = Math.round(cx), gy = Math.round(cy), ri = Math.ceil(r);
      for (let dy = -ri; dy <= ri; dy++) {
        for (let dx = -ri; dx <= ri; dx++) {
          if (dx * dx + dy * dy <= r * r) this.carveCell(gx + dx, gy + dy, anything);
        }
      }
    }

    minCaveDepth(x) {
      return this.biome[x] === BIOME.DESERT ? 30 : 22;
    }

    carveCaves() {
      // 1) caverns: thresholded 2D noise, stretched wide, more common with depth
      for (let y = 4; y < ROWS - 5; y++) {
        for (let x = 3; x < COLS - 3; x++) {
          const depth = y - this.heights[x] - this.minCaveDepth(x);
          if (depth < 0) continue;
          const d = Math.min(1, depth / 80);
          const n = this.noise(41, x * 0.024, y * 0.042, 4);
          if (n > 0.665 - 0.06 * d) this.carveCell(x, y);
        }
      }

      // 2) winding tunnels, mostly horizontal
      const worms = this.int(12, 18);
      for (let w = 0; w < worms; w++) {
        let cx = this.range(12, COLS - 12);
        const top = this.heights[cx | 0] + this.minCaveDepth(cx | 0) + 4;
        if (top >= ROWS - 20) continue;
        let cy = this.range(top, ROWS - 16);
        let dir = this.chance(0.5) ? this.range(-0.5, 0.5) : Math.PI + this.range(-0.5, 0.5);
        const steps = this.int(60, 150);
        for (let s = 0; s < steps; s++) {
          dir += (this.rand() - 0.5) * 0.5;
          dir += (Math.round(dir / Math.PI) * Math.PI - dir) * 0.04;
          cx += Math.cos(dir) * 2;
          cy += Math.sin(dir) * 1.4;
          if (cx < 4 || cx >= COLS - 4 || cy >= ROWS - 8) break;
          if (cy < this.heights[cx | 0] + this.minCaveDepth(cx | 0)) break;
          this.carveDisc(cx, cy, (2 + this.noise(42, s * 0.2, w) * 1.8) * this.S * 0.85);
        }
      }

      // 3) a few cave mouths opening onto the surface of grassland/forest
      const mouths = this.int(2, 3);
      for (let i = 0, tries = 0; i < mouths && tries < 60; tries++) {
        const x = this.int(12, COLS - 12);
        const b = this.biome[x];
        if (b === BIOME.DESERT || b === BIOME.TUNDRA || !this.isFree(x - this.bodyH, x + this.bodyH)) continue;
        let cx = x, cy = this.heights[x] - 2;
        let dir = Math.PI / 2 + this.range(-0.5, 0.5);
        const bore = Math.max(3, this.bodyH * 0.6);
        const steps = this.int(28, 50);
        for (let s = 0; s < steps; s++) {
          dir = clamp(dir + (this.rand() - 0.5) * 0.35, Math.PI * 0.22, Math.PI * 0.78);
          cx += Math.cos(dir) * 1.6;
          cy += Math.sin(dir) * 1.6;
          this.carveDisc(cx, cy, bore + this.rand() * 0.8, true);
        }
        this.claim(x - Math.ceil(bore) - 2, x + Math.ceil(bore) + 2);
        i++;
      }
    }

    // random-walk blob of `mat` replacing only plain stone
    vein(mat, x, y, steps, rMin, rMax) {
      for (let s = 0; s < steps; s++) {
        const r = this.range(rMin, rMax);
        const ri = Math.ceil(r);
        for (let dy = -ri; dy <= ri; dy++) {
          for (let dx = -ri; dx <= ri; dx++) {
            if (dx * dx + dy * dy > r * r) continue;
            const px = Math.round(x) + dx, py = Math.round(y) + dy;
            if (this.get(px, py) === STONE) this.set(px, py, mat, this.randVariant(mat, px, py));
          }
        }
        x += this.range(-1.6, 1.6);
        y += this.range(-1, 1);
      }
    }

    // noise-warped ellipse test so pockets don't come out as perfect ovals
    inBlob(cx, cy, dx, dy, rx, ry) {
      const d = (dx * dx) / (rx * rx) + (dy * dy) / (ry * ry);
      return d <= 0.55 + 0.6 * this.noise(81, (cx + dx) * 0.3, (cy + dy) * 0.3);
    }

    // true if every cell of the ellipse (plus margin) is solid stone-like rock.
    // Flammable pockets (gas, oil) can't be sealed by coal, or a smouldering seam
    // would light them the moment play starts.
    enclosed(cx, cy, rx, ry, allowCoal = true) {
      for (let dy = -ry; dy <= ry; dy++) {
        for (let dx = -rx; dx <= rx; dx++) {
          if ((dx * dx) / (rx * rx) + (dy * dy) / (ry * ry) > 1) continue;
          const m = this.get(cx + dx, cy + dy);
          if (m !== STONE && m !== GOLD && !(allowCoal && m === COAL)) return false;
          if (this.protect[(cy + dy) * COLS + cx + dx]) return false;
        }
      }
      return true;
    }

    fillBlob(cx, cy, rx, ry, mat) {
      for (let dy = -ry; dy <= ry; dy++) {
        for (let dx = -rx; dx <= rx; dx++) {
          if (!this.inBlob(cx, cy, dx, dy, rx, ry)) continue;
          this.set(cx + dx, cy + dy, mat, this.randVariant(mat, cx + dx, cy + dy));
          this.setBg(cx + dx, cy + dy, BG.CAVE);
        }
      }
    }

    placeOres() {
      const coal = this.int(28, 40);
      for (let i = 0; i < coal; i++) {
        const x = this.int(4, COLS - 5);
        this.vein(COAL, x, this.heights[x] + this.int(12, 90), this.int(6, 16), 1, 2.2);
      }
      const gold = this.int(12, 18);
      for (let i = 0; i < gold; i++) {
        this.vein(GOLD, this.int(4, COLS - 5), this.int(Math.floor(ROWS * 0.7), ROWS - 10), this.int(2, 6), 0.8, 1.6);
      }
      // loose sand pockets: dig into one and the ceiling pours in
      for (let i = 0, placed = 0, want = this.int(3, 6); i < 60 && placed < want; i++) {
        const x = this.int(8, COLS - 9);
        const y = this.heights[x] + this.int(24, 80);
        const rx = this.int(4, 7), ry = this.int(3, 5);
        if (y + ry >= ROWS - 8 || !this.enclosed(x, y, rx + 2, ry + 2)) continue;
        this.fillBlob(x, y, rx, ry, SAND);
        placed++;
      }
    }

    placePockets() {
      // sealed pockets of gas: harmless until someone breaks in with a fire spell
      for (let i = 0, placed = 0, want = this.int(4, 6); i < 80 && placed < want; i++) {
        const x = this.int(10, COLS - 11);
        const y = this.heights[x] + this.int(25, 100);
        const rx = this.int(4, 8), ry = this.int(3, 5);
        if (y + ry >= ROWS - 8 || !this.enclosed(x, y, rx + 2, ry + 2, false)) continue;
        this.fillBlob(x, y, rx, ry, GAS);
        placed++;
      }
      // oil reservoirs deeper down
      for (let i = 0, placed = 0, want = this.int(2, 4); i < 80 && placed < want; i++) {
        const x = this.int(14, COLS - 15);
        const y = this.heights[x] + this.int(40, 120);
        const rx = this.int(6, 12), ry = this.int(3, 6);
        if (y + ry >= ROWS - 8 || !this.enclosed(x, y, rx + 2, ry + 2, false)) continue;
        this.fillBlob(x, y, rx, ry, OIL);
        placed++;
      }
    }

    // Collects the empty cells a liquid poured at (sx, sy) would settle into if
    // its surface sat at row `level`. Returns null if the pool would leak past
    // `cap`, spill into a protected space (a structure's interior), or touch a
    // different liquid (or, for acid/lava, anything it would dissolve or ignite).
    floodBelow(sx, sy, level, cap, liquid) {
      const seen = new Set([sy * COLS + sx]);
      const queue = [sy * COLS + sx];
      for (let qi = 0; qi < queue.length; qi++) {
        const id = queue[qi];
        const x = id % COLS, y = (id / COLS) | 0;
        // 8-connected, since liquids also flow diagonally downward
        for (const [dx, dy] of NEIGHBORS8) {
          const nx = x + dx, ny = y + dy;
          if (ny < level || !this.inside(nx, ny)) continue;
          const nid = ny * COLS + nx;
          const m = this.grid[nid];
          if ((IS_LIQUID[m] && m !== liquid) || (liquid === ACID && ACID_RATE[m] > 0)
            || (liquid === LAVA && FLAMMABILITY[m] > 0)) return null;
          if (seen.has(nid) || m !== EMPTY) continue;
          if (this.protect[nid]) return null;
          seen.add(nid);
          queue.push(nid);
          if (queue.length > cap) return null;
        }
      }
      return queue;
    }

    // Still pools of water, acid and lava sitting in cave basins. Filling to a
    // flat level means they're at rest when the simulation starts.
    fillCavePools() {
      const want = { [WATER]: this.int(6, 10), [ACID]: this.int(1, 3), [LAVA]: this.int(3, 6) };
      for (let t = 0; t < 500; t++) {
        const x = this.int(3, COLS - 4);
        const top = this.heights[x] + 20;
        if (top >= ROWS - 8) continue;
        const y = this.int(top, ROWS - 6);
        const id = y * COLS + x;
        if (this.grid[id] !== EMPTY || this.protect[id]) continue;
        let fy = y;
        while (fy < ROWS - 2 && this.grid[(fy + 1) * COLS + x] === EMPTY) fy++;
        if (fy >= ROWS - 3) continue;
        const liquid = fy > ROWS * 0.78
          ? (this.chance(0.75) ? LAVA : WATER)
          : (fy > ROWS * 0.6 && this.chance(0.3) ? ACID : WATER);
        if (want[liquid] <= 0) continue;
        const cells = this.floodBelow(x, fy, fy - this.int(2, 7), liquid === LAVA ? 1400 : 900, liquid);
        if (!cells || cells.length < 30) continue;
        for (const cid of cells) {
          this.grid[cid] = liquid;
          this.life[cid] = 0;
        }
        want[liquid]--;
        if (want[WATER] <= 0 && want[ACID] <= 0 && want[LAVA] <= 0) break;
      }
    }

    // -- structures --

    buildStructures() {
      for (const s of this.sites) {
        if (s.type === 'house') this.buildHouse(s);
        else if (s.type === 'well') this.buildWell(s);
        else if (s.type === 'pyramid') this.buildPyramid(s);
        else if (s.type === 'tower') this.buildTower(s);
        else if (s.type === 'mine') this.buildMine(s);
      }
    }

    // A two-cell-thick door standing on row `floor`. It's timber, so bodies walk
    // through it while it keeps carrying the wall above.
    door(dx, floor) {
      for (let y = floor - this.doorH; y < floor; y++) {
        const frame = y === floor - this.doorH;
        this.set(dx, y, TIMBER, frame ? V.DOOR_FRAME : V.DOOR);
        this.set(dx + 1, y, TIMBER, frame ? V.DOOR_FRAME : (y % 3 ? V.DOOR : V.DOOR_FRAME));
      }
    }

    buildHouse({ x0, w, floor, storeys, style }) {
      const x1 = x0 + w - 1;
      const top = floor - storeys * this.storey; // row of the ceiling slab
      const cabin = style === 'cabin';
      const hatchLeft = this.chance(0.5);
      const wallVariant = (y) => (cabin
        ? (y % 3 === 0 ? V.WOOD_DARK : V.WOOD_BARK)
        : (y % 3 === 0 ? V.WOOD_SEAM : V.WOOD_PLANK));

      // stone-brick foundation flush with the ground
      for (let x = x0 - 1; x <= x1 + 1; x++) {
        for (let y = floor; y <= floor + 1; y++) this.set(x, y, BRICK, this.brickVariant(x, y, V.BRICK_STONE));
      }
      for (let y = top; y < floor; y++) {
        for (let x = x0; x <= x1; x++) {
          if (x <= x0 + 1 || x >= x1 - 1) this.set(x, y, WOOD, wallVariant(y));
          else {
            this.set(x, y, EMPTY);
            this.setBg(x, y, BG.WOOD);
          }
        }
      }

      // Stairwell: crate steps up and back down (so it can be crossed from either
      // door), with the slab opened over the top step and the steps beside it, so
      // there is headroom wherever a step puts your head above the ceiling.
      const stepW = this.bodyW + 1;
      const n = Math.max(1, this.stairSteps);
      const stairW = stepW * (2 * n - 1);
      const sx0 = hatchLeft ? x0 + 3 : x1 - 2 - stairW;
      const holeX0 = sx0 + stepW * Math.max(0, n - 2), holeX1 = sx0 + stairW - 1 - stepW * Math.max(0, n - 2);
      for (let k = 0; k < storeys; k++) {
        const base = floor - k * this.storey; // floor row this storey stands on
        const slab = base - this.storey;
        for (let x = x0; x <= x1; x++) this.set(x, slab, WOOD, V.WOOD_SEAM);
        if (k < storeys - 1) {
          for (let x = holeX0; x <= holeX1; x++) {
            this.set(x, slab, EMPTY);
            this.setBg(x, slab, BG.WOOD);
          }
          for (let i = 0; i < 2 * n - 1; i++) {
            const hgt = this.stepUp * (n - Math.abs(i - (n - 1)));
            const cx0 = sx0 + i * stepW;
            for (let y = base - hgt; y < base; y++) {
              for (let x = cx0; x < cx0 + stepW; x++) {
                const edge = x === cx0 || x === cx0 + stepW - 1 || y === base - hgt;
                this.set(x, y, WOOD, edge ? V.WOOD_DARK : V.WOOD_PLANK);
              }
            }
          }
        }
        const wy = base - 3;
        const winH = Math.max(3, Math.round(this.bodyH * 0.4));
        if (k > 0) {
          // glass windows in both side walls upstairs; downstairs the walls are doors
          for (const wx of [x0, x1 - 1]) {
            for (let y = wy - winH + 1; y <= wy; y++) {
              for (let x = wx; x <= wx + 1; x++) this.set(x, y, GLASS, (x + y) % 3 === 0 ? 1 : 0);
            }
          }
        }
        // a window in the back wall, clear of the hatch
        const bwW = Math.max(4, this.bodyW - 1);
        const bx = hatchLeft ? x1 - 4 - bwW : x0 + 4;
        for (let y = wy - winH + 1; y <= wy; y++) for (let x = bx; x < bx + bwW; x++) this.setBg(x, y, BG.WINDOW);
      }

      // doors on both sides, so the house never walls off the path
      for (const dx of [x0, x1 - 1]) this.door(dx, floor);

      // gable roof with a 2-cell overhang, hollow attic inside
      const roofMat = cabin ? WOOD : BRICK;
      const roofVariant = (r) => (cabin ? (r % 2 ? V.WOOD_DARK : V.WOOD_BARK) : (r % 2 ? V.BRICK_ROOF_DARK : V.BRICK_ROOF));
      for (let r = 0; ; r++) {
        const y = top - r, xl = x0 - 2 + r, xr = x1 + 2 - r;
        if (xl > xr || y < 3) break;
        for (let x = xl; x <= xr; x++) {
          if (r === 0) {
            if (x < x0 || x > x1) this.set(x, y, roofMat, roofVariant(r));
          } else if (x - xl < 2 || xr - x < 2 || xr - xl < 5) {
            this.set(x, y, roofMat, roofVariant(r));
          } else {
            this.set(x, y, EMPTY);
            this.setBg(x, y, BG.WOOD);
          }
        }
      }
      // chimney
      const cx = hatchLeft ? x0 + Math.floor(w * 0.72) : x0 + Math.floor(w * 0.28) - 2;
      const roofTop = top - Math.min(cx - (x0 - 2), x1 + 2 - (cx + 2));
      for (let y = roofTop - 3; y < top; y++) {
        for (let x = cx; x <= cx + 2; x++) this.set(x, y, BRICK, this.brickVariant(x, y, V.BRICK_RED));
      }

      // a table on the ground floor and a bed upstairs, both timber so you walk past them
      const tableH = this.stepUp;
      const tw = this.bodyW;
      const tx = hatchLeft ? x1 - 4 - tw : x0 + 4;
      for (const lx of [tx, tx + tw - 1]) {
        for (let y = floor - tableH + 1; y < floor; y++) this.set(lx, y, TIMBER, V.WOOD_DARK);
      }
      for (let x = tx - 1; x <= tx + tw; x++) this.set(x, floor - tableH, TIMBER, V.WOOD_PLANK);
      if (storeys > 1) {
        const by = floor - this.storey - 1;
        const bl = this.bodyW + 2;
        const bx = hatchLeft ? x1 - 3 - bl : x0 + 3;
        for (let x = bx; x < bx + bl; x++) this.set(x, by, TIMBER, V.WOOD_PLANK);
        const head = hatchLeft ? bx + bl - 1 : bx;
        const foot = hatchLeft ? bx : bx + bl - 1;
        for (let y = by - this.stepUp + 1; y < by; y++) this.set(head, y, TIMBER, V.WOOD_DARK);
        this.set(foot, by - 1, TIMBER, V.WOOD_DARK);
        for (let x = bx + 1; x < bx + bl - 1; x++) this.set(x, by - 1, BRICK, V.BRICK_RED); // blanket
      }
    }

    buildWell({ x, floor }) {
      const xl = x - 3, xr = x + 2; // brick rim around a 4-wide shaft, low enough to step over
      const rim = Math.min(2, this.stepUp);
      const depth = this.int(12, 18);
      for (let y = floor - rim; y <= floor + depth; y++) {
        this.set(xl, y, BRICK, this.brickVariant(xl, y, V.BRICK_STONE));
        this.set(xr, y, BRICK, this.brickVariant(xr, y, V.BRICK_STONE));
      }
      for (let sx = xl + 1; sx < xr; sx++) {
        for (let y = floor - rim; y < floor + depth; y++) {
          this.set(sx, y, y >= floor + 2 ? WATER : EMPTY);
          this.setBg(sx, y, y < floor ? BG.SKY : BG.BRICK);
        }
        this.set(sx, floor + depth, BRICK, this.brickVariant(sx, floor + depth, V.BRICK_STONE));
      }
      // the winch frame and its little roof are background, so they don't block the path
      const frameTop = floor - rim - this.bodyH - 3;
      for (let y = frameTop; y < floor - rim; y++) {
        this.setBg(xl, y, BG.BEAM);
        this.setBg(xr, y, BG.BEAM);
      }
      for (let sx = xl + 1; sx < xr; sx++) this.setBg(sx, frameTop + 3, BG.BEAM);
      for (let r = 0; r < 3; r++) {
        for (let sx = xl - 2 + r; sx <= xr + 2 - r; sx++) this.setBg(sx, frameTop - r, BG.ROOF);
      }
    }

    buildPyramid({ x0, w, floor }) {
      const half = w >> 1;
      const cx = x0 + half;
      // steps no taller than a body can walk up, so the pyramid can be climbed over
      const stepH = Math.min(3, this.stepUp), inset = 3;

      for (let x = cx - half - 1; x <= cx + half + 1; x++) {
        for (let y = floor; y <= floor + 2; y++) this.set(x, y, SANDSTONE, this.blockVariant(x, y));
      }
      let level = 0;
      for (; ; level++) {
        const hw = half - level * inset;
        if (hw < 2) break;
        const yb = floor - level * stepH - 1;
        for (let y = yb - stepH + 1; y <= yb; y++) {
          for (let x = cx - hw; x <= cx + hw; x++) this.set(x, y, SANDSTONE, this.blockVariant(x, y));
        }
      }
      // gilded capstone
      const apex = floor - level * stepH;
      for (let x = cx - 1; x <= cx + 1; x++) this.set(x, apex - 1, GOLD, 1);
      this.set(cx, apex - 2, GOLD, 1);

      // burial chamber with a heap of gold, on a corridor running right through, so
      // the pyramid never walls off the desert
      const side = this.chance(0.5) ? -1 : 1; // which side the sand trap is on
      const chHalf = this.bodyW + 5;
      const chTop = floor - this.roomH - 3;
      for (let y = chTop; y < floor; y++) {
        for (let x = cx - chHalf; x <= cx + chHalf; x++) {
          this.set(x, y, EMPTY);
          this.setBg(x, y, BG.SANDSTONE);
        }
      }
      // A corridor right through leaves the upper pyramid resting on nothing, so it
      // is propped on timber posts — load-bearing, but you walk straight past them.
      for (const dir of [-1, 1]) {
        for (let i = 0; ; i++) {
          const x = cx + dir * (chHalf + 1 + i);
          if (Math.abs(x - cx) > half + 1) break;
          const post = i % 10 === 4;
          for (let y = floor - this.doorH; y < floor; y++) {
            if (post) this.set(x, y, TIMBER, V.WOOD_DARK);
            else this.set(x, y, EMPTY);
            this.setBg(x, y, BG.SANDSTONE);
          }
        }
      }
      // centred, so there's a body's width of clear floor between it and each
      // corridor mouth (standing on the heap, your head is above the corridor)
      const gx = cx;
      const heap = Math.min(this.stepUp + 1, 4);
      for (let row = 0; row < heap; row++) {
        for (let x = gx - 4 + row; x <= gx + 4 - row; x++) this.set(x, floor - 1 - row, GOLD, this.randVariant(GOLD, x, row));
      }
      // a sand trap packed above the corridor ceiling — only where the pyramid is
      // tall enough to hold it in, or it would just pour into the corridor at start
      const needLevels = Math.ceil((this.doorH + 6) / stepH);
      const maxD = half - needLevels * inset - 3; // furthest from centre with that much pyramid overhead
      const minD = chHalf + 5;
      if (maxD >= minD) {
        const trapX = cx + side * Math.floor((minD + maxD) / 2);
        for (let y = floor - this.doorH - 4; y <= floor - this.doorH - 2; y++) {
          for (let x = trapX - 3; x <= trapX + 3; x++) this.set(x, y, SAND, this.randVariant(SAND, x, y));
        }
      }
    }

    // A hollow tower climbed by jumping between ledges on alternating walls.
    buildTower({ x0, w, floor, height }) {
      const x1 = x0 + w - 1;
      const top = floor - height;
      const brick = (x, y) => this.set(x, y, BRICK, this.brickVariant(x, y, V.BRICK_STONE));

      for (let x = x0 - 1; x <= x1 + 1; x++) for (let y = floor; y <= floor + 2; y++) brick(x, y);
      for (let y = top; y < floor; y++) {
        for (let x = x0; x <= x1; x++) {
          if (x <= x0 + 1 || x >= x1 - 1) brick(x, y);
          else {
            this.set(x, y, EMPTY);
            this.setBg(x, y, BG.BRICK);
          }
        }
      }
      // A ledge low enough to jump onto from the floor would sit at head height and
      // block walking through, so a crate step (low enough to walk over) comes first
      // and the ledges start above head height.
      for (let y = floor - this.stepUp; y < floor; y++) {
        for (let x = x0 + 2; x < x0 + 2 + this.ledgeW; x++) brick(x, y);
      }
      let lvl = 0;
      for (let y = floor - this.stepUp - this.ledgeGap; y > top + 2; y -= this.ledgeGap, lvl++) {
        const lx = lvl % 2 === 1 ? x0 + 2 : x1 - 1 - this.ledgeW;
        for (let x = lx; x < lx + this.ledgeW; x++) brick(x, y);
        // a glazed arrow slit above each ledge (open slits would cut the wall in two)
        const sx = lvl % 2 === 1 ? x0 : x1 - 1;
        for (let sy = y - 5; sy <= y - 2; sy++) { this.set(sx, sy, GLASS, 0); this.set(sx + 1, sy, GLASS, sy % 2); }
      }
      // crenellations
      for (let x = x0; x <= x1; x++) {
        if ((x - x0) % 4 < 2) for (let y = top - 2; y < top; y++) brick(x, y);
      }
      // doors on both sides
      for (const dx of [x0, x1 - 1]) this.door(dx, floor);

      // most towers are ruins: shear the top off at an angle and leave rubble
      if (this.chance(0.75)) {
        const fromLeft = this.chance(0.5);
        const maxCut = Math.floor(height * 0.5);
        for (let x = x0; x <= x1; x++) {
          const t = fromLeft ? (x1 - x) / (w - 1) : (x - x0) / (w - 1);
          const cut = Math.round(t * maxCut + this.rand() * 3);
          for (let y = top - 2; y < top - 2 + cut; y++) this.set(x, y, EMPTY);
        }
        // rubble lands beyond the apron, so it never stands between you and the door
        const rx = fromLeft ? x0 - this.apron - 1 : x1 + this.apron + 1, dir = fromLeft ? -1 : 1;
        const rows = Math.min(this.stepUp, 3);
        for (let row = 0; row < rows; row++) {
          for (let i = 0; i < 9 - row * 3; i++) {
            if (this.chance(0.8)) brick(rx + dir * (i + row), floor - 1 - row);
          }
        }
      }
    }

    // How far a mine gallery can run before it would cut into something protected
    // (a lake bed, the crypt, a building's footings) — it stops a few cells short.
    galleryLength(start, dir, ceil, bottom, len) {
      for (let i = 0; i < len; i++) {
        const tx = start + dir * i;
        for (let y = ceil - 2; y <= bottom + 2; y++) {
          if (!this.inside(tx, y) || this.protect[y * COLS + tx]) return Math.max(0, i - 3);
        }
      }
      return len;
    }

    buildMine({ x, floor, depth, len, dir }) {
      const sw = this.shaftW;
      const sl = x - (sw >> 1), sr = sl + sw - 1; // shaft interior
      const bottom = floor + depth;
      // the headframe is background, so walking up to the pit doesn't hit a wall
      const frameTop = floor - this.bodyH - 5;
      for (let y = frameTop; y < floor; y++) {
        this.setBg(sl - 1, y, BG.BEAM);
        this.setBg(sr + 1, y, BG.BEAM);
      }
      for (let bx = sl - 2; bx <= sr + 2; bx++) this.setBg(bx, frameTop, BG.BEAM);
      for (let bx = x - 2; bx <= x + 1; bx++) for (let y = frameTop - 3; y < frameTop; y++) this.setBg(bx, y, BG.BEAM);

      // plank-lined shaft with alternating ledges to drop down or jump back up
      for (let y = floor; y < bottom; y++) {
        for (let sx = sl; sx <= sr; sx++) {
          this.set(sx, y, EMPTY);
          this.setBg(sx, y, BG.CAVE);
        }
        this.set(sl - 1, y, WOOD, y % 4 === 0 ? V.WOOD_SEAM : V.WOOD_PLANK);
        this.set(sr + 1, y, WOOD, y % 4 === 0 ? V.WOOD_SEAM : V.WOOD_PLANK);
      }
      // Ledges are laid from the bottom up: a crate step first (so the lowest ledge
      // can sit above head height and not block the way into the gallery), then one
      // every ledgeGap until the last is within a jump of the surface.
      const farSide = dir > 0 ? sl : sr - this.ledgeW + 1; // the wall away from the gallery
      for (let y = bottom - this.stepUp; y < bottom; y++) {
        for (let sx = farSide; sx < farSide + this.ledgeW; sx++) this.set(sx, y, WOOD, y === bottom - this.stepUp ? V.WOOD_PLANK : V.WOOD_DARK);
      }
      for (let y = bottom - this.stepUp - this.ledgeGap, k = 0; y > floor; y -= this.ledgeGap, k++) {
        const nearSide = farSide === sl ? sr - this.ledgeW + 1 : sl;
        const lx = k % 2 === 0 ? nearSide : farSide;
        for (let sx = lx; sx < lx + this.ledgeW; sx++) this.set(sx, y, WOOD, V.WOOD_PLANK);
      }
      // horizontal gallery with timber supports, floored where it crosses caves
      const tunnelH = this.doorH + 1;
      const ceil = bottom - tunnelH - 1;
      const start = dir > 0 ? sr + 1 : sl - 1;
      len = this.galleryLength(start, dir, ceil, bottom, len);
      const end = start + dir * (len - 1);
      this.protectRect(sl, frameTop - 4, sr, bottom);
      this.protectRect(Math.min(start, end), ceil, Math.max(start, end), bottom);
      for (let i = 0; i < len; i++) {
        const tx = start + dir * i;
        for (let y = ceil + 1; y < bottom; y++) {
          this.set(tx, y, EMPTY);
          this.setBg(tx, y, BG.CAVE);
        }
        if (!IS_SOLID[this.get(tx, bottom)]) this.set(tx, bottom, WOOD, V.WOOD_DARK);
        if (i % 12 === 6) {
          for (let y = ceil + 1; y < bottom; y++) this.setBg(tx, y, BG.BEAM);
          for (let bx = tx - 2; bx <= tx + 2; bx++) this.set(bx, ceil, WOOD, V.WOOD_DARK);
        }
      }
      for (let y = ceil + 1; y < bottom; y++) {
        for (let sx = sl; sx <= sr; sx++) this.set(sx, y, EMPTY);
      }
      for (let i = 0; i < 7 && len > 8; i++) {
        const tx = start + dir * this.int(4, len - 2);
        this.vein(COAL, tx, this.chance(0.5) ? ceil - 2 : bottom + 2, this.int(3, 6), 1, 2 * this.S);
      }
      // an abandoned mine cart near the end (no taller than a step), and gold behind it
      const cw = this.bodyW + 2;
      if (len < cw + 10) return;
      const cartX = start + dir * (len - cw - 4);
      const ch = Math.min(this.stepUp, 3);
      for (let i = 0; i < cw; i++) {
        const cxx = cartX + i;
        for (let y = bottom - ch; y < bottom - 1; y++) {
          const wall = i === 0 || i === cw - 1 || y === bottom - 2;
          this.set(cxx, y, wall ? WOOD : COAL, wall ? V.WOOD_DARK : this.randVariant(COAL, cxx, y));
        }
      }
      this.set(cartX + 1, bottom - 1, STONE, 2);
      this.set(cartX + cw - 2, bottom - 1, STONE, 2);
      this.vein(GOLD, start + dir * (len + 1), bottom - 4, 4, 1, 1.5 * this.S);
    }

    // a small chain of brick rooms deep underground with treasure at the end
    buildCrypt() {
      const rooms = [];
      const n = this.int(2, 3);
      let total = 0;
      for (let i = 0; i < n; i++) {
        const w = this.int(this.bodyW * 3 + 4, this.bodyW * 4 + 4);
        const gap = i < n - 1 ? this.int(this.bodyW + 2, this.bodyW * 2) : 0;
        rooms.push({ w, h: this.roomH + this.int(1, 3), gap });
        total += w + gap;
      }
      const tallest = Math.max(...rooms.map((r) => r.h));
      const floorY = this.int(Math.max(ROWS - 48, tallest + 40), ROWS - 16);
      let cx = this.int(20, COLS - 20 - total);
      const brick = (x, y) => this.set(x, y, BRICK, this.brickVariant(x, y, V.BRICK_STONE));
      const shells = [], inner = [];
      for (let i = 0; i < n; i++) {
        const r = rooms[i];
        r.x0 = cx;
        r.x1 = cx + r.w - 1;
        shells.push([r.x0 - 2, floorY - r.h - 2, r.x1 + 2, floorY + 2]);
        inner.push([r.x0, floorY - r.h, r.x1, floorY - 1]);
        if (r.gap) {
          shells.push([r.x1 + 1, floorY - this.doorH - 2, r.x1 + r.gap, floorY + 2]);
          inner.push([r.x1 - 1, floorY - this.doorH, r.x1 + r.gap + 2, floorY - 1]);
        }
        cx = r.x1 + 1 + r.gap;
      }
      for (const [a, b, c, d] of shells) {
        for (let y = b; y <= d; y++) for (let x = a; x <= c; x++) brick(x, y);
        this.protectRect(a, b, c, d);
      }
      for (const [a, b, c, d] of inner) {
        for (let y = b; y <= d; y++) {
          for (let x = a; x <= c; x++) {
            this.set(x, y, EMPTY);
            this.setBg(x, y, BG.BRICK);
          }
        }
      }
      // an acid pit lined with glass (acid can't eat through glass)
      if (n > 1) {
        const r = rooms[0];
        const pw = this.bodyW + 2;
        const px = ((r.x0 + r.x1) >> 1) - (pw >> 1);
        const pd = 4 + this.S;
        for (let y = floorY; y <= floorY + pd; y++) {
          for (let x = px - 1; x <= px + pw; x++) {
            const lining = x === px - 1 || x === px + pw || y === floorY + pd;
            this.set(x, y, lining ? GLASS : ACID, 0);
          }
        }
      }
      // treasure in the last room, flanked by pillars
      const last = rooms[n - 1];
      const gx = (last.x0 + last.x1) >> 1;
      for (let row = 0; row < 4; row++) {
        for (let x = gx - 5 + row; x <= gx + 5 - row; x++) this.set(x, floorY - 1 - row, GOLD, this.randVariant(GOLD, x, row));
      }
      for (const lx of [last.x0 + 2, last.x1 - 2]) {
        for (let y = floorY - last.h; y < floorY; y++) brick(lx, y);
      }
    }

    fillLakes() {
      for (const lake of this.lakes) {
        const { x0, x1, level, biome } = lake;
        for (let x = x0 + 1; x < x1; x++) {
          for (let y = level; y < this.heights[x]; y++) {
            if (this.get(x, y) !== EMPTY) continue;
            const frozen = biome === BIOME.TUNDRA && y < level + 2;
            this.set(x, y, frozen ? PACKED_ICE : WATER, frozen ? this.randVariant(PACKED_ICE, x, y) : 0);
          }
        }
        if (lake.bridge) {
          const deck = level - 1;
          for (let x = x0 - 1; x <= x1 + 1; x++) this.set(x, deck, WOOD, V.WOOD_PLANK);
          for (let x = x0 + 6; x < x1 - 3; x += 8) {
            for (let y = deck + 1; y < this.heights[x]; y++) this.set(x, y, WOOD, V.WOOD_DARK);
          }
        }
      }
    }

    // -- vegetation --

    plantVegetation() {
      const t = this.treeScale;
      const gapOf = (a, b) => this.int(Math.round(a * t), Math.round(b * t));
      let x = 3;
      while (x < COLS - 4) {
        const b = this.biome[x];
        if (this.used[x] || this.lakeCol[x]) { x += 2; continue; }
        const y = this.heights[x];
        if (!IS_SOLID[this.get(x, y)] || this.get(x, y - 1) !== EMPTY) { x += 2; continue; }
        const slope = Math.abs(this.heights[Math.min(x + 2, COLS - 2)] - this.heights[Math.max(x - 2, 1)]);
        let gap;
        if (b === BIOME.FOREST) {
          if (this.chance(0.8)) this.oak(x, y); else this.bush(x, y);
          gap = gapOf(3, 7);
        } else if (b === BIOME.PLAINS) {
          if (this.chance(0.4)) this.oak(x, y); else this.bush(x, y);
          gap = gapOf(10, 26);
        } else if (b === BIOME.DESERT) {
          if (this.chance(0.75)) this.cactus(x, y); else this.deadTree(x, y);
          gap = gapOf(18, 40);
        } else {
          if (slope < 6) this.pine(x, y);
          gap = gapOf(6, 12);
        }
        x += gap;
      }
      for (const lake of this.lakes) {
        if (lake.biome !== BIOME.DESERT) continue;
        for (const [px, lean] of [[lake.x0 - 2, -1], [lake.x1 + 2, 1]]) {
          const py = this.heights[px];
          if (IS_SOLID[this.get(px, py)] && this.get(px, py - 1) === EMPTY) this.palm(px, py, lean);
        }
      }
    }

    // only grows into empty space, never through structures or other plants
    leaf(x, y, variant) {
      if (this.get(x, y) === EMPTY) this.set(x, y, LEAVES, variant);
    }

    // trunks and branches are TIMBER: burns like wood, but bodies walk through it
    trunk(x, y, variant) {
      if (this.get(x, y) === EMPTY || this.get(x, y) === LEAVES) this.set(x, y, TIMBER, variant);
    }

    leafBlob(cx, cy, r, base, variants, squash = 0.8) {
      const ri = Math.ceil(r + 1);
      for (let dy = -ri; dy <= ri; dy++) {
        for (let dx = -ri; dx <= ri; dx++) {
          const x = cx + dx, y = cy + dy;
          const d = Math.hypot(dx, dy / squash);
          const edge = r * (0.75 + 0.4 * this.noise(51, x * 0.45, y * 0.45));
          if (d <= edge) this.leaf(x, y, base + Math.floor(this.hash(x, y, 52) * variants));
        }
      }
    }

    oak(x, gy) {
      const t = this.treeScale;
      const h = Math.round(this.int(8, 14) * t);
      const thick = h > 10 * t;
      const autumn = this.biome[x] === BIOME.FOREST && this.noise(61, x * 0.03, 0) > 0.66;
      const [base, variants] = autumn ? [V.LEAF_AUTUMN, 2] : [V.LEAF_OAK, 3];
      const bark = (y) => (this.hash(x, y, 62) < 0.25 ? V.WOOD_DARK : V.WOOD_BARK);
      for (let i = 1; i <= h; i++) {
        this.trunk(x, gy - i, bark(gy - i));
        if (thick && i < h - 1) this.trunk(x + 1, gy - i, bark(gy - i + 7));
      }
      if (thick) {
        this.trunk(x - 1, gy - 1, V.WOOD_DARK);
        this.trunk(x + 2, gy - 1, V.WOOD_DARK);
      }
      const tips = [[x, gy - h]];
      const branches = this.int(1, 3);
      let side = this.chance(0.5) ? -1 : 1;
      for (let b = 0; b < branches; b++, side = -side) {
        let bx = x + (side > 0 && thick ? 1 : 0);
        let by = gy - Math.round(h * this.range(0.5, 0.8));
        const len = Math.round(this.int(3, 6) * t);
        for (let k = 0; k < len; k++) {
          bx += side;
          if (k % 2 === 1) by--;
          this.trunk(bx, by, V.WOOD_BARK);
        }
        tips.push([bx, by]);
      }
      tips.forEach(([tx, ty], i) => this.leafBlob(tx, ty - 1, (i === 0 ? this.range(4, 6) : this.range(2.5, 4)) * t, base, variants));
    }

    pine(x, gy) {
      const t = this.treeScale;
      const h = Math.round(this.int(12, 21) * t);
      for (let i = 1; i <= h; i++) this.trunk(x, gy - i, i % 3 ? V.WOOD_DARK : V.WOOD_BARK);
      const top = gy - h - 2;
      const rows = h - 1;
      const tiers = this.int(3, 4);
      const tierLen = Math.ceil(rows / tiers);
      let maxHalf = 0;
      for (let r = 0; r < rows; r++) {
        const ti = Math.floor(r / tierLen), local = r % tierLen;
        const half = Math.round(ti * 0.9 * t + local * 0.75);
        maxHalf = Math.max(maxHalf, half);
        for (let dx = -half; dx <= half; dx++) {
          this.leaf(x + dx, top + r, V.LEAF_PINE + (this.hash(x + dx, top + r, 63) < 0.4 ? 1 : 0));
        }
      }
      // snow resting on the tops of the boughs — only above head height, since snow
      // is solid and would otherwise hang in the air at body level under the tree
      for (let dx = -maxHalf; dx <= maxHalf; dx++) {
        for (let y = top; y < gy - this.bodyH - 2; y++) {
          if (this.get(x + dx, y) === LEAVES && this.get(x + dx, y - 1) === EMPTY) {
            if (this.chance(0.7)) this.set(x + dx, y - 1, SNOW, this.randVariant(SNOW, x + dx, y));
            break;
          }
        }
      }
    }

    bush(x, gy) {
      const autumn = this.biome[x] === BIOME.FOREST && this.noise(61, x * 0.03, 0) > 0.66;
      const r = this.range(2, 3.4) * this.treeScale;
      this.leafBlob(x, gy - Math.ceil(r * 0.6), r, autumn ? V.LEAF_AUTUMN : V.LEAF_OAK, autumn ? 2 : 3, 0.6);
    }

    cactus(x, gy) {
      const t = this.treeScale;
      const h = Math.round(this.int(4, 8) * t);
      const thick = t > 1.3;
      for (let i = 1; i <= h; i++) {
        this.set(x, gy - i, LEAVES, V.LEAF_CACTUS);
        if (thick) this.set(x + 1, gy - i, LEAVES, V.LEAF_CACTUS);
      }
      const arms = this.int(0, 2);
      let side = this.chance(0.5) ? -1 : 1;
      for (let a = 0; a < arms; a++, side = -side) {
        const ay = gy - this.int(2, Math.max(2, h - 3));
        const ox = side > 0 && thick ? x + 1 : x;
        const reach = thick ? 3 : 2;
        for (let k = 1; k < reach; k++) this.set(ox + side * k, ay, LEAVES, V.LEAF_CACTUS);
        for (let k = 0; k < Math.round(this.int(2, 3) * t); k++) this.set(ox + side * reach, ay - k, LEAVES, V.LEAF_CACTUS);
      }
    }

    deadTree(x, gy) {
      const t = this.treeScale;
      const h = Math.round(this.int(5, 9) * t);
      for (let i = 1; i <= h; i++) this.trunk(x, gy - i, V.WOOD_DARK);
      let side = this.chance(0.5) ? -1 : 1;
      for (let b = 0; b < this.int(2, 3); b++, side = -side) {
        let bx = x, by = gy - this.int(Math.floor(h / 2), h);
        for (let k = 0; k < Math.round(this.int(2, 4) * t); k++) {
          bx += side;
          by--;
          this.trunk(bx, by, V.WOOD_DARK);
        }
      }
    }

    palm(x, gy, lean) {
      const t = this.treeScale;
      const h = Math.round(this.int(9, 13) * t);
      let tx = x;
      for (let i = 1; i <= h; i++) {
        if (i > 3 && i % Math.round(3 * t) === 0) tx += lean;
        this.trunk(tx, gy - i, i % 2 ? V.WOOD_BARK : V.WOOD_PLANK);
      }
      const ty = gy - h - 1;
      this.set(tx, ty, LEAVES, V.LEAF_PALM);
      for (const [fdx, lift] of [[-1, 1], [1, 1], [-1, 0], [1, 0]]) {
        const len = Math.round(this.int(5, 7) * t);
        for (let k = 1; k <= len; k++) {
          const fy = ty - (lift && k < 3 ? 1 : 0) + Math.round((k * k) / ((lift ? 14 : 8) * t));
          this.leaf(tx + fdx * k, fy, V.LEAF_PALM);
          if (t > 1.3) this.leaf(tx + fdx * k, fy + 1, V.LEAF_PALM);
        }
      }
      this.trunk(tx - 1, ty + 1, V.WOOD_DARK);
      this.trunk(tx + 1, ty + 1, V.WOOD_DARK);
    }

    addBedrock() {
      const g = this.grid, l = this.life;
      const put = (x, y) => {
        g[y * COLS + x] = BEDROCK;
        l[y * COLS + x] = this.hash(x, y, 71) < 0.5 ? 0 : 1;
      };
      for (let x = 0; x < COLS; x++) {
        put(x, 0);
        const t = 1 + Math.floor(this.noise(72, x * 0.06, 0, 2) * 5);
        for (let y = ROWS - 1 - t; y < ROWS; y++) put(x, y);
      }
      for (let y = 0; y < ROWS; y++) {
        put(0, y);
        put(COLS - 1, y);
      }
    }

    // Caves can leave chunks of rock (or a structure's foundations) with nothing
    // holding them up. Small crumbs are removed; bigger islands get stone
    // pillars down to solid ground, so nothing tumbles the moment play starts.
    pruneUnsupported() {
      const g = this.grid;
      const visited = this.world.markSupported();
      const seen = new Uint8Array(SIZE);
      for (let i = 0; i < SIZE; i++) {
        if (visited[i] || seen[i] || !IS_RIGID[g[i]]) continue;
        const cells = [i];
        seen[i] = 1;
        let onlyLeaves = true;
        for (let qi = 0; qi < cells.length; qi++) {
          const id = cells[qi];
          if (g[id] !== LEAVES && g[id] !== TIMBER) onlyLeaves = false;
          const x = id % COLS;
          const around = [x > 0 ? id - 1 : -1, x < COLS - 1 ? id + 1 : -1, id - COLS, id + COLS];
          for (const nid of around) {
            if (nid < 0 || nid >= SIZE || seen[nid] || visited[nid] || !IS_RIGID[g[nid]]) continue;
            seen[nid] = 1;
            cells.push(nid);
          }
        }
        if (cells.length < 80 * this.S * this.S || onlyLeaves) {
          for (const id of cells) {
            g[id] = EMPTY;
            this.life[id] = 0;
          }
          continue;
        }
        const bottom = new Map(); // column -> lowest row of the island
        for (const id of cells) {
          const x = id % COLS, y = (id / COLS) | 0;
          if (!bottom.has(x) || bottom.get(x) < y) bottom.set(x, y);
        }
        const xs = [...bottom.keys()].sort((a, b) => a - b);
        const span = xs[xs.length - 1] - xs[0];
        // one pillar is enough to anchor an island; wide ones get a second
        const count = span > 60 ? 2 : 1;
        const pw = 1 + this.S;
        for (let p = 0; p < count; p++) {
          const px = xs[Math.round(((p + 0.5) / count) * (xs.length - 1))];
          for (let y = bottom.get(px) + 1; y < ROWS - 1; y++) {
            const id = y * COLS + px;
            if (visited[id] && IS_SOLID[g[id]]) break;
            for (let x = px; x < px + pw; x++) {
              this.set(x, y, STONE, 1);
              visited[y * COLS + x] = 1; // now supported; don't prune it as a crumb later in this pass
              seen[y * COLS + x] = 1;
            }
          }
        }
      }
    }
  }

  // opts: { bodyScale, cellSize, jumpCells, stepUpCells } — see Generator.
  function generateWorld(world, seed, opts) {
    if (seed === undefined || seed === null || Number.isNaN(seed)) seed = Math.floor(Math.random() * 0x7fffffff);
    const gen = new Generator(world, seed, opts);
    gen.run();
    return {
      seed: gen.seed,
      regions: gen.regions.map((r) => ({ x0: r.x0, x1: r.x1, biome: BIOME_NAMES[r.biome] })),
      structures: gen.sites.map((s) => s.type),
    };
  }

  // ---------- backdrop colors ----------

  // RGB for every cell's background, drawn wherever the cell is EMPTY.
  function buildBackdrop(bg, out) {
    out = out || new Uint8Array(SIZE * 3);
    for (let y = 0; y < ROWS; y++) {
      const t = Math.min(1, y / (ROWS * 0.55));
      const sr = lerp(12, 42, t), sg = lerp(14, 48, t), sb = lerp(30, 80, t);
      for (let x = 0; x < COLS; x++) {
        const i = y * COLS + x;
        const h = hash2(7, x, y);
        let r, g, b;
        switch (bg[i]) {
          case BG.DIRT: {
            const o = h * 8;
            r = 46 + o; g = 33 + o; b = 27 + o;
            break;
          }
          case BG.CAVE: {
            const o = noise2(9, x * 0.14, y * 0.14) * 12 + h * 4;
            r = 33 + o; g = 30 + o; b = 35 + o;
            break;
          }
          case BG.WOOD: {
            const seam = y % 4 === 0 || (x + ((y >> 2) % 2) * 5) % 11 === 0;
            const o = h * 4;
            if (seam) { r = 42; g = 29; b = 20; } else { r = 66 + o; g = 47 + o; b = 32 + o; }
            break;
          }
          case BG.BRICK: {
            const course = Math.floor(y / 3);
            const seam = y % 3 === 0 || (x + (course % 2) * 3) % 6 === 0;
            if (seam) { r = 30; g = 29; b = 32; } else { r = 52 + h * 5; g = 49 + h * 5; b = 54 + h * 5; }
            break;
          }
          case BG.SANDSTONE: {
            const course = Math.floor(y / 3);
            const seam = y % 3 === 0 || (x + (course % 2) * 4) % 8 === 0;
            if (seam) { r = 82; g = 64; b = 42; } else { r = 106 + h * 6; g = 86 + h * 6; b = 57 + h * 6; }
            break;
          }
          case BG.WINDOW:
            r = 84; g = 110; b = 150;
            break;
          case BG.BEAM:
            r = 74 + h * 5; g = 52 + h * 4; b = 34 + h * 3;
            break;
          case BG.ROOF:
            if (y % 2) { r = 78; g = 34; b = 30; } else { r = 92; g = 40; b = 34; }
            break;
          default: // sky, with a few stars up high
            if (y < ROWS * 0.35 && h < 0.0025) {
              const s = 110 + h * 40000;
              r = s; g = s; b = s + 10;
            } else {
              r = sr; g = sg; b = sb;
            }
        }
        out[i * 3] = r;
        out[i * 3 + 1] = g;
        out[i * 3 + 2] = b;
      }
    }
    return out;
  }

  return {
    COLS, ROWS, SIZE, MAT, MAT_COUNT, FIRE_LIFE, SMOKE_LIFE, ICE_LIFE, BG, V, DEFAULT_BODY_SCALE,
    IS_SOLID, BLOCKS_BODY, IS_RIGID, IS_OPEN, IS_LIQUID, FLAMMABILITY, BURN_LIFE, ACID_RATE, PALETTE, NAMES,
    World, generateWorld, buildBackdrop, segmentRectEntry, segmentEntersRect, impactDamage,
  };
});
