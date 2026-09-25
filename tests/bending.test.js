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
  FX_PALETTE: { Fire: { glow: 1, core: 2, deep: 3, spark: 4, accent: 5 },
    Air: { glow: 0, core: 0 } },
  Phaser: { Display: { Color: { GetColor: () => 0 } } },
  Math: Object.assign(Object.create(Math), { random: () => 0 }),
};
const { WaterBending, EarthBending, FireBending, AirBending, orbitStrike } =
  vm.runInNewContext(source + '\n({ WaterBending, EarthBending, FireBending, AirBending, orbitStrike })', ctx);

function scene() {
  const hits = [];
  const damage = [];
  const selfHits = [];
  const casterFx = [];
  const visualFx = [];
  const grid = new Uint8Array(COLS * ROWS);
  return {
    hits, damage, selfHits, casterFx, visualFx, grid, life: new Uint8Array(grid.length),
    time: { now: 1000 },
    player: { x: 20, y: 20, w: 20, h: 32 },
    remotePlayers: { other: { x: 100, y: 100 } },
    netId: 'self',
    enemies: { list: [{ x: 140, y: 100, w: 20, h: 28, vx: 0, vy: 0 }] },
    debris: [], projectiles: [],
    input: { activePointer: { worldX: 100, worldY: 100 } },
    add: { graphics: () => ({ setDepth() { return this; } }) },
    fx: {
      burst(...args) { visualFx.push(['burst', ...args]); },
      ring(...args) { visualFx.push(['ring', ...args]); },
      shockwave(...args) { visualFx.push(['shockwave', ...args]); },
      streaks(...args) { visualFx.push(['streaks', ...args]); },
      smoke(...args) { visualFx.push(['smoke', ...args]); },
      hitstop(...args) { visualFx.push(['hitstop', ...args]); },
      shards() {}, shake() {},
    },
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

test('water, earth, and fire bending spare the caster while air pushes them', () => {
  const s = scene();
  const point = { x: 25, y: 25 };

  const water = new WaterBending(s);
  water.held.push(point);
  water.touchBodies();
  assert.equal(s.selfHits.length, 0);

  const earth = new EarthBending(s);
  earth.strikeBodies({ x: point.x, y: point.y, vx: 200, vy: 0,
    cells: [{ ox: 0, oy: 0 }] });
  assert.equal(s.selfHits.length, 0);

  const fire = new FireBending(s);
  fire.begin();
  fire.held.push(point);
  fire.touchBodies();
  assert.equal(s.selfHits.length, 0);
  assert.equal(s.casterFx[0], 10);

  const air = new AirBending(s);
  air.gust(30, 36, 30, 50);
  assert.equal(s.selfHits.at(-1).element, 'Air');
  assert.ok(s.selfHits.at(-1).bend.iy < 0);
});

test('fire embers originate at the caster and travel toward the cursor', () => {
  const s = scene();
  const fire = new FireBending(s);
  fire.grab(0.05);
  assert.ok(fire.held.length > 0);
  for (const ember of fire.held) {
    assert.ok(ember.x >= s.player.x && ember.x <= s.player.x + s.player.w);
    assert.ok(ember.y >= s.player.y && ember.y <= s.player.y + s.player.h);
  }
  const startX = fire.held[0].x;
  fire.steerHeld(0.05);
  assert.ok(fire.held[0].x > startX);
});

test('orbit strikes do not knock the caster back', () => {
  const s = scene();
  let args;
  s.bodiesInRadius = () => [{ self: false, enemy: s.enemies.list[0] }];
  s.knockback = (...values) => { args = values; };
  orbitStrike(s, 30, 36, 140);
  assert.equal(args[6], true);
});

test('Bolt Punch turns held embers into a travelling fireball that hits and ignites', () => {
  const s = scene();
  s.remotePlayers.other = { x: 115, y: 20 };
  s.input.activePointer = { worldX: 200, worldY: 36 };
  const fire = new FireBending(s);
  for (let i = 0; i < 25; i++) fire.held.push({ x: 70, y: 36, vx: 0, vy: 0, life: 5 });
  s.debris.push({ x: 120, y: 36, mat: MAT.WOOD });
  assert.equal(fire.punch(), true);
  assert.equal(fire.held.length, 0);
  assert.equal(fire.fireballs[0].mass, 25);
  fire.updateFireballs(0.12);
  assert.equal(fire.fireballs.length, 0);
  assert.equal(s.hits[0][1], 'Fire');
  assert.equal(s.debris.length, 0);
  assert.ok(s.grid.includes(MAT.FIRE));
  assert.ok(s.visualFx.some((e) => e[0] === 'ring'));
  assert.equal(s.selfHits.length, 0);
});

test('Bolt Punch keeps its embers visible and sheds fire along its flight', () => {
  const s = scene();
  s.input.activePointer = { worldX: 200, worldY: 36 };
  const fire = new FireBending(s);
  for (let i = 0; i < 24; i++) {
    fire.held.push({ x: 70 + i % 5, y: 34 + i % 3, vx: 0, vy: 0, life: 5 });
  }
  fire.punch();
  const ball = fire.fireballs[0];
  assert.equal(ball.embers.length, 24);
  const drawn = [];
  fire.gfx = {
    clear() {},
    fillStyle() { return this; },
    fillRect(...args) { drawn.push(args); return this; },
    fillCircle() { throw new Error('fireball should not be drawn as a circle'); },
  };
  fire.draw();
  assert.equal(drawn.length, ball.embers.length * 2);
  const before = s.visualFx.length;
  fire.updateFireballs(0.05);
  assert.ok(fire.fireballs[0].x > 70);
  assert.ok(s.visualFx.slice(before).some((e) => e[0] === 'burst'
    && e[5]?.shape === 'square'));
});

test('Orbit Punch sends the held embers in all directions', () => {
  const s = scene();
  const fire = new FireBending(s);
  fire.form = 'Orbit';
  for (let i = 0; i < 16; i++) {
    const angle = i * Math.PI * 2 / 16;
    fire.held.push({ x: 30 + Math.cos(angle) * 20, y: 36 + Math.sin(angle) * 20,
      vx: 0, vy: 0, life: 5 });
  }
  s.debris.push({ x: 45, y: 36, mat: MAT.WOOD });
  assert.equal(fire.punch(), true);
  assert.equal(fire.held.length, 0);
  assert.equal(fire.free.length, 16);
  assert.ok(fire.free.some((d) => d.vx > 0));
  assert.ok(fire.free.some((d) => d.vx < 0));
  assert.ok(fire.free.some((d) => d.vy > 0));
  assert.ok(fire.free.some((d) => d.vy < 0));
  assert.ok(fire.free.every((d) => (d.x - 30) * d.vx + (d.y - 36) * d.vy > 0));
  assert.equal(s.debris.length, 0);
  assert.ok(s.visualFx.some((e) => e[0] === 'shockwave'));
  assert.equal(s.selfHits.length, 0);
});
