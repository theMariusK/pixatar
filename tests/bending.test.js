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
  const cellWrites = [];
  const grid = new Uint8Array(COLS * ROWS);
  return {
    hits, damage, selfHits, casterFx, visualFx, cellWrites, grid, life: new Uint8Array(grid.length),
    collapseTimer: 120,
    time: { now: 1000 },
    player: { x: 20, y: 20, w: 20, h: 32 },
    remotePlayers: { other: { x: 100, y: 100 } },
    netId: 'self',
    enemies: { list: [{ x: 140, y: 100, w: 20, h: 28, vx: 0, vy: 0 }] },
    debris: [], projectiles: [],
    input: { activePointer: { worldX: 100, worldY: 100 } },
    add: { graphics: () => ({ setDepth() { return this; } }) },
    fx: {
      impact(...args) { visualFx.push(['impact', ...args]); },
      burst(...args) { visualFx.push(['burst', ...args]); },
      ring(...args) { visualFx.push(['ring', ...args]); },
      shockwave(...args) { visualFx.push(['shockwave', ...args]); },
      streaks(...args) { visualFx.push(['streaks', ...args]); },
      smoke(...args) { visualFx.push(['smoke', ...args]); },
      hitstop(...args) { visualFx.push(['hitstop', ...args]); },
      shards(...args) { visualFx.push(['shards', ...args]); },
      shake() {},
    },
    idx(x, y) { return y * COLS + x; },
    setCell(id, mat, life = 0) {
      grid[id] = mat;
      this.life[id] = life;
      cellWrites.push([id, mat, life]);
    },
    spawnDebris(x, y, mat) {
      if (this.debris.length >= 80) return;
      const chunk = { x: x * PIXEL + PIXEL / 2, y: y * PIXEL + PIXEL / 2,
        vx: 0, vy: 0, mat, variant: this.life[this.idx(x, y)] };
      this.debris.push(chunk);
      return chunk;
    },
    reportHit(...args) { hits.push(args); },
    damageEnemy(...args) { damage.push(args); },
    receiveHit(msg) { selfHits.push(msg); },
    emitFireCasterParticles(count) { casterFx.push(count); },
  };
}

function elementalScene() {
  const s = scene();
  s.benders = {
    Water: new WaterBending(s), Earth: new EarthBending(s),
    Fire: new FireBending(s), Air: new AirBending(s),
  };
  return s;
}

function fireball(x = 180, y = 180, mass = 24) {
  return { x, y, mass, size: 9, vx: 440, vy: 0, age: 0, life: 2, trail: 0,
    embers: [{ radius: 5, angle: 0, spin: 1, phase: 0, scale: 1 }] };
}

function earthShield(x = 210, y = 180) {
  return { x, y, vx: 0, vy: 0, age: 1,
    cells: Array.from({ length: 7 }, (_, i) => ({ ox: 0, oy: i - 3, shade: 0 })) };
}

test('water and airborne embers consume each other into steam regardless of which moves', () => {
  for (const element of ['Water', 'Fire']) {
    const s = elementalScene();
    const drop = { x: element === 'Water' ? 180 : 192, y: 180, vx: 0, vy: 0, age: 0 };
    const ember = { x: element === 'Fire' ? 180 : 192, y: 180, vx: 0, vy: 0, age: 0, life: 5 };
    s.benders.Water.free.push(drop);
    s.benders.Fire.free.push(ember);
    s.benders[element].free[0].vx = 400;
    s.benders[element].updateFree(0.05);
    assert.equal(s.benders.Water.free.length, 0);
    assert.equal(s.benders.Fire.free.length, 0);
    assert.ok(s.grid.includes(MAT.SMOKE));
    assert.ok(!s.grid.includes(MAT.FIRE));
    assert.ok(s.visualFx.some((fx) => fx[0] === 'smoke' && fx[4] === 'Water'));
  }
});

test('held water extinguishes an incoming fireball before it can hit a player or object', () => {
  const s = elementalScene();
  s.remotePlayers.other = { x: 200, y: 164 };
  const wood = { x: 203, y: 180, mat: MAT.WOOD, vx: 0, vy: 0 };
  s.debris.push(wood);
  for (let i = 0; i < 5; i++) s.benders.Water.held.push({ x: 193, y: 180, vx: 0, vy: 0 });
  s.benders.Fire.fireballs.push(fireball(180, 180, 25));
  s.benders.Fire.updateFireballs(0.08);
  assert.equal(s.benders.Fire.fireballs.length, 0);
  assert.equal(s.benders.Water.held.length, 0);
  assert.equal(s.hits.length, 0);
  assert.equal(s.debris[0], wood);
  assert.equal(wood.vx, 0);
  assert.ok(!s.grid.includes(MAT.FIRE));
});

test('a small amount of water evaporates and reduces fireball size and damage potential', () => {
  const s = elementalScene();
  const ball = fireball();
  s.benders.Fire.fireballs.push(ball);
  s.benders.Water.free.push({ x: 180, y: 180, vx: 0, vy: 0, age: 0 });
  s.benders.Fire.updateFireballs(0.01);
  assert.equal(s.benders.Water.free.length, 0);
  assert.equal(s.benders.Fire.fireballs[0], ball);
  assert.equal(ball.mass, 18);
  assert.ok(ball.size < 9 && ball.embers[0].radius < 5);
  assert.ok(s.grid.includes(MAT.SMOKE));
});

test('a fast Water Punch intercepts a fireball between flight steps', () => {
  const s = elementalScene();
  s.benders.Water.free.push({ x: 150, y: 180, vx: 720, vy: 0, punched: true, age: 0 });
  s.benders.Fire.fireballs.push(fireball(190, 180, 6));
  s.benders.Water.updateFree(0.1);
  s.benders.Fire.updateFireballs(0.01);
  assert.equal(s.benders.Water.free.length, 0);
  assert.equal(s.benders.Fire.fireballs.length, 0);
  assert.ok(!s.grid.includes(MAT.FIRE));
});

test('fire evaporates grid water into steam instead of silently disappearing', () => {
  const s = elementalScene();
  s.grid[s.idx(60, 60)] = MAT.WATER;
  s.benders.Fire.free.push({ x: 181.5, y: 181.5, vx: 0, vy: 0, age: 0 });
  s.benders.Fire.updateFree(0.01);
  assert.equal(s.benders.Fire.free.length, 0);
  assert.equal(s.grid[s.idx(60, 60)], MAT.SMOKE);
  assert.ok(s.visualFx.some((fx) => fx[0] === 'smoke' && fx[4] === 'Water'));
});

test('grid water douses fireballs and a nearby blast evaporates only a bounded amount', () => {
  const s = elementalScene();
  s.grid[s.idx(61, 60)] = MAT.WATER;
  s.benders.Fire.fireballs.push(fireball());
  s.benders.Fire.updateFireballs(0.05);
  assert.equal(s.benders.Fire.fireballs.length, 0);
  assert.equal(s.grid[s.idx(61, 60)], MAT.SMOKE);
  assert.ok(!s.grid.includes(MAT.FIRE));
  for (let x = 60; x < 68; x++) s.grid[s.idx(x, 60)] = MAT.WATER;
  s.benders.Fire.igniteBurst(181.5, 181.5, 8, 0.5, 2);
  let remaining = 0;
  for (let x = 60; x < 68; x++) remaining += s.grid[s.idx(x, 60)] === MAT.WATER;
  assert.equal(remaining, 6);
});

test('water cannot react with airborne fire through a solid wall', () => {
  const s = elementalScene();
  s.grid[s.idx(61, 60)] = MAT.BEDROCK;
  s.benders.Water.held.push({ x: 186, y: 181.5, vx: 0, vy: 0 });
  const ball = fireball(180, 181.5);
  s.benders.Fire.fireballs.push(ball);
  s.benders.Fire.updateFireballs(0.01);
  assert.equal(ball.mass, 24);
  assert.equal(s.benders.Water.held.length, 1);
  assert.equal(s.grid[s.idx(61, 60)], MAT.BEDROCK);
});

test('air carries existing bent embers, water and fireballs without duplicating particles', () => {
  const s = elementalScene();
  const ember = { x: 180, y: 180, vx: 0, vy: 0, life: 2 };
  const drop = { x: 185, y: 180, vx: 0, vy: 0 };
  const ball = fireball(190);
  s.benders.Fire.held.push(ember);
  s.benders.Water.held.push(drop);
  s.benders.Fire.fireballs.push(ball);
  s.benders.Air.gust(170, 180, 50, 180, { x: 1, y: 0 });
  assert.equal(s.benders.Fire.held.length, 0);
  assert.equal(s.benders.Fire.free.length, 1);
  assert.equal(s.benders.Fire.free[0], ember);
  assert.ok(ember.vx > 0 && drop.vx > 0 && ball.vx > 440);
  assert.equal(s.benders.Water.held.length, 1);
  assert.equal(ball.mass, 24);
});

test('wind moves a grid flame once per gust and feeds a downwind fuel surface', () => {
  const s = elementalScene();
  s.grid[s.idx(65, 60)] = MAT.FIRE;
  s.life[s.idx(65, 60)] = 30;
  s.benders.Air.blowGas(170, 181.5, 60, { x: 1, y: 0 }, 180);
  assert.equal(s.grid[s.idx(65, 60)], MAT.EMPTY);
  assert.equal(s.grid[s.idx(66, 60)], MAT.FIRE);
  assert.equal(s.life[s.idx(66, 60)], 30);
  assert.equal(s.grid[s.idx(67, 60)], MAT.EMPTY);
  s.grid[s.idx(67, 60)] = MAT.WOOD;
  s.benders.Air.blowGas(170, 181.5, 60, { x: 1, y: 0 }, 180);
  s.time.now += 3000;
  s.bendingDamage.update(3);
  assert.equal(s.grid[s.idx(67, 60)], MAT.FIRE);
});

test('wind-driven grid fire turns water into steam instead of passing through it', () => {
  const s = elementalScene();
  s.grid[s.idx(65, 60)] = MAT.FIRE;
  s.grid[s.idx(66, 60)] = MAT.WATER;
  s.benders.Air.blowGas(170, 181.5, 60, { x: 1, y: 0 }, 180);
  assert.equal(s.grid[s.idx(65, 60)], MAT.SMOKE);
  assert.equal(s.grid[s.idx(66, 60)], MAT.SMOKE);
  assert.ok(!s.grid.includes(MAT.FIRE));
});

test('held earth intercepts a fireball and protects bodies and objects behind its shape', () => {
  const s = elementalScene();
  s.benders.Earth.rock = earthShield();
  s.remotePlayers.other = { x: 224, y: 164 };
  const wood = { x: 226, y: 180, mat: MAT.WOOD, vx: 0, vy: 0 };
  s.debris.push(wood);
  s.benders.Fire.fireballs.push(fireball(180, 180, 25));
  s.benders.Fire.updateFireballs(0.12);
  assert.equal(s.benders.Fire.fireballs.length, 0);
  assert.equal(s.benders.Earth.rock.cells.length, 7);
  assert.equal(s.hits.length, 0);
  assert.equal(s.debris[0], wood);
  assert.equal(wood.vx, 0);
  assert.equal(wood.bendBurning, undefined);
});

test('earth redirects fast water and air attacks while conserving their particles', () => {
  for (const element of ['Water', 'Air']) {
    const s = elementalScene();
    s.benders.Earth.rock = earthShield();
    const drop = { x: 180, y: 180, vx: 720, vy: 0, age: 0 };
    s.benders[element].free.push(drop);
    s.benders[element].updateFree(0.08);
    assert.equal(s.benders[element].free.length, 1);
    assert.ok(drop.x < 210 && drop.vx < 0);
  }
});

test('moving earth intercepts stationary embers and fireballs and pushes water aside', () => {
  const s = elementalScene();
  const rock = earthShield(170);
  rock.vx = 200;
  s.benders.Earth.thrown.push(rock);
  const drop = { x: 200, y: 180, vx: 0, vy: 0 };
  s.benders.Water.held.push(drop);
  s.benders.Fire.held.push({ x: 204, y: 180, vx: 0, vy: 0, life: 5 });
  const ball = fireball(220);
  s.benders.Fire.fireballs.push(ball);
  s.benders.Earth.moveRock(rock, 0.2, 'thrown');
  assert.ok(drop.vx > 0);
  assert.equal(s.benders.Water.held.length, 1);
  assert.equal(s.benders.Fire.held.length, 0);
  assert.equal(ball.earthBlocked, true);
  s.benders.Fire.updateFireballs(0.01);
  assert.equal(s.benders.Fire.fireballs.length, 0);
});

test('earth blocks wind and embers while real gaps in its shape remain open', () => {
  const s = elementalScene();
  const rock = earthShield(200);
  s.benders.Earth.rock = rock;
  const ember = { x: 215, y: 180, vx: 0, vy: 0, life: 5 };
  s.benders.Fire.held.push(ember);
  s.remotePlayers.other = { x: 215, y: 164 };
  s.benders.Air.gust(180, 180, 60, 180, { x: 1, y: 0 });
  assert.equal(ember.vx, 0);
  assert.equal(s.hits.length, 0);
  assert.ok(rock.vx > 0);
  s.benders.Fire.free.push({ x: 180, y: 180, vx: 440, vy: 0, age: 0 });
  s.benders.Fire.updateFree(0.08);
  assert.equal(s.benders.Fire.free.length, 0);
  rock.vx = 0;
  rock.cells = [{ ox: 0, oy: -5 }, { ox: 0, oy: 5 }];
  s.remotePlayers = {};
  s.benders.Fire.fireballs.push(fireball());
  s.benders.Fire.updateFireballs(0.08);
  assert.equal(s.benders.Fire.fireballs.length, 1);
  assert.ok(s.benders.Fire.fireballs[0].x > 200);
});

test('an Earth orbit intercepts attacks at its rotated position after earlier collision checks', () => {
  const s = elementalScene();
  s.player.x = 200; s.player.y = 164;
  s.bodiesInRadius = () => [];
  const rock = { x: 210, y: 180, vx: 0, vy: 0, cells: [{ ox: 8, oy: 0 }] };
  s.benders.Earth.rock = rock;
  s.benders.Water.moveDrop({ x: 234, y: 180, vx: 0, vy: 0 }, 0);
  s.benders.Earth.steerOrbitRock(Math.PI / (2 * 3.2));
  s.benders.Fire.free.push({ x: 180, y: 200, vx: 440, vy: 0, age: 0 });
  s.benders.Fire.updateFree(0.12);
  assert.equal(s.benders.Fire.free.length, 0);
});

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

test('opening the Q wheel releases held bending while free matter keeps moving', () => {
  const s = scene();
  s.leftClickMode = 'bend';
  s.bendElement = 'Water';
  s.bendWheelOpen = true;
  const bend = new WaterBending(s);
  bend.begin();
  bend.held.push({ x: 70, y: 36, vx: 100, vy: 0 });
  bend.update(0.016);
  assert.equal(bend.active, false);
  assert.equal(bend.held.length, 0);
  assert.equal(bend.free.length, 1);
  assert.ok(bend.free[0].x > 70);
});

test('Water Bolt Punch uses held drops as a pushing, dousing jet', () => {
  const s = scene();
  s.input.activePointer = { worldX: 200, worldY: 36 };
  s.remotePlayers.other = { x: 100, y: 20 };
  s.grid[s.idx(28, 12)] = MAT.FIRE;
  const bend = new WaterBending(s);
  bend.held.push({ x: 70, y: 36, vx: 0, vy: 0 });
  bend.held.push({ x: 70, y: 39, vx: 0, vy: 0 });
  assert.equal(bend.punch(), true);
  assert.equal(bend.held.length, 0);
  assert.equal(bend.free.length, 2);
  bend.updateFree(0.04);
  bend.touchBodies();
  assert.equal(s.grid[s.idx(28, 12)], MAT.SMOKE);
  assert.equal(s.hits[0][4].wetMs, 650);
  assert.ok(s.hits[0][4].ix > 0);
  assert.equal(s.selfHits.length, 0);
});

test('Water Orbit Punch expands held drops and drenches nearby bodies', () => {
  const s = scene();
  s.remotePlayers.other = { x: 65, y: 20 };
  s.debris.push({ x: 52, y: 36, vx: 0, vy: 0 });
  const bend = new WaterBending(s);
  bend.form = 'Orbit';
  for (let i = 0; i < 8; i++) {
    const a = i * Math.PI / 4;
    bend.held.push({ x: 30 + Math.cos(a) * 20, y: 36 + Math.sin(a) * 20,
      vx: 0, vy: 0 });
  }
  assert.equal(bend.punch(), true);
  assert.equal(bend.free.length, 8);
  assert.ok(bend.free.every((d) => (d.x - 30) * d.vx + (d.y - 36) * d.vy > 0));
  assert.equal(s.hits[0][4].wetMs, 650);
  assert.ok(s.debris[0].vx > 0);
  assert.equal(s.selfHits.length, 0);
});

test('Water Orbit Punch does not drench through a solid wall', () => {
  const s = scene();
  s.remotePlayers.other = { x: 65, y: 20 };
  s.grid[s.idx(15, 12)] = MAT.STONE;
  const bend = new WaterBending(s);
  bend.form = 'Orbit';
  bend.held.push({ x: 30, y: 36, vx: 0, vy: 0 });
  bend.punch();
  assert.equal(s.hits.length, 0);
});

test('fire ignites fuel and burns touched bodies', () => {
  const s = scene();
  const bend = new FireBending(s);
  const wood = s.idx(41, 40);
  s.grid[wood] = MAT.WOOD;
  const ember = { x: 40 * PIXEL + 1, y: 40 * PIXEL + 1, vx: 180, vy: 0 };
  assert.equal(bend.moveDrop(ember, 0.02), 'consumed');
  assert.equal(s.grid[wood], MAT.WOOD);
  assert.ok(bend.surfaceDamage.cells.get(wood).burn > 0);
  bend.held.push({ x: 105, y: 105 }, { x: 145, y: 105 });
  bend.touchBodies();
  assert.equal(s.hits[0][4].burnMs, 1200);
  assert.equal(s.damage[0][2], 'Fire');
  assert.equal(s.enemies.list[0].burnUntil, 2200);
  s.debris.push({ x: 105, y: 105, mat: MAT.WOOD });
  bend.touchObjects();
  assert.equal(s.debris.length, 1);
  assert.equal(s.debris[0].bendBurning, true);
  s.time.now += 3000;
  bend.surfaceDamage.update(3);
  assert.equal(s.grid[wood], MAT.FIRE);
  assert.equal(s.debris.length, 0);
  assert.equal(s.grid[s.idx(35, 35)], MAT.FIRE);
});

test('weak surface hits erode less than Earth and Air is weaker than Water', () => {
  const hitsToBreak = (type) => {
    const s = scene();
    const bend = type === 'Water' ? new WaterBending(s) : new AirBending(s);
    const id = s.idx(81, 80);
    s.grid[id] = MAT.BRICK;
    let hits = 0;
    while (s.grid[id] === MAT.BRICK && hits < 100) {
      s.time.now += 100;
      bend.moveDrop({ x: 80 * PIXEL + 2, y: 80 * PIXEL + 1, vx: 400, vy: 0 }, 0.01);
      hits++;
    }
    assert.equal(s.grid[id], MAT.EMPTY);
    return hits;
  };
  const s = scene();
  const earth = new EarthBending(s);
  s.grid[s.idx(81, 80)] = MAT.BRICK;
  earth.rockCollides({ x: 80 * PIXEL + 2, y: 80 * PIXEL + 1, vx: 400, vy: 0,
    cells: Array.from({ length: 4 }, () => ({ ox: 0, oy: 0 })) }, 2, 0, 'thrown');
  assert.equal(s.grid[s.idx(81, 80)], MAT.EMPTY);
  const waterHits = hitsToBreak('Water');
  const airHits = hitsToBreak('Air');
  assert.ok(waterHits > 1);
  assert.ok(airHits > waterHits);
});

test('Water impacts gradually damage loose objects while pushing them', () => {
  const s = scene();
  const water = new WaterBending(s);
  const glass = { x: 105, y: 105, vx: 0, vy: 0, mat: MAT.GLASS };
  s.debris.push(glass);
  water.free.push({ x: 105, y: 105, vx: 400, vy: 0, punched: true });
  water.pushObjects(0.016);
  assert.equal(s.debris.length, 1);
  assert.ok(glass.vx > 0);
  s.time.now += 160;
  water.pushObjects(0.016);
  assert.equal(s.debris.length, 0);
});

test('Fire heats masonry slowly and eventually burns through it', () => {
  const s = scene();
  const fire = new FireBending(s);
  const id = s.idx(80, 80);
  s.grid[id] = MAT.BRICK;
  fire.igniteCell(80, 80, 0.16);
  assert.equal(s.grid[id], MAT.BRICK);
  for (let i = 0; i < 100 && s.grid[id] === MAT.BRICK; i++) {
    s.time.now += 100;
    fire.igniteCell(80, 80, 0.16);
    fire.surfaceDamage.update(0.1);
  }
  assert.equal(s.grid[id], MAT.EMPTY);
  assert.ok(s.debris.some((d) => d.mat === MAT.BRICK && d.bendCasterSafe));
});

test('Fire keeps a contacted object burning after the caster stops', () => {
  const s = scene();
  const fire = new FireBending(s);
  const wood = { x: 105, y: 105, vx: 0, vy: 0, mat: MAT.WOOD };
  s.debris.push(wood);
  fire.burnDebris(105, 105, 10);
  assert.equal(s.debris.length, 1);
  assert.equal(wood.bendBurning, true);
  for (let i = 0; i < 30; i++) {
    s.time.now += 100;
    fire.update(0.1);
  }
  assert.equal(s.debris.length, 0);
  assert.equal(s.grid[s.idx(35, 35)], MAT.FIRE);
});

test('Water contact quenches burning debris and standing water quenches burning terrain', () => {
  const s = scene();
  const fire = new FireBending(s);
  const water = new WaterBending(s);
  assert.equal(fire.surfaceDamage, water.surfaceDamage);
  const wood = { x: 105, y: 105, vx: 0, vy: 0, mat: MAT.WOOD };
  s.debris.push(wood);
  fire.burnDebris(105, 105, 10);
  s.grid[s.idx(80, 80)] = MAT.WOOD;
  fire.igniteCell(80, 80);
  fire.surfaceDamage.update(0.5);
  water.held.push({ x: 105, y: 105, vx: 0, vy: 0 });
  water.pushObjects(0.016);
  s.grid[s.idx(79, 80)] = MAT.WATER;
  s.time.now += 3000;
  fire.surfaceDamage.update(3);
  assert.equal(s.debris.includes(wood), true);
  assert.equal(wood.bendBurning, false);
  assert.equal(s.grid[s.idx(80, 80)], MAT.WOOD);
});

test('Fire cannot maintain a burn on material cooled by nearby water', () => {
  const s = scene();
  const fire = new FireBending(s);
  s.grid[s.idx(80, 80)] = MAT.WOOD;
  s.grid[s.idx(79, 80)] = MAT.WATER;
  for (let i = 0; i < 50; i++) {
    s.time.now += 100;
    fire.igniteCell(80, 80);
    fire.surfaceDamage.update(0.1);
  }
  assert.equal(s.grid[s.idx(80, 80)], MAT.WOOD);
  assert.equal(fire.surfaceDamage.cells.get(s.idx(80, 80)).burn, 0);
});

test('a burning object retains its wear when it settles back into terrain', () => {
  const s = scene();
  const fire = new FireBending(s);
  const wood = { x: 105, y: 105, mat: MAT.WOOD, variant: 2 };
  s.debris.push(wood);
  fire.burnDebris(105, 105, 10);
  fire.surfaceDamage.update(0.5);
  s.setCell(s.idx(35, 35), MAT.WOOD, 2);
  fire.surfaceDamage.settleObject(wood, 35, 35);
  s.debris.length = 0;
  s.time.now += 3000;
  fire.surfaceDamage.update(3);
  assert.equal(s.grid[s.idx(35, 35)], MAT.FIRE);
});

test('Air pushes bent rocks and loose pieces, with heavier rocks resisting more', () => {
  const s = scene();
  const earth = new EarthBending(s);
  const air = new AirBending(s);
  const light = { x: 100, y: 100, vx: 0, vy: 0, cells: [{ ox: 0, oy: 0 }] };
  const heavy = { x: 100, y: 100, vx: 0, vy: 0,
    cells: Array.from({ length: 16 }, () => ({ ox: 0, oy: 0 })) };
  earth.thrown.push(light, heavy);
  earth.loosePieces.push({ x: 100, y: 100, vx: 0, vy: 0, mat: MAT.STONE, age: 0 });
  s.benders = { Earth: earth };
  air.gust(80, 100, 50, 100, { x: 1, y: 0 });
  assert.ok(light.vx > heavy.vx && heavy.vx > 0);
  assert.ok(earth.loosePieces[0].vx > 0);
  earth.updateLoose(0.02);
  assert.ok(earth.loosePieces[0].x > 100);
});

test('Air lightly damages objects and cannot push rocks through a wall', () => {
  const s = scene();
  const air = new AirBending(s);
  const wood = { x: 100, y: 100, vx: 0, vy: 0, mat: MAT.WOOD };
  s.debris.push(wood);
  air.gust(80, 100, 50, 100, { x: 1, y: 0 });
  assert.ok(wood.vx > 0);
  assert.equal(s.debris.length, 1);
  assert.ok(air.surfaceDamage.objects.get(wood).damage > 0);
  const rock = { x: 100, y: 100, vx: 0, vy: 0, cells: [{ ox: 0, oy: 0 }] };
  s.benders = { Earth: { rock, thrown: [], loosePieces: [] } };
  s.grid[s.idx(30, 33)] = MAT.STONE;
  air.gust(80, 100, 50, 100, { x: 1, y: 0 });
  assert.equal(rock.vx, 0);
});

test('Air deflects a held Earth orbit while its tether pulls it toward the caster', () => {
  const s = scene();
  const earth = new EarthBending(s);
  const air = new AirBending(s);
  s.bodiesInRadius = () => [];
  s.benders = { Earth: earth };
  earth.form = 'Orbit';
  earth.rock = { x: 30, y: 36, vx: 0, vy: 0, cells: [{ ox: 0, oy: 0 }] };
  air.gust(20, 36, 50, 100, { x: 1, y: 0 });
  earth.steerOrbitRock(0.02);
  assert.ok(earth.rock.x > s.player.x + s.player.w / 2);
  for (let i = 0; i < 100; i++) earth.steerOrbitRock(0.02);
  assert.ok(Math.abs(earth.rock.x - 30) < 0.02);
});

test('weaker elements respect bedrock and bound accumulated surface wear', () => {
  const s = scene();
  const water = new WaterBending(s);
  const fire = new FireBending(s);
  const air = new AirBending(s);
  s.grid[s.idx(80, 80)] = MAT.BEDROCK;
  water.erodeSurface({ vx: 720, vy: 0 }, 80 * PIXEL, 80 * PIXEL);
  fire.igniteCell(80, 80, 1000);
  air.erodeSurface({ vx: 790, vy: 0 }, 80 * PIXEL, 80 * PIXEL);
  assert.equal(s.grid[s.idx(80, 80)], MAT.BEDROCK);
  for (let i = 0; i < 1100; i++) {
    const gx = 100 + i % 100, gy = 100 + Math.floor(i / 100);
    s.grid[s.idx(gx, gy)] = MAT.STONE;
    fire.igniteCell(gx, gy, 0.08);
  }
  assert.ok(fire.surfaceDamage.cells.size <= 1024);
  fire.surfaceDamage.clear();
  assert.equal(fire.surfaceDamage.cells.size, 0);
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
  const glassObject = { x: 105, y: 105, mat: MAT.GLASS, vx: 0, vy: 0 };
  s.debris.push(glassObject);
  bend.strikeBodies(rock);
  assert.equal(s.debris.includes(glassObject), false);
  assert.equal(s.hits[0][1], 'Earth');
  assert.ok(s.hits[0][2] > 0);
  rock.x = 145;
  bend.strikeBodies(rock);
  assert.equal(s.damage[0][2], 'Earth');
});

test('Earth Bolt Punch drives the gathered rock through light terrain into a player', () => {
  const s = scene();
  s.input.activePointer = { worldX: 200, worldY: 36 };
  s.remotePlayers.other = { x: 100, y: 20 };
  s.grid[s.idx(30, 12)] = MAT.GLASS;
  const bend = new EarthBending(s);
  bend.rock = { x: 70, y: 36, vx: 0, vy: 0, nextSlot: 1,
    cells: [{ ox: 0, oy: 0, shade: 0 }] };
  assert.equal(bend.punch(), true);
  assert.equal(bend.thrown.length, 1);
  assert.equal(bend.rock, null);
  bend.updateThrown(0.05);
  assert.equal(s.grid[s.idx(30, 12)], MAT.EMPTY);
  assert.equal(s.hits[0][1], 'Earth');
  assert.ok(s.hits[0][2] > 0);
  assert.equal(s.selfHits.length, 0);
});

test('Earth Orbit Punch sends conserved stone fragments outward', () => {
  const s = scene();
  s.remotePlayers.other = { x: 65, y: 20 };
  const bend = new EarthBending(s);
  bend.form = 'Orbit';
  bend.rock = { x: 30, y: 36, vx: 0, vy: 0, nextSlot: 4, cells: [
    { ox: 5, oy: 0, shade: 0 }, { ox: -5, oy: 0, shade: 0 },
    { ox: 0, oy: 5, shade: 0 }, { ox: 0, oy: -5, shade: 0 },
  ] };
  assert.equal(bend.punch(), true);
  assert.equal(bend.thrown.length, 4);
  assert.ok(bend.thrown.every((r) => r.fragment && r.cells.length === 1));
  assert.ok(bend.thrown.some((r) => r.vx > 0));
  assert.ok(bend.thrown.some((r) => r.vx < 0));
  bend.updateThrown(0.08);
  assert.equal(s.hits[0][1], 'Earth');
  assert.equal(s.selfHits.length, 0);
});

function fracturePatch(mat, mass, speed) {
  const s = scene();
  for (let y = 60; y <= 100; y++) {
    for (let x = 80; x <= 110; x++) {
      const id = s.idx(x, y);
      s.grid[id] = mat;
      s.life[id] = 3;
    }
  }
  const bend = new EarthBending(s);
  const rock = { x: 79 * PIXEL + 1, y: 80 * PIXEL + 1, vx: speed, vy: 0,
    cells: Array.from({ length: mass }, () => ({ ox: 0, oy: 0, shade: 0 })) };
  const broken = bend.crumbleTerrain(rock, [{ x: 80, y: 80 }]);
  return { s, bend, rock, broken };
}

test('Earth crater damage increases with rock mass and speed', () => {
  const small = fracturePatch(MAT.DIRT, 4, 200);
  const large = fracturePatch(MAT.DIRT, 64, 200);
  const slow = fracturePatch(MAT.DIRT, 16, 200);
  const fast = fracturePatch(MAT.DIRT, 16, 400);
  assert.ok(large.broken > small.broken);
  assert.ok(fast.broken > slow.broken);
  assert.ok(fast.rock.vx < 400);
  assert.equal(fast.rock.cells.length, 16);
});

test('Earth contact feedback scales with mass and speed, including unbroken bedrock', () => {
  const small = fracturePatch(MAT.DIRT, 4, 200);
  const large = fracturePatch(MAT.DIRT, 64, 400);
  const bedrock = fracturePatch(MAT.BEDROCK, 64, 400);
  const hit = (result) => result.s.visualFx.find(([name]) => name === 'impact');
  assert.ok(hit(large)[4].strength > hit(small)[4].strength);
  assert.equal(bedrock.broken, 0);
  assert.equal(hit(bedrock)[3], 'Earth');
  assert.equal(hit(bedrock)[1], 80 * PIXEL + PIXEL / 2);
  assert.ok(hit(bedrock)[4].vx > 0);
});

test('confirmed elemental body contacts produce feedback, while misses and recalled particles do not', () => {
  for (const [element, Bender] of [['Water', WaterBending], ['Fire', FireBending]]) {
    const s = scene(), bender = new Bender(s);
    bender.held.push({ x: 25, y: 25, vx: 500, vy: 0 });
    bender.free.push({ x: 105, y: 110, vx: 500, vy: 0, bendRecalling: true });
    bender.touchBodies();
    assert.equal(s.visualFx.filter(([name]) => name === 'impact').length, 0);
    bender.free[0].bendRecalling = false;
    bender.touchBodies();
    const hits = s.visualFx.filter(([name]) => name === 'impact');
    assert.equal(hits.length, 1);
    assert.equal(hits[0][3], element);
    assert.equal(hits[0][4].kind, 'body');
    assert.ok(hits[0][4].vx > 0);
    bender.touchBodies();
    assert.equal(s.visualFx.filter(([name]) => name === 'impact').length, 1);
  }
});

test('Earth impacts crumble ground and masonry according to their resistance', () => {
  const dirt = fracturePatch(MAT.DIRT, 64, 400);
  const brick = fracturePatch(MAT.BRICK, 64, 400);
  const stone = fracturePatch(MAT.STONE, 64, 400);
  assert.ok(dirt.broken > brick.broken);
  assert.ok(brick.broken > stone.broken);
  assert.ok(stone.broken > 0);
  assert.ok(brick.s.debris.length > 0 && brick.s.debris.length <= 20);
  assert.ok(brick.s.debris.every((d) => d.mat === MAT.BRICK && d.variant === 3));
  assert.equal(brick.s.cellWrites.length, brick.broken);
  assert.ok(brick.s.cellWrites.every(([id, mat]) => mat === MAT.EMPTY
    && brick.s.grid[id] === MAT.EMPTY));
  assert.equal(brick.s.collapseTimer, 30);
  assert.ok(brick.s.visualFx.some((fx) => fx[0] === 'smoke'));
});

test('Earth moving-rock collisions carve a crater and leave moving rubble', () => {
  const { s, bend } = fracturePatch(MAT.WOOD, 1, 0);
  const rock = { x: 78 * PIXEL + 1.5, y: 80 * PIXEL + 1.5, vx: 550, vy: 0,
    cells: bend.slots.slice(0, 16).map(([ox, oy]) => ({ ox, oy, shade: 0 })) };
  bend.moveRock(rock, 0.033, 'thrown');
  assert.ok(s.cellWrites.length > 0);
  assert.ok(s.debris.some((d) => d.vx > 0));
  assert.ok(s.debris.some((d) => d.earthImpactSource === rock));
  assert.ok(rock.vx < 550);
});

test('a downward Earth impact crumbles soil instead of merely landing on it', () => {
  const s = scene();
  for (let y = 84; y <= 108; y++) {
    for (let x = 60; x <= 100; x++) s.grid[s.idx(x, y)] = MAT.DIRT;
  }
  const bend = new EarthBending(s);
  const rock = { x: 80 * PIXEL + 1.5, y: 80 * PIXEL + 1.5, vx: 0, vy: 550,
    cells: bend.slots.slice(0, 16).map(([ox, oy]) => ({ ox, oy, shade: 0 })) };
  bend.moveRock(rock, 0.033, 'thrown');
  assert.ok(s.cellWrites.length > 0);
  assert.ok(s.cellWrites.every(([id]) => Math.floor(id / COLS) >= 84));
  assert.ok(rock.vy < 550);
});

test('Earth Orbit can fracture a structure at its rotating contact speed', () => {
  const s = scene();
  s.bodiesInRadius = () => [];
  s.grid[s.idx(19, 15)] = MAT.WOOD;
  const bend = new EarthBending(s);
  bend.form = 'Orbit';
  bend.rock = { x: 30, y: 36, vx: 0, vy: 0, cells: Array.from({ length: 16 }, (_, i) => {
    const angle = i * Math.PI * 2 / 16;
    return { ox: Math.cos(angle) * 10, oy: Math.sin(angle) * 10, shade: 0 };
  }) };
  bend.steerOrbitRock(0.1);
  assert.equal(s.grid[s.idx(19, 15)], MAT.EMPTY);
  assert.ok(s.debris.length > 0);
  assert.equal(s.selfHits.length, 0);
});

test('Earth cannot crumble bedrock or excavate with a resting rock', () => {
  const bedrock = fracturePatch(MAT.BEDROCK, 160, 1000);
  assert.equal(bedrock.broken, 0);
  assert.equal(bedrock.s.cellWrites.length, 0);
  const slow = fracturePatch(MAT.WOOD, 160, 10);
  assert.equal(slow.broken, 0);
  const rock = { x: 79 * PIXEL + 1.5, y: 80 * PIXEL + 1.5, vx: 10, vy: 0,
    cells: [{ ox: 0, oy: 0 }] };
  assert.equal(slow.bend.rockCollides(rock, PIXEL, 0, 'thrown'), true);
});

test('a bedrock barrier stops an Earth rock without damaging terrain behind it', () => {
  const s = scene();
  const bend = new EarthBending(s);
  const rock = { x: 79 * PIXEL + 1, y: 80 * PIXEL + 1, vx: 700, vy: 0,
    cells: Array.from({ length: 64 }, () => ({ ox: 0, oy: 0 })) };
  s.grid[s.idx(80, 80)] = MAT.BEDROCK;
  s.grid[s.idx(81, 80)] = MAT.DIRT;
  assert.equal(bend.rockCollides(rock, PIXEL, 0, 'thrown'), true);
  assert.equal(s.grid[s.idx(80, 80)], MAT.BEDROCK);
  assert.equal(s.grid[s.idx(81, 80)], MAT.DIRT);
  assert.equal(s.cellWrites.length, 0);
});

test('Earth fractures begin at a real contact when touched surfaces are separated', () => {
  const s = scene();
  s.grid[s.idx(80, 80)] = MAT.WOOD;
  s.grid[s.idx(100, 80)] = MAT.WOOD;
  const bend = new EarthBending(s);
  const broken = bend.crumbleTerrain({ x: 79 * PIXEL, y: 80 * PIXEL, vx: 400, vy: 0,
    cells: Array.from({ length: 8 }, () => ({ ox: 0, oy: 0 })) },
  [{ x: 80, y: 80 }, { x: 100, y: 80 }]);
  assert.ok(broken > 0);
});

test('Earth loose-object damage depends on mass and speed', () => {
  const crush = (mass, speed, mat = MAT.WOOD) => {
    const s = scene();
    const bend = new EarthBending(s);
    const obj = { x: 105, y: 105, mat, vx: 0, vy: 0 };
    s.debris.push(obj);
    const rock = { x: 105, y: 105, vx: speed, vy: 0,
      cells: Array.from({ length: mass }, () => ({ ox: 0, oy: 0 })) };
    bend.strikeObjects(rock, [{ x: 105, y: 105 }], speed);
    return { s, obj };
  };
  const weak = crush(1, 150);
  assert.equal(weak.s.debris.length, 1);
  assert.ok(weak.obj.vx > 0);
  assert.equal(crush(8, 150).s.debris.length, 0);
  assert.equal(crush(1, 350).s.debris.length, 0);
  assert.equal(crush(160, 1000, MAT.BEDROCK).s.debris.length, 1);
});

test('Earth fracture work stays bounded during a very large impact', () => {
  const { broken, s } = fracturePatch(MAT.DIRT, 160, 5000);
  assert.ok(broken > 100 && broken <= 300);
  assert.ok(s.debris.length <= 20);
});

test('crumbling a house support makes the remaining structure collapse', () => {
  const s = scene();
  const world = new PixelWorld.World();
  s.grid = world.grid;
  s.life = world.life;
  s.setCell = (id, mat, life) => world.setCell(id, mat, life);
  for (let y = 82; y < ROWS - 1; y++) world.setCell(s.idx(80, y), MAT.STONE);
  world.setCell(s.idx(80, ROWS - 1), MAT.BEDROCK);
  world.setCell(s.idx(80, 81), MAT.WOOD);
  for (let x = 78; x <= 82; x++) world.setCell(s.idx(x, 80), MAT.BRICK);
  world.checkStructuralSupport();
  assert.equal(world.falling[s.idx(78, 80)], 0);
  const bend = new EarthBending(s);
  bend.crumbleTerrain({ x: 79 * PIXEL, y: 81 * PIXEL, vx: 400, vy: 0,
    cells: [{ ox: 0, oy: 0 }] }, [{ x: 80, y: 81 }]);
  assert.equal(world.grid[s.idx(80, 81)], MAT.EMPTY);
  world.checkStructuralSupport();
  assert.equal(world.grid[s.idx(78, 80)], MAT.BRICK);
  assert.equal(world.falling[s.idx(78, 80)], 1);
});

test('air preserves enemy push and relays player push', () => {
  const s = scene();
  const bend = new AirBending(s);
  bend.gust(120, 112, 50, 100);
  assert.ok(s.enemies.list[0].impulseX > 0);
  assert.equal(s.hits[0][1], 'Air');
  assert.ok(s.hits[0][4].ix < 0);
});

test('Air Bolt Punch pushes players and loose objects forward', () => {
  const s = scene();
  s.input.activePointer = { worldX: 200, worldY: 36 };
  s.remotePlayers.other = { x: 95, y: 20 };
  s.debris.push({ x: 92, y: 36, vx: 0, vy: 0 });
  s.projectiles.push({ x: 92, y: 36, vx: 0, vy: 0 });
  const bend = new AirBending(s);
  for (let i = 0; i < 18; i++) bend.held.push({ x: 70, y: 36, vx: 0, vy: 0, life: 5 });
  assert.equal(bend.punch(), true);
  bend.update(0.03);
  assert.ok(s.hits[0][4].ix > 0);
  assert.ok(s.debris[0].vx > 0);
  assert.ok(s.projectiles[0].vx > 0);
});

test('Air Orbit Punch expands as a ring and pushes the caster and distant targets', () => {
  const s = scene();
  s.remotePlayers.other = { x: 105, y: 20 };
  const bend = new AirBending(s);
  bend.form = 'Orbit';
  bend.held.push({ x: 30, y: 36, vx: 0, vy: 0, life: 5 });
  assert.equal(bend.punch(), true);
  assert.equal(bend.held.length, 0);
  assert.ok(s.selfHits.length > 0);
  bend.updateRings(0.12);
  assert.equal(s.hits[0][1], 'Air');
  assert.ok(s.hits[0][4].ix > 0);
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

test('Bolt Punch turns held embers into a fireball that blasts objects on impact and ignites', () => {
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

test('fireball explosions chip brick immediately, throw rubble, and leave a bounded crater', () => {
  const s = scene();
  for (let y = 35; y <= 45; y++) {
    for (let x = 40; x <= 45; x++) s.grid[s.idx(x, y)] = MAT.BRICK;
  }
  const fire = new FireBending(s);
  fire.impactFireball({ x: 121.5, y: 121.5, vx: 440, vy: 0, size: 9, mass: 25 });
  assert.equal(s.grid[s.idx(40, 40)], MAT.FIRE);
  assert.equal(s.grid[s.idx(41, 40)], MAT.BRICK);
  assert.equal(s.grid[s.idx(45, 40)], MAT.BRICK);
  assert.ok(s.debris.some((obj) => obj.mat === MAT.BRICK && Math.hypot(obj.vx, obj.vy) > 0));
  assert.ok(s.debris.every((obj) => obj.bendCasterSafe));
  assert.equal(s.collapseTimer, 30);
  assert.equal(s.selfHits.length, 0);
});

test('larger fireballs break tougher ground while small fireballs only weaken it', () => {
  const impact = (mass) => {
    const s = scene();
    s.grid[s.idx(40, 40)] = MAT.STONE;
    const fire = new FireBending(s);
    fire.impactFireball({ x: 121.5, y: 121.5, vx: 440, vy: 0, size: 10, mass });
    return s;
  };
  assert.equal(impact(1).grid[40 + 40 * COLS], MAT.STONE);
  assert.equal(impact(100).grid[40 + 40 * COLS], MAT.FIRE);
});

test('fireball blasts weaken and push surviving objects, which keep burning, with distance falloff', () => {
  const s = scene();
  const near = { x: 127.5, y: 121.5, mat: MAT.STONE, vx: 0, vy: 0 };
  const edge = { x: 145.5, y: 121.5, mat: MAT.WOOD, vx: 0, vy: 0 };
  const outside = { x: 181.5, y: 121.5, mat: MAT.WOOD, vx: 0, vy: 0 };
  s.debris.push(near, edge, outside);
  const fire = new FireBending(s);
  fire.impactFireball({ x: 121.5, y: 121.5, vx: 440, vy: 0, size: 9, mass: 25 });
  assert.ok(s.debris.includes(near) && near.vx > edge.vx && edge.vx > 0);
  assert.ok(near.vy < 0 && edge.bendBurning);
  assert.equal(outside.vx, 0);
  assert.equal(outside.bendBurning, undefined);
  s.time.now += 3000;
  fire.surfaceDamage.update(3);
  assert.ok(!s.debris.includes(edge));
  assert.ok(s.debris.includes(near) && s.debris.includes(outside));
});

test('bedrock absorbs fireball blast damage and shields loose objects behind it', () => {
  const s = scene();
  for (let y = 25; y < 55; y++) s.grid[s.idx(41, y)] = MAT.BEDROCK;
  const shielded = { x: 130.5, y: 121.5, mat: MAT.WOOD, vx: 0, vy: 0 };
  s.debris.push(shielded);
  const fire = new FireBending(s);
  fire.impactFireball({ x: 121.5, y: 121.5, vx: 440, vy: 0, size: 14, mass: 120 });
  assert.equal(s.grid[s.idx(41, 40)], MAT.BEDROCK);
  assert.ok(s.debris.includes(shielded));
  assert.equal(shielded.vx, 0);
  assert.equal(shielded.bendBurning, undefined);
});

test('doused fireballs create steam effects without blast damage or impulse', () => {
  const s = scene();
  s.grid[s.idx(40, 40)] = MAT.WOOD;
  const obj = { x: 123, y: 121.5, mat: MAT.WOOD, vx: 0, vy: 0 };
  s.debris.push(obj);
  const fire = new FireBending(s);
  fire.impactFireball({ x: 121.5, y: 121.5, vx: 440, vy: 0, size: 14, mass: 120 }, true);
  assert.equal(s.grid[s.idx(40, 40)], MAT.WOOD);
  assert.equal(s.debris[0], obj);
  assert.equal(obj.vx, 0);
  assert.equal(s.cellWrites.length, 0);
  assert.equal(s.hits.length, 0);
  assert.ok(s.visualFx.some((e) => e[0] === 'burst' && e[4] === 'Water'));
  assert.ok(s.visualFx.some((e) => e[0] === 'impact' && e[4].kind === 'steam'));
  assert.ok(!s.visualFx.some((e) => e[0] === 'impact' && e[4].kind === 'blast'));
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
  assert.equal(s.debris.length, 1);
  assert.equal(s.debris[0].bendBurning, true);
  s.time.now += 3000;
  fire.surfaceDamage.update(3);
  assert.equal(s.debris.length, 0);
  assert.ok(s.visualFx.some((e) => e[0] === 'shockwave'));
  assert.equal(s.selfHits.length, 0);
});
