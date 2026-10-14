const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');
const PixelWorld = require('../world');
const { COLS, ROWS, MAT } = PixelWorld, PIXEL = 3;
const source = ['bending.js', 'attack-control.js', 'abilities.js'].map((file) =>
  fs.readFileSync(path.join(__dirname, '..', file), 'utf8')).join('\n');
const types = vm.runInNewContext(source + '\n({ WaterBending, EarthBending, FireBending, AirBending, BendingAttackControl, BendingAbilities })', {
  PixelWorld, COLS, ROWS, PIXEL, PLAYER_BOX: { w: 20, h: 32 },
  EMPTY: MAT.EMPTY, WATER: MAT.WATER, STONE: MAT.STONE, FIRE: MAT.FIRE,
  SMOKE: MAT.SMOKE, GAS: MAT.GAS, LAVA: MAT.LAVA, SMOKE_LIFE: PixelWorld.SMOKE_LIFE,
  IS_SOLID: PixelWorld.IS_SOLID, PALETTE: PixelWorld.PALETTE,
  FX_PALETTE: { Fire: { core: 1, glow: 2, spark: 3, deep: 4, accent: 5 }, Air: { core: 1, glow: 2 } },
  Math: Object.assign(Object.create(Math), { random: () => 0.5 }),
  Phaser: { Display: { Color: { GetColor: () => 0 } } },
});

function scene(element, action = 'Punch') {
  const s = {
    grid: new Uint8Array(COLS * ROWS), life: new Uint8Array(COLS * ROWS),
    time: { now: 1000 }, player: { x: 20, y: 20, w: 20, h: 32, facing: 1, vy: 0 },
    leftClickMode: 'bend', bendElement: element, bendAction: { [element]: action },
    keys: { shift: { isDown: false }, c: { isDown: false }, v: { isDown: false } },
    input: { activePointer: { worldX: 200, worldY: 36, leftButtonDown: () => false, rightButtonDown: () => false } },
    remotePlayers: {}, netId: 'self', enemies: { list: [] }, debris: [], projectiles: [],
    hits: [], damage: [], selfHits: [], visuals: [],
    add: { graphics() {
      const g = {};
      for (const name of ['setDepth', 'clear', 'fillStyle', 'fillRect', 'fillCircle', 'lineStyle',
        'beginPath', 'moveTo', 'lineTo', 'strokePath']) g[name] = () => g;
      return g;
    } },
    idx(x, y) { return y * COLS + x; },
    setCell(id, mat, variant = 0) { this.bendingDamage?.invalidateCell(id); this.grid[id] = mat; this.life[id] = variant; },
    spawnDebris(x, y, mat) {
      const obj = { x: x * PIXEL + 1.5, y: y * PIXEL + 1.5, vx: 0, vy: 0, mat };
      this.debris.push(obj); return obj;
    },
    bodiesInRadius: () => [], knockback() {}, emitFireCasterParticles() {},
    reportHit(...args) { this.hits.push(args); }, damageEnemy(...args) { this.damage.push(args); },
    receiveHit(hit) { this.selfHits.push(hit); },
  };
  s.fx = Object.fromEntries(['burst', 'ring', 'shockwave', 'shards', 'smoke', 'streaks', 'hitstop', 'shake']
    .map((name) => [name, (...args) => s.visuals.push([name, ...args])]));
  s.benders = Object.fromEntries(['Water', 'Earth', 'Fire', 'Air'].map((name) => [name, new types[name + 'Bending'](s)]));
  s.bendAbilities = new types.BendingAbilities(s);
  s.attackControl = new types.BendingAttackControl(s);
  return s;
}

function gather(s, count = 12) {
  const bender = s.benders[s.bendElement];
  if (s.bendElement === 'Earth') {
    bender.rock = { x: 70, y: 36, vx: 0, vy: 0, nextSlot: count,
      cells: Array.from({ length: count }, (_, i) => ({ ox: bender.slots[i][0], oy: bender.slots[i][1], shade: i % 4 })) };
  } else for (let i = 0; i < count; i++) bender.held.push({ x: 70, y: 36, vx: 0, vy: 0, life: 5 });
}

function charge(s) { s.keys.shift.isDown = true; s.attackControl.update(1.25); s.keys.shift.isDown = false; }
function count(s, mat) { return s.grid.reduce((sum, cell) => sum + (cell === mat), 0); }

test('charging increases Punch speed and force for every element without adding matter', () => {
  for (const element of ['Water', 'Earth', 'Fire', 'Air']) {
    const base = scene(element), powered = scene(element);
    gather(base); gather(powered); charge(powered);
    assert.equal(powered.attackControl.charge, 1);
    base.benders[element].punch(); powered.benders[element].punch();
    const object = (s) => element === 'Earth' ? s.benders.Earth.thrown[0]
      : element === 'Fire' ? s.benders.Fire.fireballs[0] : s.benders[element].free[0];
    assert.ok(object(powered).vx > object(base).vx);
    assert.ok(object(powered).attackPower > object(base).attackPower);
    assert.equal(powered.attackControl.charge, 0);
    assert.equal(element === 'Earth' ? object(powered).cells.length : element === 'Fire' ? object(powered).mass
      : powered.benders[element].free.length, 12);
  }
});

test('charged fireball impacts break stronger surfaces while using the same ember count', () => {
  const impact = (charged) => {
    const s = scene('Fire'); gather(s);
    if (charged) charge(s);
    s.benders.Fire.punch();
    const ball = s.benders.Fire.fireballs[0];
    ball.x = 121.5; ball.y = 121.5;
    s.grid[s.idx(40, 40)] = MAT.BRICK;
    s.benders.Fire.impactFireball(ball);
    return s;
  };
  assert.equal(impact(false).grid[40 + 40 * COLS], MAT.BRICK);
  assert.notEqual(impact(true).grid[40 + 40 * COLS], MAT.BRICK);
});

test('charging boosts Orbit attacks as well as Bolt attacks', () => {
  for (const element of ['Water', 'Earth', 'Fire', 'Air']) {
    const s = scene(element); gather(s); s.benders[element].form = 'Orbit'; charge(s);
    assert.equal(s.benders[element].punch(), true);
    assert.equal(s.attackControl.charge, 0);
    if (element === 'Air') assert.ok(s.benders.Air.rings[0].strength > 400);
    else if (element === 'Earth') assert.ok(s.benders.Earth.thrown[0].attackPower > 1);
    else assert.ok(s.benders[element].free[0].attackPower > 1);
  }
});

test('charged Normal releases aim the material while retaining their individual particles', () => {
  for (const element of ['Water', 'Earth', 'Fire', 'Air']) {
    const s = scene(element, 'Normal'); gather(s); charge(s);
    s.attackControl.prepareRelease(element); s.benders[element].release();
    const obj = element === 'Earth' ? s.benders.Earth.thrown[0] : s.benders[element].free[0];
    assert.ok(obj.vx > 300 && obj.attackPower > 1);
    assert.equal(s.attackControl.charge, 0);
    if (element === 'Fire') assert.equal(s.benders.Fire.fireballs.length, 0);
  }
});

test('charging requires held matter and is cleared by switching elements or opening Q', () => {
  const s = scene('Fire'); s.keys.shift.isDown = true; s.attackControl.update(1.25);
  assert.equal(s.attackControl.charge, 0);
  gather(s); charge(s); s.bendWheelOpen = true; s.attackControl.update(0.01);
  assert.equal(s.attackControl.charge, 0);
  assert.equal(s.benders.Fire.holding, 0);
  s.bendWheelOpen = false; s.bendElement = 'Water'; s.bendAction.Water = 'Punch';
  s.attackControl.update(0.01);
  assert.equal(s.attackControl.charge, 0);
});

test('C keeps gathered matter held, permits selecting Q actions, and releases on a second toggle', () => {
  for (const element of ['Water', 'Earth', 'Fire', 'Air']) {
    const s = scene(element); gather(s);
    s.keys.c.isDown = true; s.attackControl.update(0.01); s.benders[element].release();
    assert.equal(s.benders[element].holding, 12);
    s.bendWheelOpen = true; s.attackControl.update(0.02); s.benders[element].update(0.02);
    assert.equal(s.benders[element].holding, 12);
    s.bendWheelOpen = false; s.keys.c.isDown = false; s.attackControl.update(0.01);
    s.keys.c.isDown = true; s.attackControl.update(0.01); s.benders[element].release();
    assert.equal(s.benders[element].holding, 0);
  }
});

test('resuming Earth gathering after C holding preserves the existing rock', () => {
  const s = scene('Earth'); gather(s);
  s.keys.c.isDown = true; s.attackControl.update(0.01);
  s.benders.Earth.release();
  const rock = s.benders.Earth.rock;
  s.benders.Earth.begin();
  assert.equal(s.benders.Earth.rock, rock);
  assert.equal(s.benders.Earth.holding, 12);
});

test('size changes release excess material and preserve cell variants', () => {
  for (const element of ['Water', 'Earth', 'Fire', 'Air']) {
    const s = scene(element); gather(s, element === 'Earth' ? 20 : 12);
    s.attackControl.sizes[element] = 12;
    s.attackControl.adjustSize(-1);
    const held = s.benders[element].holding;
    const released = element === 'Earth' ? s.benders.Earth.loosePieces.length : s.benders[element].free.length;
    assert.equal(held, s.attackControl.capacity(element));
    assert.equal(held + released, element === 'Earth' ? 20 : 12);
    if (element === 'Earth') {
      assert.ok(s.benders.Earth.loosePieces.every((piece) => piece.variant >= 0 && piece.variant < 4));
      assert.equal(s.benders.Earth.rock.nextSlot, held);
    }
  }
});

test('gathering obeys selected size limits and never fabricates water or earth', () => {
  for (const element of ['Water', 'Earth', 'Fire', 'Air']) {
    const s = scene(element); s.input.activePointer = { ...s.input.activePointer, worldX: 90, worldY: 36 };
    s.attackControl.sizes[element] = 4;
    if (element === 'Water' || element === 'Earth') {
      for (let y = 10; y <= 14; y++) for (let x = 28; x <= 32; x++) s.grid[s.idx(x, y)] = element === 'Water' ? MAT.WATER : MAT.DIRT;
    }
    s.benders[element].begin(); s.benders[element].grab(0.5);
    assert.equal(s.benders[element].holding, 4);
    if (element === 'Water') assert.equal(count(s, MAT.WATER), 21);
    if (element === 'Earth') assert.equal(count(s, MAT.DIRT), 21);
  }
});

test('size preferences are per element, bounded, and inert outside bending', () => {
  const s = scene('Fire');
  for (let i = 0; i < 100; i++) s.attackControl.adjustSize(-1);
  assert.equal(s.attackControl.capacity('Fire'), 4);
  assert.equal(s.attackControl.capacity('Water'), 200);
  s.leftClickMode = 'dig'; assert.equal(s.attackControl.adjustSize(1), false);
  s.leftClickMode = 'bend'; for (let i = 0; i < 100; i++) s.attackControl.adjustSize(1);
  assert.equal(s.attackControl.capacity('Fire'), 120);
});

test('recall returns only the water that fits, with exact conservation and no body effects in flight', () => {
  const s = scene('Water'); gather(s, 2); s.attackControl.sizes.Water = 4;
  for (let i = 0; i < 3; i++) s.benders.Water.free.push({ x: 130, y: 32.8, vx: 200, vy: 0, age: 0 });
  s.enemies.list.push({ x: 80, y: 20, w: 20, h: 32, vy: 0 });
  assert.equal(s.attackControl.recall(), true);
  s.benders.Water.touchBodies();
  assert.equal(s.hits.length, 0); assert.equal(s.damage.length, 0);
  s.attackControl.update(0.2);
  assert.equal(s.benders.Water.holding, 4);
  assert.equal(s.benders.Water.free.length, 1);
  assert.equal(s.attackControl.returning.length, 0);
  assert.ok(s.attackControl.latched);
});

test('recall splits large Earth rocks to fit without changing material count or shades', () => {
  const s = scene('Earth'); gather(s, 20);
  const rock = s.benders.Earth.rock;
  rock.x = 130; rock.y = 60; rock.age = 0;
  s.benders.Earth.rock = null; s.benders.Earth.thrown.push(rock);
  s.attackControl.sizes.Earth = 8;
  assert.equal(s.attackControl.recall(), true);
  s.attackControl.update(0.4);
  assert.equal(s.benders.Earth.holding, 8);
  assert.equal(s.benders.Earth.thrown[0].cells.length, 12);
  assert.deepEqual(Array.from(s.benders.Earth.rock.cells, (cell) => cell.shade), [0, 1, 2, 3, 0, 1, 2, 3]);
});

test('fireball recall decompresses only the remaining ember mass and preserves the unused ball', () => {
  const s = scene('Fire'); s.attackControl.sizes.Fire = 6;
  const ball = { x: 130, y: 32.8, vx: 440, vy: 0, mass: 12, size: 9, life: 2, age: 0, embers: [{ radius: 5 }] };
  s.benders.Fire.fireballs.push(ball);
  assert.equal(s.attackControl.recall(), true);
  s.attackControl.update(0.2);
  assert.equal(s.benders.Fire.holding, 6);
  assert.equal(s.benders.Fire.fireballs[0].mass, 6);
  assert.ok(ball.size < 9 && ball.embers[0].radius < 5);
  assert.ok(s.benders.Fire.held.every((ember) => ember.life <= 1.8));
});

test('recall cannot recover spent, distant, shield-owned or enemy spell material', () => {
  const s = scene('Fire');
  const old = { x: 100, y: 36, vx: 0, vy: 0, age: 4, life: 0 };
  const distant = { x: 600, y: 36, vx: 0, vy: 0, age: 0, life: 5 };
  const spray = { x: 100, y: 36, vx: 0, vy: 0, age: 0, life: 5, flameJet: true };
  s.benders.Fire.free.push(old, distant, spray);
  s.benders.Fire.fireballs.push({ x: 100, y: 36, mass: 12, life: 0, age: 3 });
  const enemy = { x: 100, y: 36, element: 'Fire' }; s.projectiles.push(enemy);
  assert.equal(s.attackControl.recall(), false);
  assert.equal(s.benders.Fire.holding, 0);
  assert.equal(s.projectiles[0], enemy);
  const water = scene('Water'); water.benders.Water.free.push({ x: 100, y: 36, age: 0, bendAbility: {} });
  assert.equal(water.attackControl.recall(), false);
});

test('recall respects cover and safely resumes physics if a new wall blocks the return', () => {
  const s = scene('Water');
  const drop = { x: 130, y: 32.8, vx: 0, vy: 0, age: 0 }; s.benders.Water.free.push(drop);
  for (let y = 1; y < ROWS - 1; y++) s.grid[s.idx(25, y)] = MAT.BEDROCK;
  assert.equal(s.attackControl.recall(), false);
  for (let y = 1; y < ROWS - 1; y++) s.grid[s.idx(25, y)] = MAT.EMPTY;
  assert.equal(s.attackControl.recall(), true);
  s.attackControl.update(0.05);
  for (let y = 1; y < ROWS - 1; y++) s.grid[s.idx(25, y)] = MAT.BEDROCK;
  s.attackControl.update(1);
  assert.ok(drop.x >= 78);
  s.attackControl.update(2);
  assert.equal(drop.bendRecalling, undefined);
  assert.equal(s.benders.Water.free[0], drop);
  assert.equal(s.benders.Water.holding, 0);
});

test('recall reserves gathering capacity and cannot resurrect material consumed during return', () => {
  const s = scene('Water'); s.attackControl.sizes.Water = 4;
  for (let i = 0; i < 4; i++) s.benders.Water.free.push({ x: 130, y: 32.8, vx: 0, vy: 0, age: 0 });
  s.attackControl.recall();
  assert.equal(s.attackControl.gatherCapacity('Water'), 0);
  s.benders.Water.free.splice(0, 1);
  s.attackControl.update(0.2);
  assert.equal(s.benders.Water.holding, 3);
  assert.equal(s.benders.Water.free.length, 0);
});

test('returning fire and air expire naturally and do not gain a new lifetime', () => {
  for (const element of ['Fire', 'Air']) {
    const s = scene(element);
    const drop = { x: 280, y: 36, vx: 0, vy: 0, age: element === 'Fire' ? 2.9 : 2.1, life: 5 };
    s.benders[element].free.push(drop);
    assert.equal(s.attackControl.recall(), true);
    s.attackControl.update(0.2);
    assert.equal(s.benders[element].free.length, 0);
    assert.equal(s.benders[element].holding, 0);
  }
});

test('V recalls owned material and C remains responsive after opening and closing the wheel', () => {
  const s = scene('Water'); s.benders.Water.free.push({ x: 100, y: 32.8, vx: 0, vy: 0, age: 0 });
  s.keys.v.isDown = true; s.attackControl.update(0.2);
  assert.equal(s.benders.Water.holding, 1);
  assert.ok(s.attackControl.latched);
  s.bendWheelOpen = true; s.keys.c.isDown = true; s.attackControl.update(0.01);
  s.bendWheelOpen = false; s.attackControl.update(0.01);
  assert.ok(s.attackControl.latched); // keypress while Q was open is not queued
  s.keys.c.isDown = false; s.attackControl.update(0.01);
  s.keys.c.isDown = true; s.attackControl.update(0.01);
  assert.equal(s.attackControl.latched, false);
});

test('mode changes and death release latched matter and clear pending recalls and charge', () => {
  for (const stop of ['dig', 'element', 'death']) {
    const s = scene('Water'); gather(s, 2);
    s.benders.Water.free.push({ x: 130, y: 32.8, vx: 0, vy: 0, age: 0 });
    s.attackControl.recall(); charge(s);
    if (stop === 'dig') s.leftClickMode = 'dig';
    if (stop === 'element') { s.bendElement = 'Fire'; s.bendAction.Fire = 'Punch'; }
    if (stop === 'death') s.player.dead = true;
    s.attackControl.update(0.01);
    assert.equal(s.attackControl.charge, 0);
    assert.equal(s.attackControl.latched, false);
    assert.equal(s.attackControl.returning.length, 0);
    assert.equal(s.benders.Water.holding, 0);
    assert.ok(s.benders.Water.free.every((drop) => !drop.bendRecalling));
  }
});

test('charging distinct one-shot abilities boosts their effects and spends charge once', () => {
  for (const [element, action] of [['Water', 'Whip'], ['Earth', 'Spikes'], ['Air', 'Dash'], ['Air', 'Vortex']]) {
    const s = scene(element, action); gather(s, 24); charge(s);
    if (element === 'Earth') {
      s.input.activePointer.worldY = 150;
      for (let x = 1; x < COLS - 1; x++) s.grid[s.idx(x, 60)] = MAT.DIRT;
    }
    assert.equal(s.bendAbilities.cast(action), true);
    assert.equal(s.attackControl.charge, 0);
    if (action === 'Whip') assert.ok(s.bendAbilities.whip.power > 1);
    if (action === 'Spikes') assert.ok(s.bendAbilities.structures[0].power > 1);
    if (action === 'Dash') assert.ok(s.player.impulseX > 560);
    if (action === 'Vortex') assert.ok(s.bendAbilities.vortex.power > 1);
  }
});
