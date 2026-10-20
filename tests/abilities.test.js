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
  s.fx = Object.fromEntries(['burst', 'ring', 'streaks', 'shockwave', 'shards', 'smoke', 'hitstop', 'shake', 'impact']
    .map((name) => [name, (...args) => s.visuals.push([name, ...args])]));
  s.benders = { Water: new WaterBending(s), Earth: new EarthBending(s),
    Fire: new FireBending(s), Air: new AirBending(s) };
  s.abilities = new BendingAbilities(s);
  s.bendAbilities = s.abilities;
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

function incomingRock(count = 9, speed = 500) {
  return { x: 180, y: 166, vx: -speed, vy: 0, age: 0.1,
    cells: Array.from({ length: count }, (_, i) => ({ ox: 0, oy: 0, shade: i % 4 })) };
}

test('Earth Catch intercepts a moving rock before impact and preserves its exact cell count', () => {
  const s = scene('Earth', 'Catch'), rock = incomingRock(9, 800);
  s.benders.Earth.thrown.push(rock);
  s.abilities.cast('Catch');
  s.benders.Earth.updateThrown(0.14);
  assert.equal(s.benders.Earth.thrown.length, 0);
  assert.equal(s.benders.Earth.holding, 9);
  assert.equal(s.benders.Earth.rock.defensiveCaught, true);
  assert.deepEqual(Array.from(s.benders.Earth.rock.cells, (cell) => cell.shade), Array.from(rock.cells, (cell) => cell.shade));
  assert.equal(s.writes.length, 0);
  assert.equal(s.selfHits.length, 0);
});

test('a caught rock stays held after RMB release and can be thrown back with another press', () => {
  const s = scene('Earth', 'Catch'), earth = s.benders.Earth;
  const rock = incomingRock();
  s.abilities.cast('Catch');
  assert.equal(s.abilities.interceptRock(rock, 180, 166, 80, 166), 'caught');
  const held = earth.rock;
  s.input.activePointer.rightButtonDown = () => false;
  s.abilities.update(0.02);
  earth.release();
  assert.equal(earth.rock, held);
  s.bendWheelOpen = true;
  earth.update(0.02);
  assert.equal(earth.rock, held);
  s.bendWheelOpen = false;
  s.time.now += 200;
  s.input.activePointer.rightButtonDown = () => true;
  earth.form = 'Orbit';
  assert.equal(s.abilities.cast('Catch'), true);
  assert.equal(earth.rock, null);
  assert.equal(earth.thrown.length, 1);
  assert.equal(earth.thrown[0].cells.length, 9);
  assert.ok(earth.thrown[0].vx > 500);
  assert.equal(earth.form, 'Orbit');
  s.enemies.list.push({ x: 130, y: 150, w: 20, h: 32, vy: 0 });
  earth.updateThrown(0.12);
  assert.ok(s.damage.length > 0);
});

test('LMB can resume control of caught matter without replacing or duplicating it', () => {
  const s = scene('Earth', 'Catch');
  s.abilities.cast('Catch');
  s.abilities.interceptRock(incomingRock(), 180, 166, 80, 166);
  const rock = s.benders.Earth.rock;
  s.benders.Earth.begin();
  assert.equal(s.benders.Earth.rock, rock);
  assert.equal(s.benders.Earth.holding, 9);
  assert.equal(rock.defensiveCaught, undefined);
  s.benders.Earth.release();
  assert.equal(s.benders.Earth.thrown.length, 1);
});

test('Earth Catch captures incoming loose stone and Earth bolts while leaving wood alone', () => {
  const s = scene('Earth', 'Catch');
  const stone = { x: 90, y: 166, vx: -200, vy: 0, mat: MAT.STONE, variant: 3 };
  const wood = { x: 90, y: 166, vx: -200, vy: 0, mat: MAT.WOOD };
  s.debris.push(stone, wood);
  s.abilities.cast('Catch');
  s.abilities.update(0.01);
  assert.deepEqual(s.debris, [wood]);
  assert.equal(s.benders.Earth.holding, 1);
  assert.equal(s.benders.Earth.rock.cells[0].shade, 3);
  const pr = { x: 40, y: 166, vx: -400, vy: 0, mass: 5, element: 'Earth' };
  s.projectiles.push(pr);
  assert.equal(s.abilities.interceptProjectile(pr, 180, 166), true);
  assert.equal(s.projectiles.length, 0);
  assert.equal(s.benders.Earth.holding, 6);
});

test('Earth Catch enforces capacity and impact energy limits', () => {
  const s = scene('Earth', 'Catch');
  gather(s, 'Earth', 159);
  s.abilities.cast('Catch');
  assert.equal(s.abilities.interceptRock(incomingRock(5, 200), 180, 166, 80, 166), null);
  assert.equal(s.benders.Earth.holding, 159);
  assert.match(s.abilities.hint, /capacity/);
  const heavy = scene('Earth', 'Catch');
  heavy.abilities.cast('Catch');
  assert.equal(heavy.abilities.interceptRock(incomingRock(140, 2000), 180, 166, 80, 166), null);
  assert.equal(heavy.benders.Earth.holding, 0);
  assert.match(heavy.abilities.hint, /heavy or fast/);
  assert.ok(!heavy.visuals.some(([name]) => name === 'impact'));
});

test('successful Catch and Deflect give guard feedback with the incoming direction', () => {
  for (const [element, action] of [['Earth', 'Catch'], ['Air', 'Deflect']]) {
    const s = scene(element, action);
    if (action === 'Deflect') gather(s, 'Air', 30);
    s.abilities.cast(action);
    const rock = incomingRock();
    assert.ok(s.abilities.interceptRock(rock, 180, 166, 80, 166));
    const cue = s.visuals.find(([name]) => name === 'impact');
    assert.equal(cue[3], element);
    assert.equal(cue[4].kind, 'block');
    assert.equal(cue[4].parry, true);
    assert.ok(cue[4].vx < 0);
    assert.equal(s.damage.length, 0);
  }
});

test('a well-timed Earth Catch can stop a heavier rock than an old guard', () => {
  const early = scene('Earth', 'Catch'), late = scene('Earth', 'Catch');
  early.abilities.cast('Catch'); late.abilities.cast('Catch');
  late.abilities.update(0.4);
  assert.equal(early.abilities.interceptRock(incomingRock(80, 500), 180, 166, 80, 166), 'caught');
  assert.equal(late.abilities.interceptRock(incomingRock(80, 500), 180, 166, 80, 166), null);
});

test('aimed defenses reject attacks from behind, outgoing shots, and attacks behind cover', () => {
  for (const action of ['Catch', 'Deflect']) {
    const s = scene(action === 'Catch' ? 'Earth' : 'Air', action);
    if (action === 'Deflect') gather(s, 'Air', 30);
    s.abilities.cast(action);
    const rear = incomingRock(); rear.vx = 500;
    assert.equal(s.abilities.interceptRock(rear, -60, 166, 80, 166), null);
    assert.equal(s.abilities.interceptRock(rear, 80, 166, 180, 166), null);
    for (let y = 1; y < ROWS - 1; y++) s.grid[s.idx(36, y)] = MAT.BEDROCK;
    assert.equal(s.abilities.interceptRock(incomingRock(), 180, 166, 80, 166), null);
  }
});

test('Air Deflect redirects a fast fireball without detonating it or spending its fire', () => {
  const s = scene('Air', 'Deflect');
  gather(s, 'Air', 20); s.abilities.cast('Deflect');
  const ball = { x: 180, y: 166, vx: -440, vy: 0, size: 9, mass: 24,
    age: 0, life: 2, trail: 0, embers: [] };
  s.benders.Fire.fireballs.push(ball);
  s.benders.Fire.updateFireballs(0.3);
  assert.equal(s.benders.Fire.fireballs[0], ball);
  assert.equal(ball.mass, 24);
  assert.ok(ball.vx > 0 && ball.x > s.player.x + s.player.w);
  assert.ok(s.abilities.deflect.wisps.length < 20);
  assert.equal(countCells(s, MAT.FIRE), 0);
  assert.equal(s.selfHits.length, 0);
});

test('Air Deflect redirects spell bolts and removes homing without intercepting them twice', () => {
  for (const element of ['Fire', 'Earth', 'Water']) {
    const s = scene('Air', 'Deflect');
    gather(s, 'Air', 30); s.abilities.cast('Deflect');
    const pr = { x: 40, y: 166, vx: -1000, vy: 0, radius: 6, element, homing: true, hist: [150, 166] };
    s.projectiles.push(pr);
    assert.equal(s.abilities.interceptProjectile(pr, 180, 166), true);
    assert.ok(pr.vx > 0);
    assert.equal(pr.homing, false);
    assert.equal(pr.hist.length, 2);
    const remaining = s.abilities.deflect.wisps.length;
    assert.equal(s.abilities.interceptProjectile(pr), false);
    assert.equal(s.abilities.deflect.wisps.length, remaining);
    assert.equal(s.projectiles[0], pr);
  }
});

test('Air Deflect reverses thrown rocks without changing their material count', () => {
  const s = scene('Air', 'Deflect');
  gather(s, 'Air', 30); s.abilities.cast('Deflect');
  const rock = incomingRock(9, 800);
  s.benders.Earth.thrown.push(rock);
  s.benders.Earth.updateThrown(0.14);
  assert.equal(s.benders.Earth.thrown[0], rock);
  assert.ok(rock.vx > 0);
  assert.equal(rock.cells.length, 9);
  assert.equal(s.benders.Earth.holding, 0);
  assert.equal(s.writes.length, 0);
});

test('Air Deflect also intercepts airborne embers and water jets before body contact', () => {
  for (const element of ['Fire', 'Water']) {
    const s = scene('Air', 'Deflect');
    gather(s, 'Air', 20); s.abilities.cast('Deflect');
    const particle = { x: 150, y: 166, vx: -820, vy: 0, age: 0, punched: true };
    s.benders[element].free.push(particle);
    s.benders[element].updateFree(0.12);
    assert.equal(s.benders[element].free[0], particle);
    assert.ok(particle.vx > 0);
    assert.ok(s.abilities.deflect.wisps.length < 20);
  }
});

test('Air Deflect has a finite budget and returns unused wisps on release', () => {
  const s = scene('Air', 'Deflect');
  gather(s, 'Air', 8); s.abilities.cast('Deflect');
  for (let i = 0; i < 4; i++) {
    const pr = { x: 40, y: 166, vx: -440, vy: 0, radius: 1, element: 'Fire' };
    assert.equal(s.abilities.interceptProjectile(pr, 150, 166), true);
  }
  assert.equal(s.abilities.deflect, null);
  assert.ok(s.abilities.remaining('Deflect') > 0);
  assert.equal(s.abilities.interceptProjectile({ x: 40, y: 166, vx: -440, vy: 0, element: 'Fire' }, 150, 166), false);
  const held = scene('Air', 'Deflect');
  gather(held, 'Air', 20); held.abilities.cast('Deflect');
  held.input.activePointer.rightButtonDown = () => false;
  held.abilities.update(0.01);
  assert.equal(held.benders.Air.free.length, 20);
  assert.equal(held.abilities.deflect, null);
});

test('timed Air Deflect reflects more strongly and uses less air', () => {
  const early = scene('Air', 'Deflect'), late = scene('Air', 'Deflect');
  for (const s of [early, late]) { gather(s, 'Air', 20); s.abilities.cast('Deflect'); }
  late.abilities.update(0.4);
  const first = { x: 40, y: 166, vx: -500, vy: 0, radius: 6, element: 'Fire' };
  const second = { ...first };
  early.abilities.interceptProjectile(first, 180, 166);
  late.abilities.interceptProjectile(second, 180, 166);
  assert.ok(first.vx > second.vx && second.vx > 0);
  assert.ok(early.abilities.deflect.wisps.length > late.abilities.deflect.wisps.length);
});

test('Water Shield spends more water on stronger fire bolts and rewards timed blocks', () => {
  const early = scene('Water', 'Shield'), late = scene('Water', 'Shield');
  for (const s of [early, late]) { gather(s, 'Water', 24); s.abilities.cast('Shield'); }
  early.abilities.update(0.05); late.abilities.update(0.4);
  for (const s of [early, late]) {
    const pr = { x: 40, y: 166, vx: -700, vy: 0, radius: 12, visualR: 6, element: 'Fire' };
    s.projectiles.push(pr);
    assert.equal(s.abilities.interceptProjectile(pr, 180, 166), true);
    assert.equal(s.projectiles.length, 0);
  }
  assert.equal(early.benders.Water.free.length, 22);
  assert.equal(late.benders.Water.free.length, 20);
});

test('a depleted Water Shield weakens a large fire bolt without erasing it', () => {
  const s = scene('Water', 'Shield');
  gather(s, 'Water', 8); s.abilities.cast('Shield');
  s.benders.Water.free.splice(1); // simulate the other drops already evaporating
  s.abilities.update(0.4);
  const pr = { x: 40, y: 166, vx: -700, vy: 0, radius: 30, visualR: 10, element: 'Fire' };
  s.projectiles.push(pr);
  assert.equal(s.abilities.interceptProjectile(pr, 180, 166), true);
  assert.equal(s.projectiles[0], pr);
  assert.ok(pr.radius < 30 && pr.radius > 0 && Math.abs(pr.vx) < 700);
  assert.equal(s.benders.Water.free.length, 0);
  s.abilities.update(0.02);
  assert.equal(s.abilities.shield, null);
});

test('Water Shield allows outgoing projectiles to leave without consuming its drops', () => {
  const s = scene('Water', 'Shield');
  gather(s, 'Water', 24); s.abilities.cast('Shield'); s.abilities.update(0.05);
  const pr = { x: 150, y: 166, vx: 700, vy: 0, radius: 9, element: 'Fire' };
  s.projectiles.push(pr);
  assert.equal(s.abilities.interceptProjectile(pr, 40, 166), false);
  assert.equal(s.benders.Water.free.length, 24);
});

test('Water Shield intercepts a large bolt by its visible edge before its centre reaches the water', () => {
  const s = scene('Water', 'Shield');
  gather(s, 'Water', 24); s.abilities.cast('Shield'); s.abilities.update(0.05);
  const pr = { x: 85, y: 166, vx: -700, vy: 0, radius: 12, visualR: 10, element: 'Fire' };
  s.projectiles.push(pr);
  assert.equal(s.abilities.interceptProjectile(pr, 150, 166), true);
  assert.equal(s.projectiles.length, 0);
});

test('guards can catch or deflect falling world stone without duplicating its cell', () => {
  for (const action of ['Catch', 'Deflect']) {
    const s = scene(action === 'Catch' ? 'Earth' : 'Air', action);
    if (action === 'Deflect') gather(s, 'Air', 20);
    s.input.activePointer.worldX = 40; s.input.activePointer.worldY = 10;
    s.grid[s.idx(13, 38)] = MAT.STONE; s.life[s.idx(13, 38)] = 3;
    s.abilities.cast(action);
    assert.equal(s.abilities.interceptRigid({ fromX: 40, fromY: 111, toX: 40, toY: 114, speed: 220, mat: MAT.STONE }), true);
    assert.equal(s.grid[s.idx(13, 38)], MAT.EMPTY);
    if (action === 'Catch') assert.equal(s.benders.Earth.holding, 1);
    else { assert.equal(s.debris.length, 1); assert.ok(s.debris[0].vy < 0); }
  }
});

test('defenses stop intercepting immediately on release and retain remote visual collision authority', () => {
  for (const [element, action] of [['Earth', 'Catch'], ['Air', 'Deflect'], ['Water', 'Shield']]) {
    const s = scene(element, action);
    if (element !== 'Earth') gather(s, element, 24);
    s.abilities.cast(action);
    const pr = { x: 40, y: 166, vx: -700, vy: 0, element: 'Earth', radius: 6, visualOnly: true };
    assert.equal(s.abilities.interceptProjectile(pr, 180, 166), false);
    pr.visualOnly = false;
    s.input.activePointer.rightButtonDown = () => false;
    assert.equal(s.abilities.interceptProjectile(pr, 180, 166), false);
  }
});

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
    for (const [element, action] of [['Fire', 'Flamethrower'], ['Water', 'Shield'], ['Earth', 'Catch'], ['Air', 'Deflect']]) {
      const s = scene(element, action);
      if (element === 'Water') gather(s, 'Water', 12);
      if (element === 'Air') gather(s, 'Air', 12);
      s.abilities.cast(action);
      if (stop === 'wheel') s.bendWheelOpen = true;
      if (stop === 'element') s.bendElement = element === 'Earth' ? 'Fire' : 'Earth';
      if (stop === 'death') s.player.dead = true;
      s.abilities.update(0.02);
      assert.equal(s.abilities.channel, null);
      assert.ok(s.benders.Water.free.every((drop) => !drop.bendAbility));
    }
  }
});
