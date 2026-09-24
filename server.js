// Authoritative multiplayer server for the falling-sand demo.
// Run with: node server.js
// It generates and simulates each room's world (world.js — the same rules the
// client runs in single-player) and relays player positions + world-cell deltas
// over WebSockets. Set SEED=<number> to give every new room the same world.

const { WebSocketServer } = require('ws');
const PixelWorld = require('./world');

const { COLS, ROWS, MAT, MAT_COUNT, FIRE_LIFE, SMOKE_LIFE, ICE_LIFE, IS_RIGID, FLAMMABILITY, DEFAULT_BODY_SCALE } = PixelWorld;
const PLAYER_BODY_W = 10 * DEFAULT_BODY_SCALE;
const PLAYER_BODY_H = 16 * DEFAULT_BODY_SCALE;
const { EMPTY, SAND, WATER, STONE, WOOD, FIRE, SMOKE, BEDROCK, LAVA, ACID, GAS, ICE, GRASS, SNOW, OIL } = MAT;

// Each room owns an independent world. The helpers below read and write `W`, the
// world currently being handled, so they stay written once and simply run once
// per room. The simulation itself lives on the World (world.js).
function makeWorld() {
  return new PixelWorld.World({ trackDirty: true });
}
let W = null;

function idx(x, y) {
  return y * COLS + x;
}

function setCell(id, mat, customLife) {
  W.setCell(id, mat, customLife);
}

function digCircle(gx, gy, r) {
  for (let dy = -r; dy <= r; dy++) {
    for (let dx = -r; dx <= r; dx++) {
      if (dx * dx + dy * dy > r * r) continue;
      const x = gx + dx, y = gy + dy;
      if (x <= 0 || x >= COLS - 1 || y <= 0 || y >= ROWS - 1) continue;
      const id = idx(x, y);
      if (W.grid[id] === BEDROCK) continue;
      setCell(id, EMPTY);
    }
  }
}

function explode(gx, gy, r) {
  const outer = r + Math.round(r * 0.4) + 2;
  for (let dy = -outer; dy <= outer; dy++) {
    for (let dx = -outer; dx <= outer; dx++) {
      const dist = Math.sqrt(dx * dx + dy * dy);
      if (dist > outer) continue;
      const x = gx + dx, y = gy + dy;
      if (x <= 0 || x >= COLS - 1 || y <= 0 || y >= ROWS - 1) continue;
      const id = idx(x, y);
      if (W.grid[id] === BEDROCK) continue;
      if (dist <= r) {
        const rim = dist / r;
        const fireChance = 0.2 + rim * 0.6;
        if (Math.random() < fireChance) setCell(id, FIRE, FIRE_LIFE * 2.2);
        else setCell(id, EMPTY);
      } else {
        const t = (dist - r) / (outer - r);
        if (Math.random() < 0.6 * (1 - t)) setCell(id, FIRE, FIRE_LIFE * 1.6);
      }
    }
  }
}

// Materials a client is allowed to place. STONE was missing here while the client
// offered it on the number keys, so stone placed in multiplayer existed only on the
// placer's machine forever — the server silently dropped it and never sent a delta
// to correct it. ICE is the spell system's frozen water and must be here too.
const PLACEABLE = new Set([SAND, WATER, FIRE, WOOD, LAVA, ACID, GAS, STONE, ICE, OIL, SNOW]);

function placeCircle(gx, gy, r, mat, life) {
  if (!PLACEABLE.has(mat)) return;
  for (let dy = -r; dy <= r; dy++) {
    for (let dx = -r; dx <= r; dx++) {
      if (dx * dx + dy * dy > r * r) continue;
      const x = gx + dx, y = gy + dy;
      if (x <= 0 || x >= COLS - 1 || y <= 0 || y >= ROWS - 1) continue;
      const id = idx(x, y);
      const cur = W.grid[id];
      if (mat === FIRE) {
        if (cur === EMPTY || (FLAMMABILITY[cur] > 0 && cur !== GRASS)) setCell(id, FIRE, life);
      } else if (mat === ICE) {
        // Ice forms over water as well as empty space: freezing a pool solid is the
        // whole point of an ice wall.
        if (cur === EMPTY || cur === WATER) setCell(id, ICE, life || ICE_LIFE);
      } else if (cur === EMPTY) {
        setCell(id, mat, life);
      }
    }
  }
}

// A client's computed cell writes, applied verbatim. Bounded per message and
// validated, because this arrives from the network.
const MAX_CELLS_PER_OP = 1200;

function applyCells(cells) {
  if (!Array.isArray(cells)) return;
  const n = Math.min(cells.length, MAX_CELLS_PER_OP);
  for (let i = 0; i < n; i++) {
    const c = cells[i];
    if (!Array.isArray(c) || c.length < 2) continue;
    const id = c[0] | 0;
    const mat = c[1] | 0;
    const lifeVal = c[2] | 0;
    if (id < 0 || id >= COLS * ROWS) continue;
    if (mat < 0 || mat >= MAT_COUNT) continue;
    // Bedrock stays indestructible regardless of what a client claims.
    if (W.grid[id] === BEDROCK && mat !== BEDROCK) continue;
    setCell(id, mat, mat === BEDROCK ? undefined : lifeVal);
  }
}

// Water spells extinguish rather than burn. Mirrors the client's douseCell exactly,
// so a flood looks the same for everyone.
function douseCircle(gx, gy, r) {
  for (let dy = -r; dy <= r; dy++) {
    for (let dx = -r; dx <= r; dx++) {
      if (dx * dx + dy * dy > r * r) continue;
      const x = gx + dx, y = gy + dy;
      if (x <= 0 || x >= COLS - 1 || y <= 0 || y >= ROWS - 1) continue;
      const id = idx(x, y);
      const m = W.grid[id];
      if (m === FIRE) setCell(id, SMOKE, SMOKE_LIFE);
      else if (m === LAVA) setCell(id, STONE);
      else if (m === EMPTY) setCell(id, WATER);
    }
  }
}

// Earth spells bring down terrain that was already barely holding on. Uses the same
// support map the periodic collapse pass maintains.
function shockCircle(gx, gy, r) {
  for (let dy = -r; dy <= r; dy++) {
    for (let dx = -r; dx <= r; dx++) {
      if (dx * dx + dy * dy > r * r) continue;
      const x = gx + dx, y = gy + dy;
      if (x <= 0 || x >= COLS - 1 || y <= 0 || y >= ROWS - 1) continue;
      const id = idx(x, y);
      const m = W.grid[id];
      if (IS_RIGID[m] && !W.visited[id]) W.falling[id] = 1;
    }
  }
}

// ---------------------------------------------------------------------------
// rooms
// ---------------------------------------------------------------------------
//
// Every room owns an independent world, so one server hosts many separate games.
// A connected client starts in the lobby (no room); creating or joining puts it in
// a room and only then does it receive a world.

const PORT = process.env.PORT || 8080;
const wss = new WebSocketServer({ port: PORT });

const PLAYER_COLORS = [0xff6b6b, 0x6bffb8, 0xffe66b, 0xb56bff, 0x6bd4ff, 0xff9f6b, 0xff6bd4, 0x9bff6b];
const VALID_LIQUIDS = new Set(['water', 'lava', 'acid', 'oil']);
let nextId = 1;

// Ambiguous glyphs (I, O, 0, 1) are left out — these codes get read aloud and typed
// by hand, and a code you cannot retype is useless.
const ROOM_CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const ROOM_CODE_LENGTH = 4;
const MAX_PLAYERS_PER_ROOM = 8;
const MAX_ROOMS = 32;
const EMPTY_ROOM_TTL_MS = 20000;

const rooms = new Map();       // code -> room
const lobbyClients = new Set(); // sockets not currently in a room

function makeRoomCode() {
  for (let attempt = 0; attempt < 200; attempt++) {
    let code = '';
    for (let i = 0; i < ROOM_CODE_LENGTH; i++) {
      code += ROOM_CODE_ALPHABET[(Math.random() * ROOM_CODE_ALPHABET.length) | 0];
    }
    if (!rooms.has(code)) return code;
  }
  return null;
}

function createRoom(name, hostWs) {
  const code = makeRoomCode();
  if (!code) return null;
  const room = {
    id: code,
    name: String(name || '').slice(0, 24) || `Room ${code}`,
    hostId: hostWs.playerId,
    createdAt: Date.now(),
    emptySince: 0,
    players: new Map(),   // playerId -> { id, ws, x, y, facing, liquid, color, health, corpse state }
    world: makeWorld(),
  };
  // Generate this room's terrain into its own world.
  const seedEnv = process.env.SEED;
  const info = PixelWorld.generateWorld(room.world, seedEnv !== undefined && seedEnv !== '' ? Number(seedEnv) >>> 0 : undefined);
  room.world.onRigidImpact = (hit) => {
    const amount = PixelWorld.impactDamage(hit.speed, hit.mat);
    if (amount <= 0) return;
    const now = Date.now();
    for (const player of room.players.values()) {
      if (player.dead || player.health <= 0 || (player._fallHitUntil || 0) > now) continue;
      if (!PixelWorld.segmentEntersRect(hit.fromX, hit.fromY, hit.toX, hit.toY,
        player.x, player.y, PLAYER_BODY_W, PLAYER_BODY_H, 1.65)) continue;
      player._fallHitUntil = now + 220;
      sendTo(player.ws, {
        t: 'hit', from: 'falling-world', element: 'Impact',
        amount: Math.round(amount * 10) / 10, effects: null,
      });
    }
  };
  console.log(`room ${code} world seed ${info.seed}: ${info.regions.map((r) => r.biome).join(' / ')} | ${info.structures.join(', ')}`);
  rooms.set(code, room);
  return room;
}

function roomSummary(room) {
  return {
    id: room.id,
    name: room.name,
    players: room.players.size,
    max: MAX_PLAYERS_PER_ROOM,
    host: room.players.has(room.hostId) ? room.hostId : '—',
  };
}

function roomListPayload() {
  return { t: 'rooms', rooms: [...rooms.values()].map(roomSummary) };
}

function sendTo(ws, obj) {
  if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(obj));
}

function pushRoomList() {
  const payload = JSON.stringify(roomListPayload());
  for (const ws of lobbyClients) {
    if (ws.readyState === ws.OPEN) ws.send(payload);
  }
}

function broadcastToRoom(room, obj, exceptId) {
  const data = JSON.stringify(obj);
  for (const p of room.players.values()) {
    if (p.ws.readyState === p.ws.OPEN && p.id !== exceptId) p.ws.send(data);
  }
}

function serializePlayers(room) {
  const out = {};
  for (const [id, p] of room.players) {
    out[id] = {
      x: p.x, y: p.y, facing: p.facing, liquid: p.liquid,
      color: p.color, health: p.health, dead: p.dead, burning: p.burning, rotation: p.rotation,
    };
  }
  return out;
}

function toBase64(u8) {
  return Buffer.from(u8.buffer, u8.byteOffset, u8.byteLength).toString('base64');
}

function joinRoom(room, ws) {
  if (room.players.size >= MAX_PLAYERS_PER_ROOM) {
    sendTo(ws, { t: 'error', message: 'That room is full.' });
    return false;
  }
  const id = ws.playerId;
  room.players.set(id, {
    id, ws,
    x: (COLS / 2) * 3, y: 2 * 3,
    facing: 1, liquid: null, color: ws.color, health: 100,
    dead: false, burning: false, rotation: 0,
  });
  room.emptySince = 0;
  ws.room = room;
  lobbyClients.delete(ws);

  sendTo(ws, {
    t: 'joined',
    roomId: room.id,
    roomName: room.name,
    id,
    color: ws.color,
    grid: toBase64(room.world.grid),
    life: toBase64(room.world.life),
    bg: toBase64(room.world.bg),
    players: serializePlayers(room),
  });
  broadcastToRoom(room, { t: 'players', players: serializePlayers(room) });
  pushRoomList();
  console.log(`${id} joined room ${room.id} "${room.name}" (${room.players.size} in room)`);
  return true;
}

function leaveRoom(ws) {
  const room = ws.room;
  if (!room) return;
  room.players.delete(ws.playerId);
  ws.room = null;
  broadcastToRoom(room, { t: 'leave', id: ws.playerId });
  broadcastToRoom(room, { t: 'players', players: serializePlayers(room) });
  if (room.players.size === 0) room.emptySince = Date.now();
  // The host leaving hands the room to whoever is left, otherwise the room would
  // keep advertising a host that is not in it.
  if (room.hostId === ws.playerId && room.players.size > 0) {
    room.hostId = room.players.keys().next().value;
  }
  lobbyClients.add(ws);
  pushRoomList();
  console.log(`${ws.playerId} left room ${room.id} (${room.players.size} left)`);
}

wss.on('connection', (ws) => {
  const numId = nextId++;
  ws.playerId = String(numId);
  ws.color = PLAYER_COLORS[(numId - 1) % PLAYER_COLORS.length];
  ws.room = null;
  lobbyClients.add(ws);

  // Lobby clients get the room list immediately so the browser has something to show.
  sendTo(ws, roomListPayload());
  console.log(`player ${ws.playerId} connected (lobby: ${lobbyClients.size})`);

  ws.on('message', (raw) => {
    let msg;
    try { msg = JSON.parse(raw); } catch (e) { return; }

    // -- lobby operations, valid before joining anything --
    if (msg.t === 'list') {
      sendTo(ws, roomListPayload());
      return;
    }
    if (msg.t === 'create') {
      if (ws.room) leaveRoom(ws);
      if (rooms.size >= MAX_ROOMS) { sendTo(ws, { t: 'error', message: 'Server is at room capacity.' }); return; }
      const room = createRoom(msg.name, ws);
      if (!room) { sendTo(ws, { t: 'error', message: 'Could not allocate a room code.' }); return; }
      joinRoom(room, ws);
      return;
    }
    if (msg.t === 'join') {
      const wanted = String(msg.roomId || '').toUpperCase().trim();
      const room = rooms.get(wanted);
      if (!room) { sendTo(ws, { t: 'error', message: `No room "${wanted}".` }); return; }
      if (ws.room === room) return;
      if (ws.room) leaveRoom(ws);
      joinRoom(room, ws);
      return;
    }

    // -- everything below needs a room --
    const room = ws.room;
    if (!room) return;
    const p = room.players.get(ws.playerId);
    if (!p) return;
    W = room.world;   // aim the simulation helpers at this room's world

    if (msg.t === 'input') {
      p.x = +msg.x || 0;
      p.y = +msg.y || 0;
      p.facing = msg.facing === -1 ? -1 : 1;
      p.liquid = VALID_LIQUIDS.has(msg.liquid) ? msg.liquid : null;
      // Self-reported health. Each client owns its own, so this is how everyone else
      // learns it; bounded because it arrives from the network.
      if (msg.health !== undefined) p.health = Math.min(Math.max(+msg.health || 0, 0), 100);
      p.dead = msg.dead === true;
      p.burning = msg.burning === true;
      const rotation = +msg.rotation;
      p.rotation = Number.isFinite(rotation) ? Math.max(-Math.PI * 8, Math.min(Math.PI * 8, rotation)) : 0;
    } else if (msg.t === 'dig') {
      digCircle(msg.gx | 0, msg.gy | 0, Math.min(Math.max(msg.r | 0, 1), 12));
    } else if (msg.t === 'place') {
      placeCircle(msg.gx | 0, msg.gy | 0, Math.min(Math.max(msg.r | 0, 1), 12), msg.mat | 0, msg.life | 0 || undefined);
    } else if (msg.t === 'explode') {
      explode(msg.gx | 0, msg.gy | 0, Math.min(Math.max(msg.r | 0, 1), 40));
    } else if (msg.t === 'douse') {
      douseCircle(msg.gx | 0, msg.gy | 0, Math.min(Math.max(msg.r | 0, 1), 14));
    } else if (msg.t === 'shock') {
      shockCircle(msg.gx | 0, msg.gy | 0, Math.min(Math.max(msg.r | 0, 1), 16));
    } else if (msg.t === 'cells') {
      // Explicit cell writes from a casting client. The caster has already computed
      // the exact result locally; applying the same values here is what keeps every
      // client identical, where re-running the spell would have re-rolled the
      // randomness and produced a different crater on the server than on screen.
      applyCells(msg.cells);
    } else if (msg.t === 'hit') {
      // Player-versus-player damage is reported by the attacker and applied by the
      // victim, who is the only authority on their own health. Routed to exactly one
      // client, and bounded, because it arrives from the network.
      const targetId = room.players.has(String(msg.target || '')) ? String(msg.target) : null;
      if (targetId && targetId !== ws.playerId) {
        const victim = room.players.get(targetId);
        sendTo(victim.ws, {
          t: 'hit',
          from: ws.playerId,
          element: typeof msg.element === 'string' ? msg.element.slice(0, 12) : 'Arcane',
          amount: Math.min(Math.max(+msg.amount || 0, 0), 120),
          effects: Array.isArray(msg.effects) ? msg.effects.slice(0, 4) : null,
        });
      }
    } else if (msg.t === 'blastImpulse') {
      const x = +msg.x, y = +msg.y, radius = +msg.radius, strength = +msg.strength;
      if (![x, y, radius, strength].every(Number.isFinite)
        || x < 0 || x > COLS * 3 || y < 0 || y > ROWS * 3
        || radius < 1 || radius > 600 || strength < 0 || strength > 420) return;
      broadcastToRoom(room, {
        t: 'blastImpulse', from: ws.playerId, x, y, radius, strength,
        element: msg.element === 'Fire' ? 'Fire' : 'Arcane',
      }, ws.playerId);
    } else if (msg.t === 'cast') {
      // Pure visual relay to everyone in the room EXCEPT the caster, who has already
      // drawn their own cast at full fidelity. No simulation.
      broadcastToRoom(room, {
        t: 'cast',
        id: ws.playerId,
        element: typeof msg.element === 'string' ? msg.element.slice(0, 12) : 'Arcane',
        form: typeof msg.form === 'string' ? msg.form.slice(0, 12) : 'Bolt',
        modifier: typeof msg.modifier === 'string' ? msg.modifier.slice(0, 12) : null,
        ox: +msg.ox || 0, oy: +msg.oy || 0,
        tx: +msg.tx || 0, ty: +msg.ty || 0,
        r: Math.min(Math.max(msg.r | 0, 1), 40),
      }, ws.playerId);
    } else if (msg.t === 'settle') {
      const gx = msg.gx | 0, gy = msg.gy | 0, mat = msg.mat | 0;
      if (gx > 0 && gx < COLS - 1 && gy > 0 && gy < ROWS - 1
        && (mat === SAND || mat === ICE || IS_RIGID[mat])) {
        const cellId = idx(gx, gy);
        if (W.grid[cellId] !== BEDROCK) setCell(cellId, mat);
      }
    }
  });

  ws.on('close', () => {
    lobbyClients.delete(ws);
    leaveRoom(ws);
    console.log(`player ${ws.playerId} disconnected`);
  });
});

// One tick drives every room. Rooms with nobody in them are skipped entirely — they
// are about to be reaped, and simulating an empty world is pure waste.
const SIM_STEP = 1000 / 40;

setInterval(() => {
  for (const room of rooms.values()) {
    if (room.players.size === 0) continue;
    W = room.world;
    W.simulate();
    if (W.dirty.size) {
      const cells = [];
      for (const id of W.dirty) cells.push([id, W.grid[id], W.life[id]]);
      W.dirty.clear();
      broadcastToRoom(room, { t: 'delta', cells });
    }
  }
}, SIM_STEP);

setInterval(() => {
  for (const room of rooms.values()) {
    if (room.players.size === 0) continue;
    broadcastToRoom(room, { t: 'players', players: serializePlayers(room) });
  }
}, 50);

setInterval(() => {
  for (const room of rooms.values()) {
    if (room.players.size === 0) continue;
    W = room.world;
    W.checkStructuralSupport();
  }
}, 120);

// Reap rooms nobody has come back to. The grace period matters: it covers the moment
// between a host creating a room and their game scene actually connecting to it.
setInterval(() => {
  const now = Date.now();
  for (const [code, room] of rooms) {
    if (room.players.size === 0 && room.emptySince && now - room.emptySince > EMPTY_ROOM_TTL_MS) {
      rooms.delete(code);
      console.log(`room ${code} expired`);
    }
  }
  pushRoomList();
}, 5000);

console.log(`Falling-sand multiplayer server listening on ws://localhost:${PORT}`);
console.log(`rooms are independent worlds; ${MAX_PLAYERS_PER_ROOM} players each, ${MAX_ROOMS} rooms max`);
