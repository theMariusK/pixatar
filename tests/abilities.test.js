const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');
const PixelWorld = require('../world');
const { COLS, ROWS, MAT } = PixelWorld;
const PIXEL = 3;
const source = ['bending.js', 'abilities.js'].map((file) =>
  fs.readFileSync(path.join(__dirname, '..', file), 'utf8')).join('\n');
const { WaterBending, EarthBending, FireBending, AirBending, BendingAbilities } = vm.runInNewContext(
  source + '\n({ WaterBending, EarthBending, FireBending, AirBending, BendingAbilities })', {
    PixelWorld, COLS, ROWS, PIXEL, PLAYER_BOX: { w: 20, h: 32 },
    EMPTY: MAT.EMPTY, WATER: MAT.WATER, FIRE: MAT.FIRE, SMOKE: MAT.SMOKE,
    GAS: MAT.GAS, LAVA: MAT.LAVA, STONE: MAT.STONE, SMOKE_LIFE: PixelWorld.SMOKE_LIFE,
    IS_SOLID: PixelWorld.IS_SOLID, PALETTE: PixelWorld.PALETTE,
    FX_PALETTE: { Fire: { core: 1, glow: 2, deep: 3, spark: 4, accent: 5 }, Air: { core: 1, glow: 2 } },
    Math: Object.assign(Object.create(Math), { random: () => 0.5 }),
    Phaser: { Display: { Color: { GetColor: () => 0 } } },
  });

function scene(element, action) {
  const s = {
    grid: new Uint8Array(COLS * ROWS), life: new Uint8Array(COLS * ROWS),
    time: { now: 1000 }, player: { x: 30, y: 150, w: 20, h: 32, facing: 1, vy: 0, impulseX: 0 },
    remotePlayers: {}, netId: 'self', enemies: { list: [] }, debris: [], projectiles: [],
    leftClickMode: 'bend', bendElement: element, bendAction: { [element]: action },
    hits: [], damage: [], selfHits: [], writes: [], visuals: [], casterFx: [],
    add: { graphics() {
      const g = {};
      for (const name of ['setDepth', 'clear', 'lineStyle', 'beginPath', 'moveTo', 'lineTo',
        'strokePath', 'fillStyle', 'fillRect', 'fillCircle']) g[name] = () => g;
      return g;
    } },
    input: { activePointer: { worldX: 180, worldY: 166, rightButtonDown: () => true } },
    idx(x, y) { return y * COLS + x; },
    setCell(id, mat, variant = 0) {
      this.bendingDamage?.invalidateCell(id);
      this.grid[id] = mat; this.life[id] = variant; this.writes.push([id, mat]);
    },
    spawnDebris(x, y, mat) {
      if (this.debris.length >= 80) return;
      const obj = { x: x * PIXEL + 1.5, y: y * PIXEL + 1.5, mat, vx: 0, vy: 0 };
      this.debris.push(obj); return obj;
    },
    reportHit(...args) { this.hits.push(args); },
    damageEnemy(...args) { this.damage.push(args); },
    receiveHit(hit) { this.selfHits.push(hit); },
    emitFireCasterParticles(count) { this.casterFx.push(count); },
    bodiesInRadius: () => [], knockback() {},
  };
  s.fx = Object.fromEntries(['burst', 'ring', 'streaks', 'shockwave', 'shards', 'smoke', 'hitstop', 'shake']
    .map((name) => [name, (...args) => s.visuals.push([name, ...args])]));
  s.benders = { Water: new WaterBending(s), Earth: new EarthBending(s),
    Fire: new FireBending(s), Air: new AirBending(s) };
  s.abilities = new BendingAbilities(s);
  s.tick = (dt) => {
    s.time.now += dt * 1000;
    s.abilities.update(dt);
    for (const bender of Object.values(s.benders)) bender.update(dt);
  };
  return s;
}

function gather(s, element, count) {
  if (element === 'Earth') {
    s.benders.Earth.rock = { x: 70, y: 150, vx: 0, vy: 0, nextSlot: count,
      cells: Array.from({ length: count }, (_, i) => ({ ox: i % 8, oy: Math.floor(i / 8), shade: i % 4 })) };
  } else for (let i = 0; i < count; i++) {
    s.benders[element].held.push({ x: 72, y: 164, vx: 0, vy: 0, life: 6 });
  }
}

function ground(s) {
  for (let x = 1; x < COLS - 1; x++) s.grid[s.idx(x, 70)] = MAT.DIRT;
  s.input.activePointer.worldY = 200;
}

function countCells(s, mat) { return s.grid.reduce((sum, cell) => sum + (cell === mat), 0); }

test('abilities reject wrong elements and missing gathered matter with a useful hint', () => {
  const s = scene('Fire', 'Flamethrower');
  assert.equal(s.abilities.cast('Whip'), false);
  assert.equal(s.abilities.cast('unknown'), false);
  for (const [element, action] of [['Water', 'Whip'], ['Water', 'Shield'], ['Earth', 'Wall'],
    ['Earth', 'Spikes'], ['Air', 'Dash'], ['Air', 'Vortex']]) {
    s.bendElement = element; s.bendAction[element] = action;
    assert.equal(s.abilities.cast(action), false);
    assert.match(s.abilities.hint, /Gather .* first with LMB/);
  }
  assert.equal(s.writes.length, 0);
});

test('Flamethrower emits bounded jets from the caster and stops on release with a cooldown', () => {
  const s = scene('Fire', 'Flamethrower');
  assert.equal(s.abilities.cast('Flamethrower'), true);
  s.abilities.update(0.05);
  assert.ok(s.benders.Fire.free.length > 0);
  assert.ok(s.benders.Fire.free.every((ember) => ember.x >= s.player.x && ember.x <= s.player.x + s.player.w
    && ember.y >= s.player.y && ember.y <= s.player.y + s.player.h && ember.flameJet && ember.maxAge < 0.3));
  assert.ok(s.casterFx.length > 0);
  for (let i = 0; i < 100; i++) s.abilities.update(0.02);
  assert.ok(s.benders.Fire.free.length <= 180);
  const count = s.benders.Fire.free.length;
  s.input.activePointer.rightButtonDown = () => false;
  s.abilities.update(0.01);
  assert.equal(s.abilities.channel, null);
  assert.equal(s.benders.Fire.free.length, count);
  assert.ok(s.abilities.remaining('Flamethrower') > 0);
  assert.equal(s.abilities.cast('Flamethrower'), false);
});

test('Flamethrower burns bodies along its path while sparing the caster', () => {
  for (const targetType of ['enemy', 'player']) {
    const s = scene('Fire', 'Flamethrower');
    if (targetType === 'enemy') s.enemies.list.push({ x: 120, y: 150, w: 20, h: 32, vy: 0 });
    else s.remotePlayers.other = { x: 120, y: 150 };
    s.abilities.cast('Flamethrower');
    for (let i = 0; i < 25; i++) s.tick(0.02);
    assert.ok(targetType === 'enemy' ? s.damage.length > 0 : s.hits.length > 0);
    assert.equal(s.selfHits.length, 0);
  }
});

test('Flamethrower ignites fuel and has a finite reach instead of leaving distant fires', () => {
  const s = scene('Fire', 'Flamethrower');
  for (let y = 50; y < 58; y++) s.grid[s.idx(45, y)] = MAT.WOOD;
  s.abilities.cast('Flamethrower');
  for (let i = 0; i < 100; i++) s.tick(0.02);
  assert.ok(s.grid.includes(MAT.FIRE));
  assert.ok(!s.benders.Fire.free.some((ember) => ember.x > 300));
  assert.equal(s.selfHits.length, 0);
});

test('Water Whip lashes once, wets and pulls its target, then returns every surviving drop', () => {
  const s = scene('Water', 'Whip');
  gather(s, 'Water', 24);
  const enemy = { x: 115, y: 150, w: 20, h: 32, vy: 0, burnUntil: 2000 };
  s.enemies.list.push(enemy);
  assert.equal(s.abilities.cast('Whip'), true);
  assert.equal(s.benders.Water.held.length, 0);
  for (let i = 0; i < 35; i++) s.tick(0.02);
  assert.equal(s.damage.length, 1);
  assert.ok(enemy.impulseX < 0 && enemy.wetUntil > 0);
  assert.equal(enemy.burnUntil, 0);
  assert.equal(s.abilities.whip, null);
  assert.ok(s.benders.Water.free.every((drop) => !drop.bendAbility));
  assert.equal(s.benders.Water.free.length + countCells(s, MAT.WATER), 24);
  assert.equal(s.selfHits.length, 0);
});

test('Water Whip cannot strike through bedrock', () => {
  const s = scene('Water', 'Whip');
  gather(s, 'Water', 24);
  for (let y = 1; y < ROWS - 1; y++) s.grid[s.idx(33, y)] = MAT.BEDROCK;
  s.enemies.list.push({ x: 130, y: 150, w: 20, h: 32, vy: 0 });
  s.abilities.cast('Whip');
  for (let i = 0; i < 35; i++) s.tick(0.02);
  assert.equal(s.damage.length, 0);
  assert.equal(s.benders.Water.free.length + countCells(s, MAT.WATER), 24);
});

test('Water Shield uses real drops, quenches fireballs, and never restores consumed water', () => {
  const s = scene('Water', 'Shield');
  gather(s, 'Water', 24);
  assert.equal(s.abilities.cast('Shield'), true);
  s.abilities.update(0.05);
  s.benders.Fire.fireballs.push({ x: 130, y: 166, vx: -440, vy: 0, size: 9,
    mass: 24, age: 0, life: 2, trail: 0, embers: [] });
  s.benders.Fire.updateFireballs(0.2);
  assert.equal(s.benders.Fire.fireballs.length, 0);
  const surviving = s.benders.Water.free.length;
  assert.ok(surviving < 24 && surviving > 0);
  s.abilities.update(0.02);
  assert.equal(s.benders.Water.free.length, surviving);
  assert.equal(s.selfHits.length, 0);
  assert.ok(s.grid.includes(MAT.SMOKE));
});

test('Water Shield follows aim and releases its finite water when RMB is released', () => {
  const s = scene('Water', 'Shield');
  gather(s, 'Water', 24);
  s.abilities.cast('Shield');
  s.abilities.update(0.05);
  const before = s.benders.Water.free.reduce((sum, drop) => sum + drop.x, 0);
  s.input.activePointer.worldX = 0;
  for (let i = 0; i < 4; i++) s.abilities.update(0.05);
  const after = s.benders.Water.free.reduce((sum, drop) => sum + drop.x, 0);
  assert.ok(after < before);
  s.input.activePointer.rightButtonDown = () => false;
  s.abilities.update(0.02);
  assert.equal(s.abilities.shield, null);
  assert.equal(s.benders.Water.free.length, 24);
  assert.ok(s.benders.Water.free.every((drop) => !drop.bendAbility));
});

test('Water Shield intercepts fast spell bolts along their swept path and spends a drop', () => {
  for (const element of ['Fire', 'Earth']) {
    const s = scene('Water', 'Shield');
    gather(s, 'Water', 24);
    s.abilities.cast('Shield');
    s.abilities.update(0.05);
    const pr = { element, x: 40, y: 166, vx: -1800, vy: 0 };
    s.projectiles.push(pr);
    assert.equal(s.abilities.interceptProjectile(pr, 150, 166), true);
    assert.equal(s.benders.Water.free.length, 23);
    if (element === 'Fire') assert.equal(s.projectiles.length, 0);
    else {
      assert.ok(pr.vx > 0 && pr.x > s.player.x + s.player.w);
      assert.equal(s.abilities.interceptProjectile(pr), false);
      assert.equal(countCells(s, MAT.WATER), 1);
    }
  }
});

test('Earth Wall raises grounded terrain using exactly the gathered cells', () => {
  const s = scene('Earth', 'Wall');
  ground(s); gather(s, 'Earth', 30);
  assert.equal(s.abilities.cast('Wall'), true);
  assert.equal(s.benders.Earth.holding, 0);
  s.abilities.update(0.5);
  assert.equal(countCells(s, MAT.STONE), 30);
  assert.equal(s.abilities.structures.length, 0);
  assert.equal(s.grid[s.idx(60, 70)], MAT.DIRT);
  assert.equal(s.grid[s.idx(60, 69)], MAT.STONE);
  assert.equal(s.grid[s.idx(60, 60)], MAT.STONE);
  assert.equal(s.abilities.cast('Wall'), false);
});

test('Earth Spikes rise, hit targets once, lift them, and spare the caster', () => {
  const s = scene('Earth', 'Spikes');
  ground(s); gather(s, 'Earth', 90);
  const enemy = { x: 170, y: 178, w: 20, h: 32, vy: 0 };
  s.enemies.list.push(enemy);
  assert.equal(s.abilities.cast('Spikes'), true);
  for (let i = 0; i < 40; i++) {
    s.time.now += 20;
    s.abilities.update(0.02);
    enemy.y += enemy.vy * 0.02;
  }
  assert.equal(s.damage.length, 1);
  assert.ok(enemy.vy < 0 && countCells(s, MAT.STONE) > 0);
  assert.equal(s.selfHits.length, 0);
  assert.equal(countCells(s, MAT.STONE) + s.benders.Earth.holding + s.benders.Earth.loosePieces.length, 90);
});

test('Earth Spikes have pointed tops even with a small gathering budget', () => {
  const s = scene('Earth', 'Spikes');
  ground(s); gather(s, 'Earth', 12);
  assert.equal(s.abilities.cast('Spikes'), true);
  s.abilities.update(0.5);
  assert.equal(s.grid[s.idx(60, 66)], MAT.STONE);
  assert.equal(s.grid[s.idx(59, 66)], MAT.EMPTY);
  assert.equal(s.grid[s.idx(61, 66)], MAT.EMPTY);
  assert.equal(countCells(s, MAT.STONE) + s.benders.Earth.holding, 12);
});

test('Earth abilities reuse gathering slots after consuming part of a held rock', () => {
  const s = scene('Earth', 'Wall');
  ground(s); gather(s, 'Earth', 160);
  s.benders.Earth.pieces.push({ slot: 160, x: 50, y: 160, variant: 1 });
  s.abilities.cast('Wall');
  assert.equal(s.benders.Earth.rock.cells.length, 76);
  assert.equal(s.benders.Earth.pieces[0].slot, 76);
  assert.equal(s.benders.Earth.rock.nextSlot, 77);
});

test('Earth abilities reject floating placement without consuming matter', () => {
  for (const action of ['Wall', 'Spikes']) {
    const s = scene('Earth', action);
    gather(s, 'Earth', 30);
    assert.equal(s.abilities.cast(action), false);
    assert.equal(s.benders.Earth.holding, 30);
    assert.match(s.abilities.hint, /ground/);
    assert.equal(s.writes.length, 0);
  }
});

test('Earth construction preserves bedrock, returns blocked cells, and avoids burying bodies', () => {
  const s = scene('Earth', 'Wall');
  ground(s); gather(s, 'Earth', 30);
  s.abilities.cast('Wall');
  s.grid[s.idx(59, 69)] = MAT.BEDROCK;
  s.player.x = 177; s.player.y = 185;
  s.abilities.update(0.5);
  assert.equal(s.grid[s.idx(59, 69)], MAT.BEDROCK);
  for (let y = 62; y < 70; y++) for (let x = 59; x < 62; x++) {
    if (x * PIXEL < s.player.x + s.player.w && x * PIXEL + PIXEL > s.player.x
      && y * PIXEL < s.player.y + s.player.h && y * PIXEL + PIXEL > s.player.y) {
      assert.notEqual(s.grid[s.idx(x, y)], MAT.STONE);
    }
  }
  assert.equal(countCells(s, MAT.STONE) + s.benders.Earth.loosePieces.length, 30);
});

test('Air Dash spends gathered wisps, applies movement force, and has a cooldown', () => {
  const s = scene('Air', 'Dash');
  gather(s, 'Air', 30);
  assert.equal(s.abilities.cast('Dash'), true);
  assert.equal(s.benders.Air.held.length, 6);
  assert.equal(s.player.impulseX, 560);
  assert.equal(s.player.x, 30); // the normal collision-aware movement performs the dash
  assert.equal(s.player.grounded, false);
  assert.equal(s.abilities.cast('Dash'), false);
  assert.equal(s.benders.Air.held.length, 6);
  s.abilities.update(0.2);
  assert.equal(s.abilities.dash, null);
});

test('Air Vortex pulls and swirls bodies, debris, bent water, fire and rocks with mass resistance', () => {
  const s = scene('Air', 'Vortex');
  gather(s, 'Air', 30);
  s.input.activePointer.worldX = 180;
  const obj = { x: 205, y: 166, vx: 0, vy: 0, mat: MAT.STONE };
  const drop = { x: 205, y: 166, vx: 0, vy: 0 };
  const ember = { x: 205, y: 166, vx: 0, vy: 0, age: 0 };
  s.debris.push(obj);
  s.benders.Water.free.push(drop);
  s.benders.Fire.free.push(ember);
  const rock = { x: 205, y: 190, vx: 0, vy: 0, cells: Array.from({ length: 30 }, () => ({ ox: 0, oy: 0 })) };
  s.benders.Earth.thrown.push(rock);
  s.enemies.list.push({ x: 195, y: 150, w: 20, h: 32, vy: 0 });
  s.remotePlayers.other = { x: 195, y: 150 };
  assert.equal(s.abilities.cast('Vortex'), true);
  s.abilities.update(0.03);
  assert.ok(obj.vx < 0 && obj.vy < 0 && drop.vx < 0 && ember.vx < 0 && rock.vx < 0);
  assert.ok(Math.abs(rock.vx) < Math.abs(obj.vx));
  assert.ok(s.enemies.list[0].impulseX < 0 && s.hits[0][4].ix < 0);
  assert.equal(s.benders.Air.held.length, 0);
});

test('Air Vortex stays in front of cover and cannot pull bodies through it', () => {
  const s = scene('Air', 'Vortex');
  gather(s, 'Air', 30);
  for (let y = 1; y < ROWS - 1; y++) s.grid[s.idx(33, y)] = MAT.BEDROCK;
  const obj = { x: 130, y: 166, vx: 0, vy: 0, mat: MAT.WOOD };
  s.debris.push(obj);
  s.abilities.cast('Vortex');
  for (let i = 0; i < 10; i++) s.abilities.update(0.03);
  assert.ok(s.abilities.vortex.x < 99);
  assert.equal(obj.vx, 0);
  assert.equal(obj.vy, 0);
  s.abilities.update(3);
  assert.equal(s.abilities.vortex, null);
});

test('held abilities end on wheel opening, element switching, or caster death', () => {
  for (const stop of ['wheel', 'element', 'death']) {
    for (const [element, action] of [['Fire', 'Flamethrower'], ['Water', 'Shield']]) {
      const s = scene(element, action);
      if (element === 'Water') gather(s, 'Water', 12);
      s.abilities.cast(action);
      if (stop === 'wheel') s.bendWheelOpen = true;
      if (stop === 'element') s.bendElement = 'Earth';
      if (stop === 'death') s.player.dead = true;
      s.abilities.update(0.02);
      assert.equal(s.abilities.channel, null);
      assert.ok(s.benders.Water.free.every((drop) => !drop.bendAbility));
    }
  }
});
