const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');
const PixelWorld = require('../world');

const PIXEL = 3;
const { COLS, ROWS, MAT } = PixelWorld;
const source = fs.readFileSync(path.join(__dirname, '..', 'bending.js'), 'utf8');
const ctx = {
  PixelWorld, PIXEL, COLS, ROWS, PLAYER_BOX: { w: 20, h: 32 },
  EMPTY: MAT.EMPTY, WATER: MAT.WATER, FIRE: MAT.FIRE, SMOKE: MAT.SMOKE, GAS: MAT.GAS,
  SMOKE_LIFE: PixelWorld.SMOKE_LIFE, LAVA: MAT.LAVA, STONE: MAT.STONE,
  IS_SOLID: PixelWorld.IS_SOLID, PALETTE: PixelWorld.PALETTE,
  FX_PALETTE: { Fire: { glow: 0, core: 0 }, Air: { glow: 0, core: 0 } },
  Phaser: { Display: { Color: { GetColor: () => 0 } } },
};
const { WaterBending, EarthBending, FireBending, AirBending } =
  vm.runInNewContext(source + '\n({ WaterBending, EarthBending, FireBending, AirBending })', ctx);

function scene() {
  const hits = [];
  const damage = [];
  const selfHits = [];
  const casterFx = [];
  const grid = new Uint8Array(COLS * ROWS);
  return {
    hits, damage, selfHits, casterFx, grid, life: new Uint8Array(grid.length),
    time: { now: 1000 },
    player: { x: 20, y: 20, w: 20, h: 32 },
    remotePlayers: { other: { x: 100, y: 100 } },
    netId: 'self',
    enemies: { list: [{ x: 140, y: 100, w: 20, h: 28, vx: 0, vy: 0 }] },
    debris: [], projectiles: [],
    input: { activePointer: { worldX: 100, worldY: 100 } },
    add: { graphics: () => ({ setDepth() { return this; } }) },
    fx: { burst() {}, shards() {}, shake() {} },
    idx(x, y) { return y * COLS + x; },
    setCell(id, mat) { grid[id] = mat; },
    reportHit(...args) { hits.push(args); },
    damageEnemy(...args) { damage.push(args); },
    receiveHit(msg) { selfHits.push(msg); },
    emitFireCasterParticles(count) { casterFx.push(count); },
  };
}

test('water contact gives other players and enemies a swimming state', () => {
  const s = scene();
  const bend = new WaterBending(s);
  bend.held.push({ x: 105, y: 105 });
  bend.free.push({ x: 145, y: 105 });
  bend.touchBodies();
  assert.equal(s.hits[0][0], 'other');
  assert.equal(s.hits[0][4].wetMs, 450);
  assert.equal(s.enemies.list[0].wetUntil, 1450);
  bend.touchBodies();
  assert.equal(s.hits.length, 1);
});

test('fire ignites fuel and burns touched bodies', () => {
  const s = scene();
  const bend = new FireBending(s);
  const wood = s.idx(41, 40);
  s.grid[wood] = MAT.WOOD;
  const ember = { x: 40 * PIXEL + 1, y: 40 * PIXEL + 1, vx: 180, vy: 0 };
  assert.equal(bend.moveDrop(ember, 0.02), 'consumed');
  assert.equal(s.grid[wood], MAT.FIRE);
  bend.held.push({ x: 105, y: 105 }, { x: 145, y: 105 });
  bend.touchBodies();
  assert.equal(s.hits[0][4].burnMs, 1200);
  assert.equal(s.damage[0][2], 'Fire');
  assert.equal(s.enemies.list[0].burnUntil, 2200);
  s.debris.push({ x: 105, y: 105, mat: MAT.WOOD });
  bend.touchObjects();
  assert.equal(s.debris.length, 0);
  assert.equal(s.grid[s.idx(35, 35)], MAT.FIRE);
});

test('earth breaks light terrain and strikes bodies', () => {
  const s = scene();
  const bend = new EarthBending(s);
  const glass = s.idx(41, 40);
  s.grid[glass] = MAT.GLASS;
  const rock = { x: 40 * PIXEL + 1, y: 40 * PIXEL + 1, vx: 200, vy: 0,
    cells: [{ ox: 0, oy: 0 }] };
  assert.equal(bend.rockCollides(rock, 3, 0, 'thrown'), false);
  assert.equal(s.grid[glass], MAT.EMPTY);
  rock.x = 105; rock.y = 105;
  s.debris.push({ x: 105, y: 105, mat: MAT.GLASS, vx: 0, vy: 0 });
  bend.strikeBodies(rock);
  assert.equal(s.debris.length, 0);
  assert.equal(s.hits[0][1], 'Earth');
  assert.ok(s.hits[0][2] > 0);
  rock.x = 145;
  bend.strikeBodies(rock);
  assert.equal(s.damage[0][2], 'Earth');
});

test('air preserves enemy push and relays player push', () => {
  const s = scene();
  const bend = new AirBending(s);
  bend.gust(120, 112, 50, 100);
  assert.ok(s.enemies.list[0].impulseX > 0);
  assert.equal(s.hits[0][1], 'Air');
  assert.ok(s.hits[0][4].ix < 0);
});

test('bending contact applies water, earth, fire, and air to the caster', () => {
  const s = scene();
  const point = { x: 25, y: 25 };

  const water = new WaterBending(s);
  water.held.push(point);
  water.touchBodies();
  assert.equal(s.selfHits.at(-1).bend.wetMs, 450);

  const earth = new EarthBending(s);
  earth.strikeBodies({ x: point.x, y: point.y, vx: 200, vy: 0,
    cells: [{ ox: 0, oy: 0 }] });
  assert.equal(s.selfHits.at(-1).element, 'Earth');
  assert.ok(s.selfHits.at(-1).amount > 0);

  const fire = new FireBending(s);
  fire.begin();
  fire.held.push(point);
  fire.touchBodies();
  assert.equal(s.selfHits.at(-1).bend.burnMs, 1200);
  assert.equal(s.casterFx[0], 10);

  const air = new AirBending(s);
  air.gust(30, 36, 30, 50);
  assert.equal(s.selfHits.at(-1).element, 'Air');
  assert.ok(s.selfHits.at(-1).bend.iy < 0);
});
