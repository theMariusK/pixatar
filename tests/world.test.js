const test = require('node:test');
const assert = require('node:assert/strict');
const PixelWorld = require('../world');

const { COLS, ROWS, MAT, World, generateWorld } = PixelWorld;
const SIZE = COLS * ROWS;
const idx = (x, y) => y * COLS + x;

test('world generation is deterministic for a seed and differs for another', () => {
  function snapshot(seed) {
    const world = new World();
    const info = generateWorld(world, seed);
    return {
      info,
      grid: Buffer.from(world.grid),
      life: Buffer.from(world.life),
      bg: Buffer.from(world.bg),
    };
  }

  const a = snapshot(123456);
  const b = snapshot(123456);
  const c = snapshot(654321);

  assert.deepEqual(a.grid, b.grid);
  assert.deepEqual(a.life, b.life);
  assert.deepEqual(a.bg, b.bg);
  assert.deepEqual(a.info, b.info);
  assert.notDeepEqual(a.grid, c.grid);
});

test('generated worlds have a bedrock shell and actually contain material', () => {
  const world = new World();
  generateWorld(world, 99);

  for (let x = 0; x < COLS; x++) {
    assert.equal(world.grid[idx(x, 0)], MAT.BEDROCK);
    assert.equal(world.grid[idx(x, ROWS - 1)], MAT.BEDROCK);
  }
  for (let y = 0; y < ROWS; y++) {
    assert.equal(world.grid[idx(0, y)], MAT.BEDROCK);
    assert.equal(world.grid[idx(COLS - 1, y)], MAT.BEDROCK);
  }

  let nonEmpty = 0;
  for (let i = 0; i < SIZE; i++) if (world.grid[i] !== MAT.EMPTY) nonEmpty++;
  assert.ok(nonEmpty > SIZE * 0.2, `expected terrain, got ${nonEmpty} cells`);
});

test('setCell applies material lifetimes and records dirty cells', () => {
  const world = new World({ trackDirty: true });

  world.setCell(10, MAT.FIRE);
  world.setCell(11, MAT.SMOKE);
  world.setCell(12, MAT.ICE);
  world.setCell(13, MAT.STONE);

  assert.equal(world.life[10], PixelWorld.FIRE_LIFE);
  assert.equal(world.life[11], PixelWorld.SMOKE_LIFE);
  assert.equal(world.life[12], 255);
  assert.equal(world.life[13], 0);
  for (const id of [10, 11, 12, 13]) assert.ok(world.dirty.has(id));
});

test('setCell caps custom lifetimes at one byte', () => {
  const world = new World();
  world.setCell(5, MAT.FIRE, 9999);
  assert.equal(world.life[5], 255);
});

test('swap moves material, life, fall state and dirty marks together', () => {
  const world = new World({ trackDirty: true });
  const a = idx(10, 10), b = idx(10, 11);
  world.setCell(a, MAT.STONE, 3);
  world.setCell(b, MAT.EMPTY, 0);
  world.falling[a] = 1;
  world.fallDistance[a] = 7;
  world.dirty.clear();

  world.swap(a, b);

  assert.equal(world.grid[b], MAT.STONE);
  assert.equal(world.grid[a], MAT.EMPTY);
  assert.equal(world.life[b], 3);
  assert.equal(world.falling[b], 1);
  assert.equal(world.fallDistance[b], 7);
  assert.ok(world.dirty.has(a));
  assert.ok(world.dirty.has(b));
});

test('support detection leaves border-connected rock up and drops floating rock', () => {
  const world = new World();
  const anchor = idx(5, ROWS - 1);
  const supported = idx(5, ROWS - 2);
  const floating = idx(50, 40);
  world.setCell(anchor, MAT.STONE);
  world.setCell(supported, MAT.STONE);
  world.setCell(floating, MAT.STONE);

  world.checkStructuralSupport();

  assert.equal(world.falling[anchor], 0);
  assert.equal(world.falling[supported], 0);
  assert.equal(world.falling[floating], 1);
});

test('a falling rigid cell moves down through open space', () => {
  const world = new World();
  const id = idx(20, 20);
  world.setCell(id, MAT.STONE);
  world.falling[id] = 1;

  world.simulate();

  assert.equal(world.grid[id], MAT.EMPTY);
  assert.equal(world.grid[idx(20, 21)], MAT.STONE);
});

test('sand falls and piles on solid ground', () => {
  const world = new World();
  const sand = idx(30, 28);
  world.setCell(idx(29, 30), MAT.STONE);
  world.setCell(idx(30, 30), MAT.STONE);
  world.setCell(idx(31, 30), MAT.STONE);
  world.setCell(sand, MAT.SAND);

  for (let i = 0; i < 5; i++) world.simulate();

  assert.equal(world.grid[sand], MAT.EMPTY);
  assert.equal(world.grid[idx(30, 29)], MAT.SAND);
  assert.equal(world.grid[idx(30, 30)], MAT.STONE);
});

test('segmentEntersRect reports entry but not an object already inside', () => {
  assert.equal(PixelWorld.segmentEntersRect(0, 5, 20, 5, 10, 0, 10, 10), true);
  assert.equal(PixelWorld.segmentEntersRect(15, 5, 20, 5, 10, 0, 10, 10), false);
  assert.equal(PixelWorld.segmentEntersRect(0, 50, 20, 50, 10, 0, 10, 10), false);
  assert.equal(PixelWorld.segmentRectEntry(15, 5, 20, 5, 10, 0, 10, 10), null);
  assert.equal(PixelWorld.segmentRectEntry(0, 50, 20, 50, 10, 0, 10, 10), null);
});

test('impactDamage ignores slow and non-rigid material but scales with speed', () => {
  assert.equal(PixelWorld.impactDamage(100, MAT.STONE), 0);
  assert.equal(PixelWorld.impactDamage(300, MAT.WATER), 0);
  assert.ok(PixelWorld.impactDamage(300, MAT.STONE) > PixelWorld.impactDamage(200, MAT.STONE));
});

test('the arena map produces a supported, playable Agni Kai arena', () => {
  const world = new World();
  const info = generateWorld(world, 777, { map: 'arena' });

  assert.ok(info.structures.includes('arena'));
  assert.equal(world.grid[idx(0, 0)], MAT.BEDROCK);
  assert.equal(world.grid[idx(COLS - 1, ROWS - 1)], MAT.BEDROCK);

  // The spawn column must be open sky above the raised fighting floor.
  let firstSolid = ROWS;
  for (let y = 1; y < ROWS - 1; y++) {
    if (world.grid[idx(COLS >> 1, y)] !== MAT.EMPTY) { firstSolid = y; break; }
  }
  assert.ok(firstSolid > 100, `arena floor should be low in the world, got row ${firstSolid}`);
  assert.notEqual(world.grid[idx(COLS >> 1, firstSolid)], MAT.LAVA);

  let gold = 0, lava = 0, brick = 0;
  for (let i = 0; i < SIZE; i++) {
    if (world.grid[i] === MAT.GOLD) gold++;
    else if (world.grid[i] === MAT.LAVA) lava++;
    else if (world.grid[i] === MAT.BRICK) brick++;
  }
  assert.ok(gold > 20, `expected gold trim, got ${gold}`);
  assert.ok(lava > 0, 'expected lava braziers');
  assert.ok(brick > 1000, `expected a built arena, got ${brick} brick cells`);

  world.checkStructuralSupport();
  let floating = 0;
  for (let i = 0; i < SIZE; i++) if (world.falling[i]) floating++;
  assert.equal(floating, 0, 'arena decorations must all be supported');
});

test('arena generation is deterministic for a seed', () => {
  const a = new World();
  const b = new World();
  generateWorld(a, 2024, { map: 'arena' });
  generateWorld(b, 2024, { map: 'arena' });
  assert.deepEqual(Buffer.from(a.grid), Buffer.from(b.grid));
  assert.deepEqual(Buffer.from(b.bg), Buffer.from(a.bg));
});

test('the three extra maps generate supported, distinct worlds', () => {
  const cases = [
    ['sky', MAT.SANDSTONE, MAT.BRICK, null],
    ['north', MAT.SNOW, MAT.PACKED_ICE, MAT.WATER],
    ['caldera', MAT.LAVA, MAT.BRICK, MAT.GOLD],
  ];
  for (const [map, matA, matB, matC] of cases) {
    const world = new World();
    const info = generateWorld(world, 5150, { map });

    assert.ok(info.structures.length > 0, `${map} should name its signature structure`);
    assert.equal(info.structures[0], map === 'sky' ? 'sky-temple' : map === 'north' ? 'frozen-north' : 'caldera');
    assert.equal(world.grid[idx(0, 0)], MAT.BEDROCK);
    assert.equal(world.grid[idx(COLS - 1, ROWS - 1)], MAT.BEDROCK);

    const counts = new Map();
    for (let i = 0; i < SIZE; i++) counts.set(world.grid[i], (counts.get(world.grid[i]) || 0) + 1);
    assert.ok((counts.get(matA) || 0) > 0, `${map} is missing signature material ${matA}`);
    assert.ok((counts.get(matB) || 0) > 0, `${map} is missing signature material ${matB}`);
    if (matC !== null) assert.ok((counts.get(matC) || 0) > 0, `${map} is missing signature material ${matC}`);

    // Spawn falls onto solid, safe ground at the centre column.
    let firstSolid = ROWS;
    for (let y = 1; y < ROWS - 1; y++) {
      if (world.grid[idx(COLS >> 1, y)] !== MAT.EMPTY) { firstSolid = y; break; }
    }
    assert.ok(firstSolid < ROWS - 1, `${map} has no floor under spawn`);
    assert.notEqual(world.grid[idx(COLS >> 1, firstSolid)], MAT.LAVA, `${map} spawns onto lava`);

    world.checkStructuralSupport();
    let floating = 0;
    for (let i = 0; i < SIZE; i++) if (world.falling[i]) floating++;
    assert.equal(floating, 0, `${map} must not collapse on load`);
  }
});

test('extra maps are deterministic for a seed', () => {
  for (const map of ['sky', 'north', 'caldera']) {
    const a = new World();
    const b = new World();
    generateWorld(a, 31415, { map });
    generateWorld(b, 31415, { map });
    assert.deepEqual(Buffer.from(a.grid), Buffer.from(b.grid), `${map} grid must be deterministic`);
    assert.deepEqual(Buffer.from(a.bg), Buffer.from(b.bg), `${map} backdrop must be deterministic`);
  }
});

test('the sky temple uses clouds and tall pagoda silhouettes', () => {
  const world = new World();
  generateWorld(world, 5150, { map: 'sky' });

  let clouds = 0, gold = 0, glass = 0;
  for (let i = 0; i < SIZE; i++) {
    if (world.bg[i] === PixelWorld.BG.CLOUD) clouds++;
    if (world.grid[i] === MAT.GOLD) gold++;
    if (world.grid[i] === MAT.GLASS) glass++;
  }
  assert.ok(clouds > 1000, `expected cloud banks, got ${clouds} cells`);
  assert.ok(gold > 20, `expected gold temple trim, got ${gold}`);
  assert.ok(glass > 20, `expected pagoda windows, got ${glass}`);

  // The main towers should rise far above the courtyard.
  let highest = ROWS;
  for (let y = 1; y < ROWS - 1; y++) {
    for (let x = 0; x < COLS; x++) {
      if (world.grid[idx(x, y)] !== MAT.EMPTY) { highest = Math.min(highest, y); break; }
    }
  }
  assert.ok(highest < 110, `expected a tall temple skyline, got top row ${highest}`);
});

test('sky temple main pagodas have walk-in shrine halls', () => {
  const world = new World();
  generateWorld(world, 5150, { map: 'sky' });
  const courtY = 198, bodyBottom = courtY - 4;

  // Both main pagodas: solid side walls with passable timber doors, hollow hall,
  // and the right-hand side left free for the altar.
  for (const px of [235, 325]) {
    assert.equal(world.grid[idx(px, bodyBottom - 4)], MAT.EMPTY, 'hall interior');
    assert.equal(world.bg[idx(px, bodyBottom - 4)], PixelWorld.BG.SANDSTONE, 'hall background');
    assert.equal(world.grid[idx(px - 14, bodyBottom - 4)], MAT.TIMBER, 'left door');
    assert.equal(world.grid[idx(px + 14, bodyBottom - 4)], MAT.TIMBER, 'right door');
    assert.equal(world.grid[idx(px + 5, bodyBottom)], MAT.SANDSTONE, 'hall altar');
    // The lowest eave is above head height outside both doors.
    for (const side of [-1, 1]) {
      assert.equal(world.grid[idx(px + side * 15, bodyBottom - 10)], MAT.EMPTY, 'door headroom');
    }
  }

  // The exterior climbing scaffold has been removed.
  assert.equal(world.grid[idx(203, 120)], MAT.EMPTY, 'no climbing support pole');
});
