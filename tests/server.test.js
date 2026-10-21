const test = require('node:test');
const assert = require('node:assert/strict');
const WebSocket = require('ws');
const PixelWorld = require('../world');
const { startServer } = require('../server');

const { COLS, ROWS, MAT } = PixelWorld;
const SIZE = COLS * ROWS;
const WORLD_PX_W = COLS * 3;
const WORLD_PX_H = ROWS * 3;

let server;
let url;

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// Minimal protocol client: queues messages until a test asks for one by type.
function connect() {
  const ws = new WebSocket(url);
  const queue = [];
  const waiters = [];
  let closed = false;

  ws.on('message', (raw) => {
    let msg;
    try { msg = JSON.parse(raw.toString()); } catch (e) { return; }
    const at = waiters.findIndex((w) => w.type === msg.t);
    if (at === -1) { queue.push(msg); return; }
    const [waiter] = waiters.splice(at, 1);
    clearTimeout(waiter.timer);
    waiter.resolve(msg);
  });
  ws.on('close', () => {
    closed = true;
    for (const waiter of waiters.splice(0)) {
      clearTimeout(waiter.timer);
      waiter.reject(new Error(`socket closed before ${waiter.type}`));
    }
  });

  function next(type, timeoutMs = 3000) {
    const at = queue.findIndex((msg) => msg.t === type);
    if (at !== -1) return Promise.resolve(queue.splice(at, 1)[0]);
    if (closed) return Promise.reject(new Error(`socket closed before ${type}`));
    return new Promise((resolve, reject) => {
      const waiter = { type, resolve, reject, timer: null };
      waiter.timer = setTimeout(() => {
        const i = waiters.indexOf(waiter);
        if (i !== -1) waiters.splice(i, 1);
        reject(new Error(`timed out waiting for ${type}`));
      }, timeoutMs);
      waiters.push(waiter);
    });
  }

  return new Promise((resolve, reject) => {
    ws.once('open', () => resolve({
      ws,
      next,
      send(obj) { ws.send(JSON.stringify(obj)); },
      close() {
        return new Promise((done) => {
          if (ws.readyState === ws.CLOSED) return done();
          ws.once('close', done);
          ws.close();
        });
      },
    }));
    ws.once('error', reject);
  });
}

async function createRoom(name) {
  const client = await connect();
  await client.next('rooms');
  client.send({ t: 'create', name });
  const joined = await client.next('joined');
  return { client, joined, roomId: joined.roomId };
}

async function joinRoom(roomId) {
  const client = await connect();
  await client.next('rooms');
  client.send({ t: 'join', roomId });
  const joined = await client.next('joined');
  return { client, joined };
}

async function nextPlayersCount(client, count) {
  for (let i = 0; i < 20; i++) {
    const players = await client.next('players');
    if (Object.keys(players.players).length === count) return players;
  }
  throw new Error(`never saw a players message with ${count} entries`);
}

function findCell(world, mat) {
  for (let y = 2; y < ROWS - 2; y++) {
    for (let x = 2; x < COLS - 2; x++) {
      const id = y * COLS + x;
      if (world.grid[id] === mat) return id;
    }
  }
  return -1;
}

// Deltas also carry simulation churn, so keep reading until the batch that
// includes the cell under test arrives.
async function nextDeltaFor(client, id) {
  for (let i = 0; i < 20; i++) {
    const delta = await client.next('delta');
    if (delta.cells.some((cell) => cell[0] === id)) return delta;
  }
  throw new Error(`no delta contained cell ${id}`);
}

test.before(async () => {
  server = await startServer({ port: 0, seed: 424242, quiet: true });
  url = `ws://127.0.0.1:${server.port}`;
});

test.after(async () => {
  if (server) await server.close();
});

test('create, join and leave keep membership and host ownership in sync', async () => {
  const a = await createRoom('Arena');
  assert.match(a.roomId, /^[A-Z2-9]{4}$/);
  assert.equal(Object.keys(a.joined.players).length, 1);
  assert.equal(Buffer.from(a.joined.grid, 'base64').length, SIZE);
  assert.equal(Buffer.from(a.joined.life, 'base64').length, SIZE);
  assert.equal(Buffer.from(a.joined.bg, 'base64').length, SIZE);

  const b = await joinRoom(a.roomId);
  assert.equal(Object.keys(b.joined.players).length, 2);
  assert.ok(b.joined.players[a.joined.id]);
  assert.ok(b.joined.players[b.joined.id]);

  const players = await nextPlayersCount(a.client, 2);
  assert.equal(Object.keys(players.players).length, 2);

  const room = server.rooms.get(a.roomId);
  assert.equal(room.hostId, a.joined.id);

  await a.client.close();
  assert.equal((await b.client.next('leave')).id, a.joined.id);
  await b.client.next('players');
  await delay(30);
  assert.equal(room.hostId, b.joined.id);

  await b.client.close();
  await delay(30);
  assert.equal(room.players.size, 0);
  assert.ok(room.emptySince > 0);
});

test('cell writes reach every client, while bedrock cannot be created or destroyed', async () => {
  const { client, roomId } = await createRoom('Cells');
  const room = server.rooms.get(roomId);

  // Pick a sky cell so the simulation is unlikely to touch it during assertions.
  const emptyId = findCell(room.world, MAT.EMPTY);
  assert.ok(emptyId >= 0);

  client.send({ t: 'cells', cells: [[emptyId, MAT.STONE, 0]] });
  const delta = await nextDeltaFor(client, emptyId);
  const written = delta.cells.find((cell) => cell[0] === emptyId);
  assert.ok(written, 'expected the written cell in the delta');
  assert.equal(written[1], MAT.STONE);
  assert.equal(room.world.grid[emptyId], MAT.STONE);

  // The border is bedrock and must survive a client claiming otherwise.
  const borderId = 0;
  assert.equal(room.world.grid[borderId], MAT.BEDROCK);
  client.send({ t: 'cells', cells: [[borderId, MAT.EMPTY, 0]] });
  await delay(60);
  assert.equal(room.world.grid[borderId], MAT.BEDROCK);

  // Clients cannot manufacture bedrock in open space either.
  const createId = findCell(room.world, MAT.EMPTY);
  client.send({ t: 'cells', cells: [[createId, MAT.BEDROCK, 0]] });
  await delay(60);
  assert.notEqual(room.world.grid[createId], MAT.BEDROCK);

  await client.close();
});

test('malformed cell writes are ignored without taking the server down', async () => {
  const { client, roomId } = await createRoom('BadCells');
  const room = server.rooms.get(roomId);
  const probe = findCell(room.world, MAT.EMPTY);

  client.send({
    t: 'cells',
    cells: [
      null,
      ['nope'],
      [-1, MAT.STONE],
      [SIZE, MAT.STONE],
      [probe, 9999, 0],
      [probe + 1, MAT.STONE, 0],
    ],
  });

  // A later valid message still works, proving the handler survived.
  const valid = findCell(room.world, MAT.EMPTY);
  client.send({ t: 'cells', cells: [[valid, MAT.WOOD, 0]] });
  const delta = await nextDeltaFor(client, valid);
  assert.ok(delta.cells.some((cell) => cell[0] === valid && cell[1] === MAT.WOOD));

  await client.close();
});

test('input positions, health and liquid are clamped to safe values', async () => {
  const { client, joined, roomId } = await createRoom('Sanitize');
  const room = server.rooms.get(roomId);
  const player = room.players.get(joined.id);

  client.send({
    t: 'input',
    x: 1e12,
    y: -9999,
    facing: 0,
    liquid: 'magma',
    health: 999,
    rotation: 1e6,
  });
  await delay(50);

  assert.equal(player.x, WORLD_PX_W);
  assert.equal(player.y, 0);
  assert.equal(player.facing, 1);
  assert.equal(player.liquid, null);
  assert.equal(player.health, 100);
  assert.equal(player.rotation, Math.PI * 8);

  client.send({ t: 'input', x: 123, y: 456, health: -4 });
  await delay(50);
  assert.equal(player.x, 123);
  assert.equal(player.y, 456);
  assert.equal(player.health, 0);

  await client.close();
});

test('hits are relayed only to the target and every field is bounded', async () => {
  const a = await createRoom('Hits');
  const b = await joinRoom(a.roomId);
  await a.client.next('players');

  a.client.send({
    t: 'hit',
    target: b.joined.id,
    element: 'Fire',
    amount: 9999,
    effects: [{ name: 'Burn' }, { name: 'Burn' }, { name: 'Burn' }, { name: 'Burn' }, { name: 'Burn' }],
    bend: { wetMs: 9999, burnMs: 9999, ix: 9999, iy: -9999 },
  });

  const hit = await b.client.next('hit');
  assert.equal(hit.from, a.joined.id);
  assert.equal(hit.amount, 120);
  assert.equal(hit.bend.wetMs, 1000);
  assert.equal(hit.bend.burnMs, 2500);
  assert.equal(hit.bend.ix, 240);
  assert.equal(hit.bend.iy, -260);
  assert.equal(hit.effects.length, 4);

  // Self-hits are dropped, so the target sees no second message.
  a.client.send({ t: 'hit', target: a.joined.id, amount: 10 });
  await assert.rejects(b.client.next('hit', 150), /timed out/);

  await a.client.close();
  await b.client.close();
});

test('cast visuals are relayed to the room but never back to the caster', async () => {
  const a = await createRoom('Casts');
  const b = await joinRoom(a.roomId);
  await a.client.next('players');

  a.client.send({
    t: 'cast', element: 'Fire', form: 'Bolt', modifier: null,
    ox: 10, oy: 20, tx: 30, ty: 40, r: 999,
  });

  const cast = await b.client.next('cast');
  assert.equal(cast.id, a.joined.id);
  assert.equal(cast.r, 40);
  await assert.rejects(a.client.next('cast', 150), /timed out/);

  await a.client.close();
  await b.client.close();
});
