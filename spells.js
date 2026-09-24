// Spell system: 6 elements x 8 forms x 8 modifiers, plus the named abilities from
// abilities.md.
//
// The organising idea is that SHAPE IS SHARED and SUBSTANCE IS DELEGATED:
//
//   - The generic form layer below owns geometry only. Where a bolt flies, how a beam
//     raycasts, how a ground wave advances, how orbit embers tick. Six elements cast
//     bolts by running the same code, which is why this file is ~1/6th the size it
//     would be if each element owned its own copy of every form.
//
//   - Element descriptors own what actually happens. Fire writes FIRE cells and
//     chains through wood; Water moves real water and douses; Earth raises stone; Dark
//     writes nothing at all and drains health instead.
//
//   - Modifiers are a wrapper applied at the single terminal every form funnels into,
//     `detonate()`, with per-element overrides for the handful of abilities where a
//     modifier means something wildly different (Anchor is a fire wall for Fire, an
//     ice wall for Water, a tesla turret for Lightning, and a respawn beacon for Dark).
//
// Named abilities are looked up in SIGNATURES, keyed `element|form|modifier` with a
// `*` wildcard, which is exactly how abilities.md phrases them ("Fire + any Form +
// Amplify"). See resolve().

const Spells = (() => {

// ---------------------------------------------------------------------------
// context
// ---------------------------------------------------------------------------

// Every spell function takes (scene, ctx). ctx is built once per cast and carried
// through the whole pipeline so forms and impacts agree on where things are.
// `caster` defaults to the player, but an enemy can pass itself; `aim` overrides the
// mouse pointer so an AI can target a world position instead.
function makeContext(s, element, form, modifier, caster, aim) {
  const body = caster || s.player;
  const originX = body.x + body.w / 2;
  const originY = body.y + body.h / 2;
  const pointer = s.input.activePointer;
  const E = ELEMENTS[element];
  return {
    element, form, modifier,
    originX, originY,
    originGx: Math.floor(originX / PIXEL),
    originGy: Math.floor(originY / PIXEL),
    targetX: aim ? aim.x : pointer.worldX,
    targetY: aim ? aim.y : pointer.worldY,
    radius: E.radius,
    facing: body.facing || 1,
    casterX: originX,
    casterY: originY,
    // Who threw this. Null means the local player; anything else is an entity that
    // must not be credited with the player's self-damage.
    caster: caster || null,
  };
}

// ---------------------------------------------------------------------------
// generic forms — geometry only
// ---------------------------------------------------------------------------

// Bolt / Trail / Homing all share this. They differ in flags, which is why they are
// one function here rather than three near-identical ones.
function formBolt(s, ctx, opts = {}) {
  const E = ELEMENTS[ctx.element];
  const { modifier } = ctx;
  const leavesTrail = !!opts.trail;
  const homing = !!opts.homing;

  const baseAngle = Math.atan2(ctx.targetY - ctx.originY, ctx.targetX - ctx.originX);
  const split = modifier === 'Split';
  // Split fans three projectiles, each correspondingly weaker — a real tradeoff
  // rather than a strict upgrade.
  const angles = split ? [baseAngle - 0.22, baseAngle, baseAngle + 0.22] : [baseAngle];
  const radius = split ? Math.max(3, Math.round(ctx.radius * 0.75)) : ctx.radius;

  const pierce = modifier === 'Pierce' ? (E.pierceCount ?? 3) : 0;
  const phase = modifier === 'Pierce' && !!E.piercePhases;

  const speed = opts.speed ?? E.boltSpeed ?? 340;
  s.fx.burst(ctx.originX, ctx.originY, 10, ctx.element, {
    speed: 80, life: 0.3, size: E.sparkSize,
  });

  for (const angle of angles) {
    // Launch from the front edge of the caster, not their centre. Starting a bolt
    // inside the body is what made it detonate on its own caster the instant it
    // spawned; the muzzle offset puts it clear from the first frame.
    const muzzle = 14;
    s.projectiles.push({
      x: ctx.originX + Math.cos(angle) * muzzle,
      y: ctx.originY + Math.sin(angle) * muzzle,
      vx: Math.cos(angle) * speed,
      vy: Math.sin(angle) * speed,
      radius,
      visualR: 4 + radius * 0.2,
      life: opts.life ?? E.boltLife ?? 3,
      trailTimer: 0,
      leavesTrail,
      pierce,
      phase,
      homing,
      modifier,
      element: ctx.element,
      ctx,
      gravity: leavesTrail ? 90 : (E.boltGravity ?? 40),
      // True-flying missiles ignore gravity entirely.
      ...(E.boltGravity === 0 ? { gravity: 0 } : {}),
    });
  }
}

function formNova(s, ctx) {
  const radius = Math.round(ctx.radius * 1.3);
  if (ctx.modifier === 'Split') {
    // Split novas land as three overlapping rings in a row rather than one — reads
    // very differently from a single centred burst.
    const spread = radius + 3;
    const offsets = [[0, 0], [-spread, 0], [spread, 0]];
    offsets.forEach(([ox, oy], i) => {
      s.time.delayedCall(i * 90, () =>
        detonate(s, { ...ctx, gx: ctx.originGx + ox, gy: ctx.originGy + oy }, Math.round(radius * 0.7)));
    });
    return;
  }
  detonate(s, { ...ctx, gx: ctx.originGx, gy: ctx.originGy }, radius);
}

function formBeam(s, ctx) {
  const E = ELEMENTS[ctx.element];
  const { modifier } = ctx;
  const baseAngle = Math.atan2(ctx.targetY - ctx.originY, ctx.targetX - ctx.originX);
  // Pierce extends reach; the element decides whether it also burrows through terrain.
  const maxRange = (modifier === 'Pierce' ? (E.beamRangePierce ?? 85) : (E.beamRange ?? 55)) * PIXEL;
  const step = PIXEL * 0.9;
  const angles = modifier === 'Split'
    ? [baseAngle - 0.16, baseAngle, baseAngle + 0.16]
    : [baseAngle];

  s.fx.burst(ctx.originX, ctx.originY, 8, ctx.element, { speed: 60, life: 0.25, size: 1.2 });

  for (const angle of angles) {
    const ux = Math.cos(angle), uy = Math.sin(angle);
    let x = ctx.originX, y = ctx.originY, traveled = 0;
    let lastGx = null, lastGy = null, blocked = false;

    while (traveled < maxRange) {
      x += ux * step;
      y += uy * step;
      traveled += step;
      if (x < 0 || x >= WORLD_WIDTH || y < 0 || y >= WORLD_HEIGHT) break;
      const gx = Math.floor(x / PIXEL), gy = Math.floor(y / PIXEL);
      if (gx === lastGx && gy === lastGy) continue;
      lastGx = gx; lastGy = gy;

      // The element gets first refusal on every cell the ray crosses. Fire leaves a
      // line of flame; Arcane erases a groove; Earth raises a ridge; Dark writes
      // nothing and drains whoever is in the way.
      const stop = E.beamStep(s, gx, gy, { ...ctx, beamAngle: angle, beamX: x, beamY: y, pierce: modifier === 'Pierce' });
      if (stop === 'block') { blocked = true; break; }
    }

    if (lastGx !== null) {
      const bx = lastGx * PIXEL, by = lastGy * PIXEL;
      s.fx.beam(ctx.originX, ctx.originY, bx, by, ctx.element, {
        life: 0.22, width: E.beamWidth ?? 3,
      });
      if (!blocked || modifier === 'Pierce') {
        detonate(s, { ...ctx, gx: lastGx, gy: lastGy }, Math.round(ctx.radius * 0.7));
      }
    }
  }
}

function formGround(s, ctx) {
  const { modifier } = ctx;
  const dirs = modifier === 'Split' ? [-1, 1] : [ctx.facing];
  const length = ELEMENTS[ctx.element].groundLength ?? 16;
  const terminal = modifier && modifier !== 'Split';
  for (const dir of dirs) {
    s.waves.push({
      element: ctx.element, modifier, ctx, dir,
      gx: ctx.originGx, gy: ctx.originGy,
      step: 0, length, timer: 0, interval: 0.03,
      // Most modifiers also land one final burst where the wave runs out — that
      // terminal hit is what makes a Ground cast feel like it arrives somewhere.
      finalDetonate: terminal,
    });
  }
}

function formMine(s, ctx) {
  const { modifier } = ctx;
  const gx = Math.floor(ctx.targetX / PIXEL), gy = Math.floor(ctx.targetY / PIXEL);
  const count = modifier === 'Split' ? 3 : 1;
  const fuseSec = (modifier === 'Delay' ? 2600 : 1400) / 1000;
  const radius = modifier === 'Pierce' ? Math.round(ctx.radius * 1.2) : ctx.radius;
  for (let i = 0; i < count; i++) {
    s.mines.push({
      gx: gx + (count > 1 ? Phaser.Math.Between(-6, 6) : 0),
      gy: gy + (count > 1 ? Phaser.Math.Between(-3, 3) : 0),
      element: ctx.element,
      modifier,
      radius,
      ctx,
      fuse: fuseSec,
      fuseTotal: fuseSec,
      age: 0,
      // Stops the trap detonating under the caster's own feet as they walk away.
      armTimer: 0.35,
      // A repeating mine (a turret) sets `repeat` to a period and `fuse` to null.
      repeat: null,
      pulseTimer: 0,
      // Delay-mines never take the Delay modifier themselves, or they would
      // double-delay; they just get a long fuse instead.
      detonateModifier: modifier === 'Delay' ? null : modifier,
    });
  }
}

function formOrbit(s, ctx) {
  const { modifier } = ctx;
  const E = ELEMENTS[ctx.element];
  const count = modifier === 'Split' ? 6 : 3;
  const tickInterval = E.orbitInterval ?? 0.5;
  const emberRadius = Math.max(E.orbitMin ?? 3,
    Math.round(ctx.radius * 0.4 * (modifier === 'Amplify' ? 1.6 : 1)));

  const embers = [];
  for (let i = 0; i < count; i++) {
    embers.push({ phase: (i / count) * Math.PI * 2, tickTimer: (i / count) * tickInterval });
  }
  s.orbitSpells.push({
    embers,
    orbitRadius: E.orbitRadius ?? 34,
    spinSpeed: E.orbitSpeed ?? 3.4,
    time: 0,
    duration: E.orbitDuration ?? 5,
    tickInterval,
    emberRadius,
    modifier,
    element: ctx.element,
    ctx,
  });
}

const FORMS = {
  Bolt: (s, ctx) => formBolt(s, ctx),
  Trail: (s, ctx) => formBolt(s, ctx, { trail: true }),
  Homing: (s, ctx) => formBolt(s, ctx, { homing: true }),
  Nova: formNova,
  Beam: formBeam,
  Ground: formGround,
  Mine: formMine,
  Orbit: formOrbit,
};

// ---------------------------------------------------------------------------
// detonation — the single terminal every form funnels into
// ---------------------------------------------------------------------------

// ctx.gx / ctx.gy are the grid cell being detonated at; everything else about ctx
// carries through from the cast.
function detonate(s, ctx, radius) {
  const E = ELEMENTS[ctx.element];
  const modifier = ctx.modifier;

  // An element may hijack a modifier entirely — Anchor means "build a permanent
  // wall" for Earth but "plant a respawn beacon" for Dark.
  const hook = E.modifiers && E.modifiers[modifier];
  if (hook) { hook(s, ctx, radius); return; }

  if (modifier === 'Delay') {
    // A visible countdown ring, then the hit. The pause is the whole point of the
    // modifier, so it has to be legible or the spell just feels broken. The charge
    // now visibly gathers — a rune, a tightening implosion and a rising whine of
    // particles — so the wait builds tension rather than reading as a dead spell.
    const cx = ctx.gx * PIXEL, cy = ctx.gy * PIXEL;
    s.fx.rune(cx, cy, ctx.element, { r: radius * PIXEL * 0.6, life: 0.65, glyph: 'delay' });
    s.fx.implode(cx, cy, ctx.element, { r: radius * PIXEL * 2.2, life: 0.62, spokes: 10 });
    for (let i = 0; i < 3; i++) {
      s.time.delayedCall(i * 200, () => {
        s.fx.burst(cx, cy, 5, ctx.element, { speed: 26, life: 0.45, rise: -18, size: 1.2 });
      });
    }
    s.time.delayedCall(650, () => detonateNow(s, ctx, radius));
    return;
  }
  detonateNow(s, ctx, radius);
}

// The one place an element's world-effect and its impact FX are fired together.
// Everything that detonates goes through here — the terminal, Anchor pulses, and the
// mine turret loop in game.js — so no call site can accidentally produce a blast that
// changes the world but does not look like anything.
//
// opts.minor suppresses the expensive, screen-level half of the stack (hitstop, tint,
// heavy shake). A Tesla Coil firing every 0.7s forever must not freeze the frame every
// 0.7s forever, and a chain's tenth jump should not hit as hard as the first.
function elementImpact(s, ctx, r, opts = {}) {
  const E = ELEMENTS[ctx.element];
  GameAudio.impact(ctx.element, ctx.gx * PIXEL, ctx.gy * PIXEL, {
    minor: !!opts.minor,
    strength: opts.minor ? 0.68 : Math.min(1.4, 0.72 + r / 36),
  });
  E.impact(s, ctx, r);
  if (E.signature) E.signature(s, ctx, r, opts);
}

function detonateNow(s, ctx, radius) {
  const E = ELEMENTS[ctx.element];
  const modifier = ctx.modifier;
  const r = modifier === 'Amplify' ? Math.round(radius * 1.6) : radius;

  if (modifier === 'Absorb') {
    GameAudio.impact(ctx.element, ctx.gx * PIXEL, ctx.gy * PIXEL, { strength: 0.62 });
    E.absorb(s, ctx, r);
    // Absorb has to read as a pull within the first few frames or it looks like a
    // weak explosion. Converging spokes plus the vortex is what makes the inversion
    // instantly legible.
    s.fx.implode(ctx.gx * PIXEL, ctx.gy * PIXEL, ctx.element, { r: r * PIXEL * 2.4, life: 0.5 });
    s.fx.vortex(ctx.gx * PIXEL, ctx.gy * PIXEL, ctx.element, { r: r * PIXEL * 1.4, life: 0.55, inward: true });
    s.fx.hitstop(28);
    return;
  }

  elementImpact(s, ctx, r);

  if (modifier === 'Volatile') {
    E.volatile(s, ctx, r);
  } else if (modifier === 'Chain') {
    E.chain(s, ctx, r);
  } else if (modifier === 'Anchor') {
    // Default Anchor: the element's own repeating-pulse character. Elements that mean
    // something else entirely by Anchor override it (see ELEMENTS[x].modifiers).
    E.pulse(s, ctx, r, 3);
  }
}

// ---------------------------------------------------------------------------
// shared element helpers
// ---------------------------------------------------------------------------

// Generic fallback for Anchor's "repeats a few times", still used by the tesla-coil
// style abilities with a much higher count. Each element overrides `pulse` with its
// own escalation curve — see the anchorPulses helper below, which is what they build
// on — because six identical strings of shrinking thuds was the single least
// characterful thing in the old system.
function schedulePulses(s, ctx, radius, pulses, interval = 0.45) {
  anchorPulses(s, ctx, radius, pulses, { interval, scale: () => 0.6 });
}

// Shared machinery for a repeating anchor. `scale(i, n)` returns the radius multiplier
// for pulse i, which is the only thing that differs between a fire pyre that grows, a
// stone hammer that lands evenly, and a lightning stutter that fires fast and light.
//
// opts: { interval, scale, jitter, onPulse }
function anchorPulses(s, ctx, radius, pulses, opts = {}) {
  const interval = opts.interval ?? 0.45;
  const scale = opts.scale ?? (() => 0.6);
  const jitter = opts.jitter ?? 0;
  const tick = (i) => {
    if (i >= pulses) return;
    const mul = scale(i, pulses);
    const r = Math.max(3, Math.round(radius * mul));
    const gx = ctx.gx + (jitter ? Phaser.Math.Between(-jitter, jitter) : 0);
    const gy = ctx.gy + (jitter ? Phaser.Math.Between(-jitter, jitter) : 0);
    const pulseCtx = { ...ctx, gx, gy, modifier: null };
    // Later pulses are `minor` so a long anchor does not hitstop the game repeatedly;
    // the first one still lands at full weight.
    elementImpact(s, pulseCtx, r, { minor: i > 0 });
    if (opts.onPulse) opts.onPulse(s, pulseCtx, r, i);
    s.time.delayedCall(interval * 1000, () => tick(i + 1));
  };
  s.time.delayedCall(interval * 1000, () => tick(0));
}

// Generic chain: ask the element which cells are valid jump targets, then jump to a
// few of them with a short stagger. Fire seeks fuel, Arcane seeks solid matter,
// Lightning seeks players — the predicate is the element's whole identity here.
//
// `ctx.chainBudget` is the number of further jumps a detonation is still allowed to
// make. It matters: a chain jump re-enters detonate() with the Chain modifier still
// set, so without a budget each blast spawns up to three more blasts that each spawn
// three more — exponential, and a Fire chain into a big enough forest never stops.
// abilities.md says Fire's chain is "normally capped at 2–3 jumps"; this is the cap.
// Wildfire is the ability that legitimately raises it.
function genericChain(s, ctx, radius, opts = {}) {
  const E = ELEMENTS[ctx.element];
  const budget = ctx.chainBudget ?? (opts.budget ?? 2);
  if (budget <= 0) return;

  const range = radius + (opts.range ?? 8);
  const targets = E.chainTargets(s, ctx.gx, ctx.gy, range, radius);
  if (!targets.length) return;
  const max = opts.max ?? 3;
  Phaser.Utils.Array.Shuffle(targets);
  const n = Math.min(max, targets.length);
  for (let i = 0; i < n; i++) {
    const t = targets[i];
    s.time.delayedCall(150 + i * 120, () => {
      // A visible arc jumping between the two points is what sells "chain" as
      // opposed to "three unrelated explosions". Each link now also throws sparks
      // off the wire and briefly lights the ground at the far end, so you can follow
      // where the reaction is heading rather than just seeing where it arrived.
      const ax = ctx.gx * PIXEL, ay = ctx.gy * PIXEL;
      const bx = t[0] * PIXEL, by = t[1] * PIXEL;
      s.fx.bolt(ax, ay, bx, by, ctx.element, { life: 0.25, branches: 2, jitter: 12 });
      const mid = Math.atan2(by - ay, bx - ax);
      s.fx.streaks((ax + bx) / 2, (ay + by) / 2, 4, ctx.element, {
        speed: 150, life: 0.28, angle: mid, spread: 1.1,
      });
      detonate(s, {
        ...ctx, gx: t[0], gy: t[1], chainBudget: budget - 1,
      }, Math.max(3, Math.round(radius * 0.5)));
    });
  }
}

// The default Volatile: a cook-off. Rather than three equal blasts at random offsets,
// the secondaries now walk OUTWARD from the impact and each one lands harder than the
// last, so a Volatile cast builds instead of sputtering. The stagger is uneven on
// purpose — evenly spaced explosions read as a metronome, not as something going wrong.
function genericVolatile(s, ctx, radius) {
  const spread = ELEMENTS[ctx.element].volatileSpread ?? 1;
  const count = 4;
  const baseAngle = Math.random() * Math.PI * 2;
  for (let i = 0; i < count; i++) {
    const delay = 110 + i * 105 + Phaser.Math.Between(-35, 45);
    s.time.delayedCall(delay, () => {
      // Each step further out than the last, roughly around the impact rather than
      // exactly on a circle.
      const dist = radius * spread * (0.5 + i * 0.45);
      const ang = baseAngle + i * 2.1 + Math.random() * 0.9;
      const ox = Math.round(ctx.gx + Math.cos(ang) * dist);
      const oy = Math.round(ctx.gy + Math.sin(ang) * dist * 0.7);
      const r = Math.max(3, Math.round(radius * (0.38 + i * 0.13)));
      detonateNow(s, { ...ctx, modifier: null, gx: ox, gy: oy }, r);
    });
  }
}

// ---------------------------------------------------------------------------
// direct damage
// ---------------------------------------------------------------------------
//
// A spell's blast hurts whatever is standing in it — the caster included, who is
// never exempt. That is the whole point of the lethality setting: magic is a
// weapon, not a terrain tool.
//
// The local player is damaged directly. Other players are REPORTED, not damaged:
// each client owns its own health, so the caster's client tells the server "I hit
// player 7 for 22 with Fire", and player 7's client applies it. That keeps a
// single owner per health bar without the server having to simulate players.

// opts: { amount, selfMul, knockback, effects }
function damageEntities(s, ctx, radius, opts = {}) {
  const E = ELEMENTS[ctx.element];
  const base = opts.amount ?? E.directDamage ?? 10;
  // Damaging a wide blast less than a focused one, but not proportionally — a big
  // Nova should hurt more than a small one, just not eight times more.
  const amount = base * (1 + radius * 0.07);
  const cx = ctx.gx * PIXEL + PIXEL / 2;
  const cy = ctx.gy * PIXEL + PIXEL / 2;
  const reach = radius * PIXEL * 1.5;

  const caught = s.bodiesInRadius(cx, cy, reach);
  for (const t of caught) {
    // "Self" means the caster, whoever that is. When an enemy throws a Nova the
    // local player standing in it is a victim taking full damage — not the caster
    // quietly hurting themselves.
    const isCaster = ctx.caster ? (t.enemy && t.enemy === ctx.caster) : t.self;
    const dealt = isCaster ? amount * (opts.selfMul ?? 1) : amount;

    if (t.self) {
      s.damagePlayer(dealt, { source: ctx.element });
      s.fx.burst(t.x, t.y, 8, ctx.element, { speed: 70, life: 0.35 });
    } else if (t.enemy) {
      s.damageEnemy(t.enemy, dealt, ctx.element);
    } else {
      s.reportHit(t.id, ctx.element, dealt, opts.effects);
      s.fx.burst(t.x, t.y, 16, ctx.element, { speed: 110, life: 0.45 });
    }
  }
  return caught;
}

// Box-scan helper shared by the chain predicates.
function scanRing(s, gx, gy, radius, range, test) {
  const out = [];
  for (let dy = -range; dy <= range; dy++) {
    for (let dx = -range; dx <= range; dx++) {
      const dist = Math.hypot(dx, dy);
      if (dist < radius || dist > range) continue;
      const x = gx + dx, y = gy + dy;
      if (x <= 0 || x >= COLS - 1 || y <= 0 || y >= ROWS - 1) continue;
      if (test(s.grid[s.idx(x, y)], x, y)) out.push([x, y]);
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// matter — Water moves real water (abilities.md, "The Matter Rule")
// ---------------------------------------------------------------------------
//
// Water never conjures itself. A cast is paid for up front: from the caster's reserve
// first, then from water actually lying in the world within reach, which is pulled
// out of the grid and visibly streams to the caster's hands. What was gathered becomes
// the cast's pool, ctx.matter — one object, shared by every copy of ctx the cast
// spreads into — and every cell a Water spell writes is spent from it. Forms that fan
// out (Split, chain jumps, anchor pulses, orbit ticks) ration the pool between them.
//
// Force, soak and damage are not matter and stay free. What a short draw costs is
// size: the radius shrinks with the square root of the fraction of the cost gathered,
// so area tracks mass.

// From PixelWorld, not game.js's MAT: this runs while spells.js loads, before game.js
// (and its constants) exist.
const PACKED_ICE = PixelWorld.MAT.PACKED_ICE;

const WATER_DRAW_RADIUS = 28;   // cells around the draw point that water can come from
const WATER_RESERVE_CAP = 300;
const WATER_DRAW_RATE = 400;    // cells/s — how fast a world draw arrives, i.e. the wind-up
const WATER_WADE_RATE = 40;     // cells/s drunk into the reserve from a pool you stand in
const WATER_FIZZLE = 0.25;      // below this fraction of the cost, the cast fails
const WATER_WINDUP_MAX = 0.5;   // seconds

// Cells of water per cast. Beam is per second of spray, Trail is the bolt's whole load.
const WATER_FORM_COST = { Bolt: 40, Nova: 120, Beam: 30, Ground: 150, Orbit: 60, Trail: 60, Mine: 60, Homing: 40 };
const WATER_MOD_COST = { Split: 1.2, Pierce: 0.8, Amplify: 2.5, Absorb: 0 };
// Split casts that resolve as three separate impacts, each spending a third.
const WATER_SPLIT_PARTS = { Bolt: 3, Trail: 3, Homing: 3, Mine: 3, Nova: 3 };

function waterCost(form, modifier) {
  return Math.round((WATER_FORM_COST[form] ?? 60) * (WATER_MOD_COST[modifier] ?? 1));
}

// What one cell of a material is worth when drawn. Snow is mostly air.
function waterYield(m) {
  if (m === WATER || m === ICE || m === PACKED_ICE) return 1;
  if (m === SNOW) return 0.5;
  return 0;
}

// Disc offsets [dx, dy, dist] sorted nearest first, cached per radius — both drawing
// and pouring walk outward from a point, and sorting ~2500 offsets per cast is waste.
const DISC_CACHE = new Map();
function discOffsets(r) {
  let list = DISC_CACHE.get(r);
  if (!list) {
    list = [];
    for (let dy = -r; dy <= r; dy++) {
      for (let dx = -r; dx <= r; dx++) {
        const d = Math.hypot(dx, dy);
        if (d <= r) list.push([dx, dy, d]);
      }
    }
    list.sort((a, b) => a[2] - b[2]);
    DISC_CACHE.set(r, list);
  }
  return list;
}

// The local player's reserve lives on the scene; an enemy carries its own, starting
// full, so a Tidewisp gets a few casts before it depends on standing near water.
function reserveOf(s, ctx) {
  const holder = (ctx && ctx.caster) || s;
  if (!holder.reserve) holder.reserve = { water: WATER_RESERVE_CAP };
  return holder.reserve;
}

function casterBody(s, ctx) {
  return (ctx && ctx.caster) || s.player;
}

// Water can only be drawn along an open line: through air, liquid or other water, but
// not through rock. A sealed pocket under the floor stays where it is.
function waterPathClear(s, x0, y0, x1, y1) {
  const dx = x1 - x0, dy = y1 - y0;
  const n = Math.max(Math.abs(dx), Math.abs(dy));
  for (let i = 1; i < n; i++) {
    const x = Math.round(x0 + (dx * i) / n), y = Math.round(y0 + (dy * i) / n);
    const m = s.grid[s.idx(x, y)];
    if (IS_SOLID[m] && !waterYield(m)) return false;
  }
  return true;
}

// Frozen ground directly under the caster's feet is never drawn by their own cast, or
// throwing a bolt on a frozen lake would drop you through it.
function footingGuard(s, ctx) {
  const body = casterBody(s, ctx);
  const x0 = Math.floor(body.x / PIXEL), x1 = Math.floor((body.x + body.w - 1) / PIXEL);
  const feet = Math.floor((body.y + body.h) / PIXEL);
  return (x, y) => x >= x0 && x <= x1 && y >= feet && y <= feet + 2 && s.grid[s.idx(x, y)] !== WATER;
}

// Pulls up to `want` cells' worth of water out of the world within `opts.radius` of
// (gx, gy), nearest first — liquid levels itself, so nearest-first drains a pool from
// the top. Each drawn cell is erased from the grid, and a sample of them stream toward
// (opts.toX, opts.toY) so you can see where the water came from.
// Returns { got, far }: the amount taken and how far away the farthest cell was.
function drawWater(s, gx, gy, want, opts = {}) {
  if (want <= 0) return { got: 0, far: 0 };
  const radius = opts.radius ?? WATER_DRAW_RADIUS;
  const toX = opts.toX ?? gx * PIXEL, toY = opts.toY ?? gy * PIXEL;
  const color = s.fx.palette('Water').glow;
  let got = 0, far = 0, shown = 0;
  for (const [dx, dy, d] of discOffsets(radius)) {
    if (got >= want) break;
    const x = gx + dx, y = gy + dy;
    if (x <= 0 || x >= COLS - 1 || y <= 0 || y >= ROWS - 1) continue;
    const id = s.idx(x, y);
    const value = waterYield(s.grid[id]);
    if (!value) continue;
    if (opts.skip && opts.skip(x, y)) continue;
    if (!waterPathClear(s, x, y, gx, gy)) continue;
    s.setCell(id, EMPTY);
    got += value;
    far = d;
    // Arcane's motion model is a clean straight line with no gravity, which is what a
    // stream of water being pulled through the air should look like; the colour is
    // Water's own.
    if (shown < 30 && (shown < 8 || Math.random() < 0.35)) {
      shown++;
      const px = x * PIXEL + PIXEL / 2, py = y * PIXEL + PIXEL / 2;
      const dist = Math.hypot(toX - px, toY - py);
      s.fx.streaks(px, py, 1, 'Arcane', {
        color, speed: 60 + dist * 2.4, life: 0.34, size: 1.6,
        angle: Math.atan2(toY - py, toX - px), spread: 0.12,
      });
    }
  }
  return { got, far };
}

// The single place a Water spell writes a cell. The caller has already paid for it.
// Empty space fills; fire boils off (the water that put it out is spent as steam);
// lava is quenched to stone. Anything else is left alone and costs nothing.
function wetCell(s, x, y) {
  if (x <= 0 || x >= COLS - 1 || y <= 0 || y >= ROWS - 1) return false;
  const id = s.idx(x, y);
  const m = s.grid[id];
  if (m === EMPTY) { s.setCell(id, WATER); return true; }
  if (m === FIRE) { s.setCell(id, SMOKE, SMOKE_LIFE); return true; }
  if (m === LAVA) { s.setCell(id, STONE); return true; }
  return false;
}

// wetCell, paid for out of the cast's pool one cell at a time.
function wetFromPool(s, ctx, x, y) {
  const m = ctx.matter;
  if (!m || m.left < 1) return false;
  if (!wetCell(s, x, y)) return false;
  m.left -= 1;
  return true;
}

function takeWater(ctx, n) {
  const m = ctx.matter;
  if (!m || n <= 0) return 0;
  const t = Math.min(m.left, n);
  m.left -= t;
  return t;
}

// Puts `amount` cells of water down around (gx, gy), nearest open cells first. The
// first pass skips cells at random and the second fills what it skipped, which gives
// the splash a ragged edge instead of a perfect disc. Returns what was used.
//
// `maxR` is the shape of the splash, not a limit on where the water may go: if the
// disc is already full (an earlier splash, a narrow crevice), the rest spills further
// out rather than vanishing. Only water with no open cell anywhere within the draw
// radius — an impact deep under a lake — has nowhere to be, and merges into the water
// around it.
function pourWater(s, gx, gy, amount, maxR = 12) {
  const start = Math.floor(amount);
  let left = start;
  if (left <= 0) return 0;
  const offs = discOffsets(maxR);
  for (let pass = 0; pass < 2 && left > 0; pass++) {
    for (const [dx, dy] of offs) {
      if (left <= 0) break;
      if (pass === 0 && Math.random() < 0.28) continue;
      if (wetCell(s, gx + dx, gy + dy)) left--;
    }
  }
  if (left > 0 && maxR < WATER_DRAW_RADIUS) {
    for (const [dx, dy] of discOffsets(WATER_DRAW_RADIUS)) {
      if (left <= 0) break;
      if (wetCell(s, gx + dx, gy + dy)) left--;
    }
  }
  return start - left;
}

// How much of the cast's pool one impact may spend. Split impacts take an even share
// of what is left; an explicit ration (a chain jump, an anchor pulse) takes exactly
// that; and a modifier that still has follow-ups to feed keeps half back for them.
function impactShare(ctx) {
  const m = ctx.matter;
  if (!m || m.left <= 0) return 0;
  if (ctx.ration !== undefined) return Math.min(m.left, ctx.ration);
  let amount = m.left;
  if (m.parts > 1) { amount = Math.ceil(m.left / m.parts); m.parts--; }
  if (ctx.modifier === 'Chain' || ctx.modifier === 'Volatile' || ctx.modifier === 'Anchor') {
    amount = Math.ceil(amount / 2);
  }
  return amount;
}

// Absorb spells drink liquid water. It goes into the caster's reserve; what the
// reserve cannot hold splashes down at the caster's feet rather than vanishing.
function drinkCell(s, x, y) {
  if (x <= 0 || x >= COLS - 1 || y <= 0 || y >= ROWS - 1) return 0;
  const id = s.idx(x, y);
  if (s.grid[id] !== WATER) return 0;
  s.setCell(id, EMPTY);
  return 1;
}

function bankWater(s, ctx, amount) {
  if (amount <= 0) return;
  const res = reserveOf(s, ctx);
  const kept = Math.min(Math.max(0, WATER_RESERVE_CAP - res.water), amount);
  res.water += kept;
  const spill = amount - kept;
  if (spill >= 1) {
    const body = casterBody(s, ctx);
    pourWater(s, Math.floor((body.x + body.w / 2) / PIXEL), Math.floor((body.y + body.h) / PIXEL) - 1, spill, 14);
  }
}

// A failed cast: whatever had already been pulled out of the world drops at the
// caster's feet, and the HUD is told so the player learns why nothing happened.
function fizzleWater(s, ctx, need, spilled) {
  const body = casterBody(s, ctx);
  const cx = body.x + body.w / 2;
  if (spilled >= 1) {
    pourWater(s, Math.floor(cx / PIXEL), Math.floor((body.y + body.h) / PIXEL) - 1, spilled, 6);
  }
  s.fx.burst(cx, body.y + body.h * 0.6, 6, 'Water', { speed: 40, life: 0.4, size: 1.1 });
  if (!ctx.caster) s.waterFizzle = { at: s.time.now, need };
}

// Pays for a caster-drawn Water cast. Returns the cast's matter pool, or null if it
// fizzled. `windup` is how long the drawn water takes to arrive.
function gatherForCast(s, ctx, cost) {
  const matter = { left: 0, total: 0, cost, parts: 1, windup: 0 };
  if (cost <= 0) return matter;          // Absorb collects instead of spending
  const res = reserveOf(s, ctx);
  const fromReserve = Math.min(res.water, cost);
  res.water -= fromReserve;
  let world = 0, far = 0;
  if (fromReserve < cost) {
    const drawn = drawWater(s, ctx.originGx, ctx.originGy, cost - fromReserve, {
      toX: ctx.originX, toY: ctx.originY, skip: footingGuard(s, ctx),
    });
    world = drawn.got;
    far = drawn.far;
  }
  const got = fromReserve + world;
  if (got < cost * WATER_FIZZLE) {
    // The reserve's share never left your hands, so it is refunded; water already
    // pulled out of the world has nowhere to go but down.
    res.water += fromReserve;
    fizzleWater(s, ctx, cost, world);
    return null;
  }
  matter.left = matter.total = got;
  if (world > 0) matter.windup = Math.min(WATER_WINDUP_MAX, world / WATER_DRAW_RATE + (far * PIXEL) / 900);
  return matter;
}

// Water a channel is holding when it stops goes back into the reserve.
function returnToReserve(s, ctx) {
  const m = ctx.matter;
  if (!m || m.left <= 0) return;
  const left = m.left;
  m.left = 0;
  bankWater(s, ctx, left);
}

// How much water is within reach of the local player right now, for the HUD. Capped,
// since the readout only has to say "enough" or "not enough".
function waterNearby(s, cap) {
  const p = s.player;
  const gx = Math.floor((p.x + p.w / 2) / PIXEL), gy = Math.floor((p.y + p.h / 2) / PIXEL);
  let total = 0;
  for (const [dx, dy] of discOffsets(WATER_DRAW_RADIUS)) {
    if (total >= cap) break;
    const x = gx + dx, y = gy + dy;
    if (x <= 0 || x >= COLS - 1 || y <= 0 || y >= ROWS - 1) continue;
    const value = waterYield(s.grid[s.idx(x, y)]);
    if (value && waterPathClear(s, x, y, gx, gy)) total += value;
  }
  return Math.floor(total);
}

// { cost, reserve, nearby } for a combo, or null when it is not a Water cast.
function waterStatus(s, element, form, modifier) {
  if (element !== 'Water') return null;
  const sig = resolve(element, form, modifier);
  const cost = waterCost(form, modifier);
  return {
    cost,
    site: !!(sig && sig.drawsAtSite),
    perSecond: form === 'Beam',
    reserve: Math.floor(reserveOf(s, null).water),
  };
}

// Wading refills the reserve by drinking the pool you are standing in — the water
// really leaves the pool, topmost cells first, so the level visibly drops.
function wade(s, dt) {
  const p = s.player;
  if (p.dead || p.liquid !== 'water') return;
  const res = reserveOf(s, null);
  if (res.water >= WATER_RESERVE_CAP) { s.wadeAcc = 0; return; }
  s.wadeAcc = Math.min(2, (s.wadeAcc || 0) + WATER_WADE_RATE * dt);
  const x0 = Math.floor(p.x / PIXEL) - 1, x1 = Math.floor((p.x + p.w) / PIXEL) + 1;
  const y0 = Math.floor(p.y / PIXEL) - 1, y1 = Math.floor((p.y + p.h) / PIXEL) + 1;
  while (s.wadeAcc >= 1 && res.water < WATER_RESERVE_CAP) {
    let drank = false;
    for (let y = y0; y <= y1 && !drank; y++) {
      const start = x0 + ((Math.random() * (x1 - x0 + 1)) | 0);
      for (let k = 0; k <= x1 - x0; k++) {
        const x = x0 + ((start - x0 + k) % (x1 - x0 + 1));
        if (drinkCell(s, x, y)) { drank = true; break; }
      }
    }
    if (!drank) break;
    res.water += 1;
    s.wadeAcc -= 1;
  }
  if (Math.random() < dt * 8) {
    s.fx.burst(p.x + p.w / 2, p.y + p.h * 0.5, 1, 'Water', { speed: 30, life: 0.4, size: 1, rise: 40 });
  }
}

// Wind-up: the caster may have moved while the water was flowing in, so the spell
// launches from where they are now, still at the point they aimed at.
function refreshOrigin(ctx, body) {
  ctx.originX = body.x + body.w / 2;
  ctx.originY = body.y + body.h / 2;
  ctx.originGx = Math.floor(ctx.originX / PIXEL);
  ctx.originGy = Math.floor(ctx.originY / PIXEL);
  ctx.casterX = ctx.originX;
  ctx.casterY = ctx.originY;
  ctx.facing = body.facing || ctx.facing;
}

// ---------------------------------------------------------------------------
// elements
// ---------------------------------------------------------------------------

const ELEMENTS = {

  // -- Fire: thermal, spreads through fuel, everything it touches keeps burning. ----
  Fire: {
    radius: 9,
    // Fire hits hard directly AND leaves fire behind, so it is the highest total.
    directDamage: 15,
    boltSpeed: 340,
    boltGravity: 40,
    beamRange: 55,
    beamRangePierce: 90,
    chainKind: 'fuel',

    // The core fire blast. Randomised by distance so the rim is ragged rather than a
    // clean circle — this is most of why explosions read as explosions.
    impact(s, ctx, r) {
      // Inferno Core's legacy: ground that has been repeatedly scorched burns hotter
      // and reaches further. The bonus is read from the scorch map rather than being
      // a property of this cast, which is what makes fighting over one spot escalate.
      const burned = s.scorch[s.idx(ctx.gx, ctx.gy)];
      if (burned > 0) r = Math.round(r * (1 + Math.min(burned / 255, 1) * 0.45));

      s.explode(ctx.gx, ctx.gy, r);
      s.sendNet({ t: 'explode', gx: ctx.gx, gy: ctx.gy, r });
      // Direct hit, and then the ground keeps burning — Fire is the only element
      // that damages twice.
      damageEntities(s, ctx, r);
      s.fx.burst(ctx.gx * PIXEL, ctx.gy * PIXEL, Math.min(26, 8 + r * 1.3), 'Fire', {
        speed: 90 + r * 5, life: 0.55, rise: 20,
      });
      // The blast itself leaves scorch behind, so the ground keeps getting hotter
      // even without a dedicated Inferno Core cast.
      const sr = Math.round(r * 0.6);
      for (let dy = -sr; dy <= sr; dy++) {
        for (let dx = -sr; dx <= sr; dx++) {
          if (dx * dx + dy * dy > sr * sr) continue;
          const x = ctx.gx + dx, y = ctx.gy + dy;
          if (x <= 0 || x >= COLS - 1 || y <= 0 || y >= ROWS - 1) continue;
          const id = s.idx(x, y);
          s.scorch[id] = Math.min(255, s.scorch[id] + 26);
        }
      }
    },

    // Fire's impact stack: a hot fast shockwave, a spray of embers, a smoke plume
    // that hangs around, and scorch glow that outlives all of it. Fire is the element
    // that leaves the most evidence behind, so its residue layer is the heaviest.
    signature(s, ctx, r, opts = {}) {
      const cx = ctx.gx * PIXEL, cy = ctx.gy * PIXEL;
      s.fx.shockwave(cx, cy, 'Fire', {
        r0: 3, r1: r * PIXEL * 2.1, life: 0.48, width: 4, rings: 3,
      });
      // Embers thrown up and out, then smoke rolling off the top of the fireball.
      s.fx.burst(cx, cy, Math.min(20, 6 + r), 'Fire', {
        speed: 70 + r * 6, life: 0.85, rise: 90, size: 1.5, spin: 6,
      });
      s.fx.smoke(cx, cy - r * PIXEL * 0.3, Math.min(11, 4 + Math.round(r / 2)), 'Fire', {
        life: 1.9, size: 4.5 + r * 0.22, rise: 44,
      });
      s.fx.afterglow(cx, cy, 'Fire', { r: r * PIXEL * 1.25, life: 1.9 });
      if (opts.minor) { s.fx.shake('Fire', 0.004, 80); return; }
      s.fx.shake('Fire', Math.min(0.013, 0.004 + r * 0.00045), Math.min(230, 95 + r * 8));
      s.fx.hitstop(26 + r * 2.2);
      // Only the genuinely big blasts wash the screen — a tint on every fireball
      // would be exhausting within a minute.
      if (r >= 13) s.fx.tint('Fire', 0.14, 0.18);
    },

    beamStep(s, gx, gy, ctx) {
      if (s.solidAtCell(gx, gy)) {
        if (ctx.pierce) {
          s.digCircle(gx, gy, 2);
          s.sendNet({ t: 'dig', gx, gy, r: 2 });
          return null;
        }
        detonate(s, { ...ctx, gx, gy }, Math.round(ctx.radius * 0.7));
        return 'block';
      }
      s.placeCircle(gx, gy, 1, FIRE);
      s.sendNet({ t: 'place', gx, gy, r: 1, mat: FIRE });
      if (Math.random() < 0.5) {
        s.fx.burst(gx * PIXEL, gy * PIXEL, 1, 'Fire', { speed: 25, life: 0.3, rise: 15, size: 1 });
      }
      // The flamethrower vents sideways along its own length rather than only
      // painting cells, which is what stops Fire's beam looking like a thin line.
      if (Math.random() < 0.22) {
        s.fx.burst(ctx.beamX, ctx.beamY, 2, 'Fire', {
          speed: 60, life: 0.5, rise: 55, size: 1.3, angle: ctx.beamAngle, spread: 2.4,
        });
      }
      return null;
    },

    // FLAMETHROWER — the held version of Fire's beam (see the channel section).
    //
    // Deliberately NOT beamStep: the one-shot beam detonates when it meets a wall,
    // which at 25 ticks a second would be 25 explosions a second in your own face.
    // A flamethrower instead pools flame against whatever it hits and keeps burning,
    // which is both survivable and much more like a flamethrower.
    channelStep(s, gx, gy, ctx) {
      // coneR is how wide to paint at this distance from the nozzle: the spray starts
      // tight and fattens out toward the tip, so the flame occupies a volume that
      // matches the cone being drawn over it.
      const w = ctx.coneR ?? 1;
      if (s.solidAtCell(gx, gy)) {
        // Fire splashes against the surface and clings to it rather than boring in,
        // and it splashes WIDER than the jet, the way a liquid does when it hits a
        // wall. Wood catches outright, which is what makes spraying a forest a bad idea.
        s.placeCircle(gx, gy, w + 1, FIRE, FIRE_LIFE * 1.7);
        s.fx.burst(gx * PIXEL, gy * PIXEL, 4, 'Fire', {
          speed: 110, life: 0.55, rise: 70, size: 1.4,
          angle: ctx.beamAngle + Math.PI, spread: 2.8,
        });
        s.scorch[s.idx(gx, gy)] = Math.min(255, s.scorch[s.idx(gx, gy)] + 6);
        return 'block';
      }
      // In open air it lays a fat, ragged plume of flame — ragged because a solid
      // painted cone reads as a placed object rather than as something burning.
      if (Math.random() < 0.82) s.placeCircle(gx, gy, w, FIRE, FIRE_LIFE * 1.5);
      return null;
    },

    groundStep(s, x, y, ctx) {
      let gy = y;
      for (let i = 0; i < 5 && !s.solidAtCell(x, gy + 1); i++) gy++;
      if (ctx.pierce) {
        s.digCircle(x, gy, 2);
        s.sendNet({ t: 'dig', gx: x, gy, r: 2 });
      }
      s.placeCircle(x, gy, 2, FIRE);
      s.sendNet({ t: 'place', gx: x, gy, r: 2, mat: FIRE });
      s.fx.burst(x * PIXEL, gy * PIXEL, 3, 'Fire', { speed: 40, life: 0.4, rise: 40, size: 1.3 });
    },

    trailStep(s, gx, gy) {
      s.placeCircle(gx, gy, 2, FIRE);
      s.sendNet({ t: 'place', gx, gy, r: 2, mat: FIRE });
    },

    orbitTick(s, gx, gy, r, ctx, o) {
      if (o.modifier === 'Absorb') {
        s.digCircle(gx, gy, r);
        s.sendNet({ t: 'dig', gx, gy, r });
        return;
      }
      s.explode(gx, gy, r);
      s.sendNet({ t: 'explode', gx, gy, r });
      s.fx.burst(gx * PIXEL, gy * PIXEL, 6, 'Fire', { speed: 60, life: 0.4, rise: 20 });
      if (o.modifier === 'Chain') genericChain(s, { ...o.ctx, gx, gy }, r);
    },

    absorb(s, ctx, r) {
      // Extinguish rather than ignite: pull the fire *out* of the world.
      s.digCircle(ctx.gx, ctx.gy, r);
      s.sendNet({ t: 'dig', gx: ctx.gx, gy: ctx.gy, r });
      s.fx.burst(ctx.gx * PIXEL, ctx.gy * PIXEL, 14, 'Fire', {
        speed: 45, life: 0.4, color: 0x88ccff, size: 1.2, rise: 10,
      });
      for (let i = s.debris.length - 1; i >= 0; i--) {
        const d = s.debris[i];
        if (Math.hypot(d.x - ctx.gx * PIXEL, d.y - ctx.gy * PIXEL) < r * PIXEL) s.debris.splice(i, 1);
      }
    },

    // Fireballs shed burning material the whole way to the target, so a Fire bolt is
    // already a hazard in flight rather than only on impact.
    projectileTick(s, pr, dt) {
      pr.emberTimer = (pr.emberTimer || 0) - dt;
      if (pr.emberTimer <= 0) {
        pr.emberTimer = 0.04;
        s.fx.burst(pr.x, pr.y, 2, 'Fire', { speed: 34, life: 0.42, rise: 40, size: 1.2 });
        if (Math.random() < 0.3) {
          s.fx.smoke(pr.x, pr.y, 1, 'Fire', { life: 1.1, size: 2.4, rise: 22 });
        }
      }
    },

    chainTargets: (s, gx, gy, range, radius) =>
      scanRing(s, gx, gy, radius, range, (m) => FLAMMABILITY[m] > 0),

    chain(s, ctx, r) { genericChain(s, ctx, r); },

    // Fire's Volatile is a cook-off in a gas pocket: the secondaries hunt for fuel
    // rather than landing at random, so they go off where there is something to burn
    // and the whole reaction visibly follows the flammable material. Falls back to the
    // generic outward walk when there is nothing to catch.
    volatile(s, ctx, r) {
      const fuel = ELEMENTS.Fire.chainTargets(s, ctx.gx, ctx.gy, r * 3, 2);
      if (fuel.length < 3) { genericVolatile(s, ctx, r); return; }
      Phaser.Utils.Array.Shuffle(fuel);
      const n = Math.min(5, fuel.length);
      for (let i = 0; i < n; i++) {
        const [tx, ty] = fuel[i];
        s.time.delayedCall(90 + i * 95 + Phaser.Math.Between(-30, 40), () => {
          s.fx.streaks(tx * PIXEL, ty * PIXEL, 5, 'Fire', { speed: 130, life: 0.3, rise: 40 });
          detonateNow(s, { ...ctx, modifier: null, gx: tx, gy: ty },
            Math.max(3, Math.round(r * (0.4 + i * 0.1))));
        });
      }
      s.fx.hitstop(30);
    },

    // Fire's Anchor is a pyre that BUILDS. Every other element's anchor decays; this
    // one gets hotter each pulse and throws a taller column each time, so holding
    // ground with Fire is a commitment that escalates rather than fizzles.
    pulse(s, ctx, r, n) {
      anchorPulses(s, ctx, r, n + 1, {
        interval: 0.42,
        scale: (i) => 0.55 + i * 0.3,
        onPulse: (sc, pctx, pr, i) => {
          sc.fx.column(pctx.gx * PIXEL, pctx.gy * PIXEL, 'Fire', {
            h: (10 + i * 7) * PIXEL, w: (3 + i) * PIXEL, life: 0.55,
          });
          sc.fx.afterglow(pctx.gx * PIXEL, pctx.gy * PIXEL, 'Fire', { r: pr * PIXEL, life: 2.2 });
        },
      });
    },
  },

  // -- Arcane: disintegrates cleanly and hits with raw force. No fire, no smoke. ---
  Arcane: {
    radius: 8,
    // Clean force: solid damage, no lingering effect.
    directDamage: 13,
    boltSpeed: 400,
    boltGravity: 0,
    boltLife: 2.4,
    beamRange: 50,
    beamRangePierce: 85,
    piercePhases: true,          // passes through walls rather than digging
    pierceCount: 0,
    orbitMin: 2,
    beamWidth: 3,

    impact(s, ctx, r) {
      s.arcaneErase(ctx.gx, ctx.gy, r);
      damageEntities(s, ctx, r);
      s.applyArcaneForce(ctx.gx, ctx.gy, r, 220);
      s.fx.burst(ctx.gx * PIXEL, ctx.gy * PIXEL, Math.min(26, 8 + r * 1.3), 'Arcane', {
        speed: 100 + r * 5, life: 0.5,
      });
    },

    // Arcane's impact stack is the clean one: precise concentric rings, a rift spiral,
    // hard geometric streaks, and deliberately NO smoke or scorch. Where Fire leaves
    // the most evidence, Arcane leaves almost none — the absence is the identity.
    signature(s, ctx, r, opts = {}) {
      const cx = ctx.gx * PIXEL, cy = ctx.gy * PIXEL;
      s.fx.shockwave(cx, cy, 'Arcane', {
        r0: 2, r1: r * PIXEL * 2.4, life: 0.42, width: 3, rings: 4,
      });
      s.fx.spiral(cx, cy, 'Arcane', { r: r * PIXEL * 1.5, life: 0.45, arms: 3, turns: 1.1 });
      s.fx.streaks(cx, cy, Math.min(20, 8 + r), 'Arcane', { speed: 300, life: 0.26 });
      if (opts.minor) { s.fx.shake('Arcane', 0.004, 70); return; }
      s.fx.shake('Arcane', Math.min(0.012, 0.004 + r * 0.0004), Math.min(180, 80 + r * 6));
      s.fx.hitstop(24 + r * 2);
      if (r >= 13) s.fx.tint('Arcane', 0.12, 0.14);
    },

    beamStep(s, gx, gy, ctx) {
      if (s.grid[s.idx(gx, gy)] === BEDROCK) return 'block';
      s.arcaneErase(gx, gy, Math.max(1, Math.round(ctx.radius * 0.35)));
      if (Math.random() < 0.4) {
        s.fx.burst(gx * PIXEL, gy * PIXEL, 1, 'Arcane', { speed: 25, life: 0.3, size: 1 });
      }
      // The disintegration ray sprays what it erases out perpendicular to the beam,
      // which is the only cue that matter is being removed rather than just hidden.
      if (Math.random() < 0.3) {
        s.fx.streaks(ctx.beamX, ctx.beamY, 2, 'Arcane', {
          speed: 200, life: 0.22, angle: ctx.beamAngle + Math.PI / 2, spread: 0.7,
        });
      }
      return null;
    },

    groundStep(s, x, y, ctx) {
      let gy = y;
      for (let i = 0; i < 5 && !s.solidAtCell(x, gy + 1); i++) gy++;
      const pull = ctx.modifier === 'Absorb';
      s.arcaneErase(x, gy, 2);
      s.applyArcaneForce(x, gy, 3, pull ? -90 : 130);
      s.fx.burst(x * PIXEL, gy * PIXEL, 3, 'Arcane', { speed: 40, life: 0.4, rise: 30, size: 1.3 });
    },

    trailStep(s, gx, gy) {
      s.arcaneErase(gx, gy, 1);
    },

    orbitTick(s, gx, gy, r, ctx, o) {
      if (o.modifier === 'Absorb') {
        s.arcaneErase(gx, gy, r);
        s.applyArcaneForce(gx, gy, r, -100);
      } else {
        s.arcaneErase(gx, gy, r);
        s.applyArcaneForce(gx, gy, r, 140);
        if (o.modifier === 'Chain') genericChain(s, { ...o.ctx, gx, gy }, r);
      }
    },

    absorb(s, ctx, r) {
      // Implosion: same erasure, but the force is inverted so everything nearby is
      // dragged into the hole instead of blown out of it.
      s.arcaneErase(ctx.gx, ctx.gy, r);
      s.applyArcaneForce(ctx.gx, ctx.gy, r, -170);
      s.fx.burst(ctx.gx * PIXEL, ctx.gy * PIXEL, Math.min(24, 8 + r), 'Arcane', {
        speed: 70, life: 0.5, rise: -30,
      });
    },

    chainTargets: (s, gx, gy, range, radius) =>
      scanRing(s, gx, gy, radius, range, (m) => IS_RIGID[m] === 1),

    chain(s, ctx, r) {
      // Arcane's chain jumps to solid matter and erases it, carrying force with it.
      const targets = ELEMENTS.Arcane.chainTargets(s, ctx.gx, ctx.gy, r + 10, r);
      if (!targets.length) return;
      Phaser.Utils.Array.Shuffle(targets);
      for (let i = 0; i < Math.min(3, targets.length); i++) {
        const [tx, ty] = targets[i];
        s.time.delayedCall(150 + i * 120, () => {
          s.fx.bolt(ctx.gx * PIXEL, ctx.gy * PIXEL, tx * PIXEL, ty * PIXEL, 'Arcane', {
            life: 0.25, branches: 2, jitter: 8,
          });
          const rr = Math.max(3, Math.round(r * 0.5));
          s.arcaneErase(tx, ty, rr);
          s.applyArcaneForce(tx, ty, rr, 140);
          if (tx === 0 && ty === 0) return;
        });
      }
    },

    // True Strike and its relatives fly dead straight, so their wake is a straight
    // line of geometry rather than a curling trail.
    projectileTick(s, pr, dt) {
      pr.riftTimer = (pr.riftTimer || 0) - dt;
      if (pr.riftTimer <= 0) {
        pr.riftTimer = 0.05;
        s.fx.streaks(pr.x, pr.y, 1, 'Arcane', {
          speed: 120, life: 0.24, angle: Math.atan2(pr.vy, pr.vx) + Math.PI, spread: 0.25,
        });
      }
    },

    // Arcane's Volatile is a rift cascade: each secondary first PULLS everything into
    // itself and then erases the lot a beat later. Two-stage rather than four bangs,
    // which is how Arcane's force identity stays distinct from Fire's cook-off.
    volatile(s, ctx, r) {
      for (let i = 0; i < 4; i++) {
        const ang = Math.random() * Math.PI * 2;
        const dist = r * (0.7 + i * 0.5);
        const ox = Math.round(ctx.gx + Math.cos(ang) * dist);
        const oy = Math.round(ctx.gy + Math.sin(ang) * dist * 0.7);
        const rr = Math.max(3, Math.round(r * 0.5));
        s.time.delayedCall(90 + i * 120, () => {
          s.fx.implode(ox * PIXEL, oy * PIXEL, 'Arcane', { r: rr * PIXEL * 2.6, life: 0.34 });
          s.applyArcaneForce(ox, oy, rr, -190);
          s.time.delayedCall(330, () => {
            detonateNow(s, { ...ctx, modifier: null, gx: ox, gy: oy }, rr);
          });
        });
      }
    },

    // Arcane's Anchor is a rift that cannot decide which way it wants to go: it
    // alternates a pull and a shove, so anything caught near it is thrown back and
    // forth rather than simply pushed away once.
    pulse(s, ctx, r, n) {
      anchorPulses(s, ctx, r, n + 1, {
        interval: 0.38,
        scale: () => 0.6,
        onPulse: (sc, pctx, pr, i) => {
          const inward = i % 2 === 1;
          sc.applyArcaneForce(pctx.gx, pctx.gy, pr, inward ? -220 : 230);
          if (inward) {
            sc.fx.implode(pctx.gx * PIXEL, pctx.gy * PIXEL, 'Arcane', { r: pr * PIXEL * 2.4, life: 0.32 });
          } else {
            sc.fx.spiral(pctx.gx * PIXEL, pctx.gy * PIXEL, 'Arcane', { r: pr * PIXEL * 1.8, life: 0.4, arms: 4 });
          }
        },
      });
    },
  },

  // -- Water: floods, douses, freezes, and pushes. The element that reshapes the
  //    battlefield by moving matter rather than destroying it. ----------------------
  Water: {
    radius: 9,
    // Water is force, not damage: few HP, but it moves you and slows you.
    directDamage: 7,
    boltSpeed: 300,
    boltGravity: 120,
    boltLife: 2.2,
    beamRange: 42,
    beamRangePierce: 70,
    orbitMin: 3,
    orbitRadius: 30,
    orbitInterval: 0.55,
    beamWidth: 4,
    groundLength: 18,
    sparkSize: 1.6,

    // A splash: the cast's own water, poured out where it lands. See the matter
    // section above — every cell written here was drawn from somewhere first.
    impact(s, ctx, r) {
      const amount = takeWater(ctx, impactShare(ctx));

      // Geyser Trap: a mine of pressurised water that erupts straight up, flinging
      // anything standing on it off its feet. Direction is the whole point, so it
      // does not share the normal radial splash. The column is the mine's stored
      // water thrown into the air; it falls back as a puddle.
      if (ctx.form === 'Mine') {
        let left = amount;
        let height = 0;
        for (let k = 1; k <= 26 && left >= 1; k++) {
          const y = ctx.gy - k;
          if (y <= 1 || s.solidAtCell(ctx.gx, y)) break;
          if (wetCell(s, ctx.gx, y)) left--;
          height = k;
        }
        pourWater(s, ctx.gx, ctx.gy - 2, left, 6);
        height = Math.max(height, 6);
        s.fx.column(ctx.gx * PIXEL, ctx.gy * PIXEL, 'Water', { h: height * PIXEL, w: 7 * PIXEL, life: 0.8 });
        s.fx.burst(ctx.gx * PIXEL, ctx.gy * PIXEL, 26, 'Water', {
          speed: 180, life: 0.8, rise: 260, angle: -Math.PI / 2, spread: 1.4,
        });
        // Launch the player hard if they are standing on it — the ability's entire
        // use case is repositioning, whether that is you or someone chasing you.
        s.launchPlayer(ctx.gx * PIXEL, ctx.gy * PIXEL, 40, 430);
        s.fx.shake('Water', 0.009, 200);
        return;
      }
      // Ice Shard: rather than splashing flat, the bolt embeds in whatever it hits as
      // a solid spike of ice — standable, usable as cover, and it thaws back into the
      // puddle it came from when ICE_LIFE runs out. The spike is frozen out of the
      // bolt's own water: half is splashed, the rest builds the spike, and any of the
      // splash that ends up inside the spike's shape freezes where it lies.
      if (ctx.form === 'Bolt') {
        let left = amount - ELEMENTS.Water.splash(s, ctx, Math.round(r * 0.75), Math.floor(amount / 2));
        const height = Math.min(7 + Math.round(r * 0.35), 3 + Math.floor(left / 2));
        for (let k = 0; k < height; k++) {
          const y = ctx.gy - k;
          if (y <= 1) break;
          // Tapers as it rises, so it reads as a spike rather than a pillar.
          const halfW = k < height * 0.4 ? 1 : 0;
          for (let dx = -halfW; dx <= halfW; dx++) {
            const x = ctx.gx + dx;
            if (x <= 0 || x >= COLS - 1) continue;
            const id = s.idx(x, y);
            if (s.grid[id] === WATER) s.setCell(id, ICE, ICE_LIFE);
            else if (s.grid[id] === EMPTY && left >= 1) { s.setCell(id, ICE, ICE_LIFE); left--; }
          }
        }
        pourWater(s, ctx.gx, ctx.gy, left, 6);
        s.fx.column(ctx.gx * PIXEL, ctx.gy * PIXEL, 'Water', {
          h: height * PIXEL, w: 3 * PIXEL, life: 0.5,
        });
        s.fx.shards(ctx.gx * PIXEL, ctx.gy * PIXEL, 14, 'Water', { speed: 150, life: 0.7 });
        return;
      }

      // Maelstrom: Water's Nova is not a splash but a two-stage vortex — it hauls
      // everything inward first, then reverses and flings it all back out a beat
      // later. Gather, then scatter, in one cast. This is the base identity
      // abilities.md gives Water|Nova, and it is what makes Water's Nova feel unlike
      // every other element's outward bang.
      if (ctx.form === 'Nova') {
        const cx = ctx.gx * PIXEL, cy = ctx.gy * PIXEL;
        ELEMENTS.Water.splash(s, ctx, r, amount);
        // Stage one: the pull. Negative knockback drags bodies and debris in.
        s.knockback(cx, cy, r * PIXEL * 3.2, -210);
        s.fx.spiral(cx, cy, 'Water', { r: r * PIXEL * 2.6, life: 0.55, arms: 4, turns: 2.2, inward: true });
        s.fx.implode(cx, cy, 'Water', { r: r * PIXEL * 3, life: 0.5, spokes: 18 });
        damageEntities(s, ctx, r, {
          effects: [{ name: 'Soaked', dps: 0, duration: 3, slow: 0.6 }],
        });
        // Stage two: the reversal.
        s.time.delayedCall(430, () => {
          s.knockback(cx, cy, r * PIXEL * 3.4, 330);
          s.fx.shockwave(cx, cy, 'Water', { r0: 4, r1: r * PIXEL * 3.4, life: 0.5, width: 5, rings: 3 });
          s.fx.burst(cx, cy, Math.min(40, 18 + r * 1.4), 'Water', {
            speed: 230 + r * 6, life: 0.7, rise: 60,
          });
          s.fx.shards(cx, cy, 10, 'Water', { speed: 210, life: 0.8 });
          s.fx.hitstop(46);
          s.fx.shake('Water', 0.009, 200);
        });
        return;
      }

      ELEMENTS.Water.splash(s, ctx, r, amount);
      // Water hurts least but it soaks: a soaked target is slower, which is the
      // crowd-control half of the element. Tide Call (Homing) is the crowd-control
      // specialist, so its soak bites harder and lasts longer than anyone else's.
      const heavySoak = ctx.form === 'Homing';
      damageEntities(s, ctx, r, {
        effects: [{
          name: heavySoak ? 'Tide Call' : 'Soaked',
          dps: 0,
          duration: heavySoak ? 6 : 3,
          slow: heavySoak ? 0.4 : 0.6,
        }],
      });
      s.knockback(ctx.gx * PIXEL, ctx.gy * PIXEL, r * PIXEL * 1.8, 90);
    },

    // The shared water-splash body: `amount` cells of the cast's water poured out
    // around the impact, putting out fire as it goes. Split out because three of
    // Water's forms need the splash without the rest of the impact around it.
    // Returns how much water was actually used.
    splash(s, ctx, r, amount) {
      // The pour reaches a little past the blast radius, so a splash landing in a
      // narrow pit still finds somewhere for all of its water to go.
      const used = pourWater(s, ctx.gx, ctx.gy, amount, Math.min(16, r + 4));
      s.fx.burst(ctx.gx * PIXEL, ctx.gy * PIXEL, Math.min(30, 10 + r), 'Water', {
        speed: 110 + r * 4, life: 0.6, rise: 30,
      });
      // A splash crown reads as impact even when the water itself is hidden in a pit.
      s.fx.ring(ctx.gx * PIXEL, ctx.gy * PIXEL, 'Water', { r0: 2, r1: r * PIXEL * 1.2, life: 0.3, width: 2 });
      return used;
    },

    // Water's impact stack: a wide thin shockwave that outruns every other element's,
    // a crown of droplets that arc and fall under real gravity, and steam instead of
    // smoke. No afterglow — water leaves the world cooler, not marked.
    signature(s, ctx, r, opts = {}) {
      const cx = ctx.gx * PIXEL, cy = ctx.gy * PIXEL;
      s.fx.shockwave(cx, cy, 'Water', {
        r0: 3, r1: r * PIXEL * 2.6, life: 0.45, width: 3, rings: 2,
      });
      // Droplets thrown up in a crown, falling back down on Water's own motion model.
      s.fx.burst(cx, cy, Math.min(26, 10 + r), 'Water', {
        speed: 120 + r * 5, life: 0.75, rise: 150, spread: 2.2, angle: -Math.PI / 2,
      });
      s.fx.smoke(cx, cy, Math.min(7, 3 + Math.round(r / 3)), 'Water', {
        life: 1.2, size: 3.4, rise: 52,
      });
      if (opts.minor) { s.fx.shake('Water', 0.003, 70); return; }
      s.fx.shake('Water', Math.min(0.010, 0.003 + r * 0.00035), Math.min(200, 85 + r * 7));
      s.fx.hitstop(20 + r * 1.5);
    },

    // Hydro Cannon: the jet carries real force for its whole length, which is what
    // separates it from every other element's beam. Only reached by a one-shot beam
    // (every Water beam the player casts is a channel); it spends its cast's water
    // on fire and lava along the line and leaves empty air alone.
    beamStep(s, gx, gy, ctx) {
      const m = s.grid[s.idx(gx, gy)];
      if (m === BEDROCK) return 'block';
      if (m === FIRE || m === LAVA) wetFromPool(s, ctx, gx, gy);
      s.knockback(ctx.beamX, ctx.beamY, 26, ctx.pierce ? 220 : 150);
      if (Math.random() < 0.4) {
        s.fx.burst(ctx.beamX, ctx.beamY, 2, 'Water', { speed: 90, life: 0.35, angle: ctx.beamAngle, spread: 0.9 });
      }
      return null;
    },

    // Water's held spray, which is two abilities depending on the modifier:
    //
    //   FROST SPRAY (+ Anchor) — the flamethrower's opposite number. Water that cannot
    //       flow freezes, which is the same rule Ice Wall uses, so Anchor meaning "ice"
    //       is already established for this element. It coats surfaces in ice, freezes
    //       standing water solid, kills fire outright and chills whatever it touches.
    //
    //   HYDRO CANNON (otherwise) — the sustained pressurised jet abilities.md describes.
    //
    // The force here is much gentler per step than beamStep's: a channel runs the ray
    // ~25 times a second, and beamStep's full-strength knockback on every cell of every
    // tick would fling the player across the map.
    channelStep(s, gx, gy, ctx) {
      const id = s.idx(gx, gy);
      const m = s.grid[id];
      if (m === BEDROCK) return 'block';
      // Captured BEFORE anything is written: the frost branch below can turn this very
      // cell into ice, and asking afterwards whether it is solid would stop the jet
      // dead on the first frost it laid down.
      const wasSolid = s.solidAtCell(gx, gy);

      // DRAIN HOSE (+ Absorb): the jet runs backwards. It drinks the water along its
      // line into the reserve and drags whatever is out in the far field toward you.
      if (ctx.modifier === 'Absorb') {
        let drunk = 0;
        for (let k = 0; k < 3; k++) {
          drunk += drinkCell(s, gx + Phaser.Math.Between(-1, 1), gy + Phaser.Math.Between(-1, 1));
        }
        if (drunk) bankWater(s, ctx, drunk);
        if ((ctx.coneF ?? 1) > 0.25 && Math.random() < 0.3) {
          s.knockback(ctx.beamX, ctx.beamY, 24, 0,
            -Math.cos(ctx.beamAngle) * 70, -Math.sin(ctx.beamAngle) * 70);
        }
        return wasSolid && m !== WATER ? 'block' : null;
      }

      if (ctx.modifier === 'Anchor') {
        // Frost, painted across the cone's width at this distance — see coneR. The
        // jet freezes a volume rather than a line, which is what makes it the mirror
        // of the flamethrower rather than a blue laser.
        const w = ctx.coneR ?? 1;
        for (let dy = -w; dy <= w; dy++) {
          for (let dx = -w; dx <= w; dx++) {
            if (dx * dx + dy * dy > w * w) continue;
            const fx2 = gx + dx, fy2 = gy + dy;
            if (fx2 <= 0 || fx2 >= COLS - 1 || fy2 <= 0 || fy2 >= ROWS - 1) continue;
            const fid = s.idx(fx2, fy2);
            const fm = s.grid[fid];
            // Thinner coverage toward the edge of the cone, so the frost feathers out.
            if (Math.random() > 0.85 - (Math.hypot(dx, dy) / (w + 1)) * 0.45) continue;
            // Standing water freezes where it is, which costs nothing — it is already
            // there. Everything else is paid out of the spray's own water.
            if (fm === WATER) s.setCell(fid, ICE, ICE_LIFE);
            else if (fm === FIRE || fm === LAVA) wetFromPool(s, ctx, fx2, fy2);
            else if (fm === EMPTY && ctx.matter && ctx.matter.left >= 1) {
              // Only builds ice where it has something to stick to, so the spray
              // rimes over terrain instead of building a tube through open air.
              const touching = s.solidAtCell(fx2, fy2 + 1) || s.solidAtCell(fx2, fy2 - 1)
                || s.solidAtCell(fx2 + 1, fy2) || s.solidAtCell(fx2 - 1, fy2);
              if (touching) {
                s.setCell(fid, ICE, ICE_LIFE);
                ctx.matter.left -= 1;
              }
            }
          }
        }
        if (Math.random() < 0.4) {
          s.fx.burst(ctx.beamX, ctx.beamY, 2, 'Water', {
            speed: 70, life: 0.5, size: 1.3, angle: ctx.beamAngle, spread: 2.2,
            color: 0xdff4ff,
          });
        }
        // Chills anything caught in it — Frost Spray is crowd control, where the
        // flamethrower is damage. Never the caster: the jet comes out of your own
        // hands, so freezing yourself with it is not a risk you could ever play
        // around. The ice it leaves on the ground is still yours to slip on.
        if (Math.random() < 0.25) {
          for (const t of s.bodiesInRadius(ctx.beamX, ctx.beamY, 14)) {
            if (t.self) continue;
            if (t.enemy) s.damageEnemy(t.enemy, 2, 'Water');
            else s.reportHit(t.id, 'Water', 1.5, [{ name: 'Frostbitten', duration: 1.4, slow: 0.45 }]);
          }
        }
        return wasSolid && m !== WATER ? 'block' : null;
      }

      // Hydro Cannon. The jet puts out fire and quenches lava on its way (paid for),
      // but it does not paint water along the whole line — the water it carries lands
      // where the jet ends, see channelRayEnd.
      if (m === FIRE || m === LAVA) wetFromPool(s, ctx, gx, gy);
      // Force only out in the far field. knockback() shoves the local player too, and
      // near the nozzle that is the caster — which read as the cannon blasting you
      // backwards every frame you held it rather than as pressure on a target.
      if ((ctx.coneF ?? 1) > 0.25 && Math.random() < 0.3) {
        s.knockback(ctx.beamX, ctx.beamY, 24, ctx.pierce ? 70 : 48);
      }
      if (Math.random() < 0.3) {
        s.fx.burst(ctx.beamX, ctx.beamY, 2, 'Water', {
          speed: 90, life: 0.35, angle: ctx.beamAngle, spread: 0.9,
        });
      }
      // The jet stops at the first wall so its water lands against it; Pierce drives
      // straight through.
      return wasSolid && !ctx.pierce && m !== WATER ? 'block' : null;
    },

    // Held sprays draw as they go: every frame tops the nozzle up to 0.2s of flow,
    // from the reserve first and then from water in reach. A spray with nothing left
    // to draw sputters out a moment later. Drain Hose (+ Absorb) collects instead, so
    // it never runs dry.
    channelDraw(s, ch, dt, initial = false) {
      const ctx = ch.ctx;
      if (ch.modifier === 'Absorb') return true;
      if (!ctx.matter) ctx.matter = { left: 0, total: 0, cost: 0, parts: 1, windup: 0 };
      const m = ctx.matter;
      const rate = waterCost('Beam', ch.modifier);
      const buffer = rate * 0.2;
      const want = initial ? buffer : Math.min(rate * dt, buffer - m.left);
      if (want > 0) {
        const res = reserveOf(s, ctx);
        const fromReserve = Math.min(res.water, want);
        res.water -= fromReserve;
        m.left += fromReserve;
        if (fromReserve < want) {
          m.left += drawWater(s, ctx.originGx, ctx.originGy, want - fromReserve, {
            toX: ctx.originX, toY: ctx.originY, skip: footingGuard(s, ctx),
          }).got;
        }
      }
      if (m.left >= 1) { ch.dryFor = 0; return true; }
      ch.dryFor = (ch.dryFor || 0) + dt;
      if (initial || ch.dryFor > 0.25) {
        fizzleWater(s, ctx, Math.ceil(buffer), 0);
        return false;
      }
      return true;
    },

    // Hydro Cannon's water lands where its jet stops, rather than being painted along
    // the whole line — a real jet carries its water to the target.
    channelRayEnd(s, gx, gy, ctx) {
      if (ctx.modifier === 'Anchor' || ctx.modifier === 'Absorb') return;
      const m = ctx.matter;
      if (!m || m.left < 1) return;
      m.left -= pourWater(s, gx, gy, Math.floor(m.left), 3);
    },

    // Whatever is still in the nozzle when you let go goes back into the reserve.
    channelEnd(s, ch) {
      returnToReserve(s, ch.ctx);
    },

    // Flash Flood: a crest launched from the cast's water. It carries its load along
    // the terrain, laying an even share of it on every column it crosses — so it fills
    // low ground — scoops more off the surface of any pool it runs through, and shoves
    // anything loose along ahead of it. When the load is gone the wave is spent.
    //
    // Receding Tide (+ Absorb) runs the other way and drinks the water it crosses.
    groundStep(s, x, y, ctx, w) {
      let gy = y;
      for (let i = 0; i < 10 && !s.solidAtCell(x, gy + 1); i++) gy++;

      if (ctx.modifier === 'Absorb') {
        let drunk = 0;
        for (let k = -8; k <= 0; k++) drunk += drinkCell(s, x, gy + k);
        if (drunk) bankWater(s, ctx, drunk);
        s.fx.burst(x * PIXEL, gy * PIXEL, 3, 'Water', { speed: 50, life: 0.4, rise: -20, size: 1.2 });
        return;
      }

      if (w.load === undefined) {
        const waves = ctx.modifier === 'Split' ? 2 : 1;
        w.load = takeWater(ctx, Math.ceil((ctx.matter ? ctx.matter.total : 0) / waves));
        // A wave that ends in a detonation keeps half its water for the arrival.
        w.keep = w.finalDetonate ? Math.floor(w.load / 2) : 0;
      }

      // Crossing a pool (water is not solid, so gy is on the pool floor): skim a
      // couple of cells off its surface and carry them on.
      let top = gy;
      while (top > 1 && s.grid[s.idx(x, top)] === WATER) top--;
      const depth = gy - top;
      for (let k = 1; k <= Math.min(2, depth - 1); k++) w.load += drinkCell(s, x, top + k);

      // Lay this column's share of what is left to spread.
      const stepsLeft = Math.max(1, w.length - w.step + 1);
      let put = Math.ceil(Math.max(0, w.load - w.keep) / stepsLeft);
      for (let k = 0; k < 10 && put > 0; k++) {
        if (wetCell(s, x, gy - k)) { put--; w.load--; }
        else if (s.solidAtCell(x, gy - k)) break;
      }

      s.knockback(x * PIXEL, gy * PIXEL, 30, 120, ctx.facing * 60, 0);
      s.fx.burst(x * PIXEL, gy * PIXEL, 5, 'Water', { speed: 70, life: 0.5, rise: 40, size: 1.4 });

      // Spent, or arrived: what the wave still carries either feeds its final
      // detonation or splashes down where it stopped.
      if (w.load < 1 || w.step >= w.length) {
        if (w.finalDetonate && ctx.matter) ctx.matter.left += w.load;
        else pourWater(s, x, gy, w.load, 6);
        w.load = 0;
        w.keep = 0;
        w.step = w.length;
      }
    },

    // Tide Ring: droplets of the cast's water circle you, each tick raining a share of
    // it onto whatever they pass and putting out fires underneath. What is left when
    // the ring ends falls where the droplets are (orbitEnd). With Absorb the ring
    // drinks instead, soaking up the water it sweeps through.
    orbitTick(s, gx, gy, r, ctx, o) {
      if (o.modifier === 'Absorb') {
        let drunk = 0;
        for (const [dx, dy] of discOffsets(r)) drunk += drinkCell(s, gx + dx, gy + dy);
        if (drunk) bankWater(s, ctx, drunk);
      } else {
        if (o.waterPerTick === undefined) {
          const ticks = Math.max(1, (o.embers.length * o.duration) / o.tickInterval);
          o.waterPerTick = Math.max(1, Math.ceil((ctx.matter ? ctx.matter.total : 0) / ticks));
        }
        const taken = takeWater(ctx, o.waterPerTick);
        const used = pourWater(s, gx, gy, taken, r);
        // Droplets passing through water have nowhere to go; they stay in the ring.
        if (ctx.matter) ctx.matter.left += taken - used;
      }
      s.fx.burst(gx * PIXEL, gy * PIXEL, 5, 'Water', { speed: 45, life: 0.5, rise: 10 });
      if (o.modifier === 'Chain') genericChain(s, { ...o.ctx, gx, gy }, r);
    },

    orbitEnd(s, o) {
      const m = o.ctx.matter;
      if (!m || m.left < 1) return;
      const per = m.left / o.embers.length;
      for (const e of o.embers) {
        if (e.x === undefined) continue;
        pourWater(s, Math.floor(e.x / PIXEL), Math.floor(e.y / PIXEL), takeWater(o.ctx, per), 4);
      }
    },

    // Riverwalk: not a static puddle trail but a flowing CURRENT. It lays water down
    // out of the bolt's load and, on top of it, a field that carries anything
    // travelling the same way as the flow. abilities.md's support/traversal tool — the
    // plumbing for it (field.pushX) already existed in updateFields. With Absorb it
    // is Dry Wake instead, drinking what it flies through.
    trailStep(s, gx, gy, ctx, pr) {
      if (gx <= 0 || gx >= COLS - 1 || gy <= 0 || gy >= ROWS - 1) return;
      if (ctx.modifier === 'Absorb') {
        let drunk = 0;
        for (const [dx, dy] of discOffsets(2)) drunk += drinkCell(s, gx + dx, gy + dy);
        if (drunk) bankWater(s, ctx, drunk);
        return;
      }
      // No water left to lay, and none already here: no current either.
      if (!wetFromPool(s, ctx, gx, gy) && s.grid[s.idx(gx, gy)] !== WATER) return;
      // Direction of flow comes from the projectile that laid it; fall back to the
      // caster's facing when there is no projectile (a replayed or synthetic cast).
      const dir = pr && pr.vx !== undefined
        ? (pr.vx >= 0 ? 1 : -1)
        : ((ctx && ctx.facing) || 1);
      if (Math.random() < 0.45) {
        s.fields.push({
          kind: 'current', element: 'Water', x: gx, y: gy, r: 4,
          remaining: 6, dps: 0, pushX: dir * 6.5, pushY: -0.7,
        });
      }
    },

    // A piercing water bolt bores through terrain like any other, but the ice and snow
    // it drills through melt into its own load rather than being deleted — it arrives
    // carrying them. Rock is dug out as usual.
    pierceStep(s, pr, gx, gy, r) {
      for (const [dx, dy] of discOffsets(r)) {
        const x = gx + dx, y = gy + dy;
        if (x <= 0 || x >= COLS - 1 || y <= 0 || y >= ROWS - 1) continue;
        const id = s.idx(x, y);
        const m = s.grid[id];
        // Liquid water is left alone: the bolt passes through it, it is not dug.
        if (m === BEDROCK || m === EMPTY || m === WATER) continue;
        const value = waterYield(m);
        if (value && pr.ctx.matter) {
          pr.ctx.matter.left += value;
          pr.ctx.matter.total += value;
        }
        s.setCell(id, EMPTY);
      }
    },

    projectileTick(s, pr, dt) {
      // Water bolts drip as they fly — real drops out of the bolt's own load, so they
      // visibly wet the world, which no other element does. They stop dripping at
      // half the load so the splash is still worth throwing.
      pr.wetTimer = (pr.wetTimer || 0) - dt;
      if (pr.wetTimer <= 0) {
        pr.wetTimer = 0.12;
        const m = pr.ctx && pr.ctx.matter;
        if (m && m.left > m.total * 0.5) {
          wetFromPool(s, pr.ctx, Math.floor(pr.x / PIXEL), Math.floor(pr.y / PIXEL));
        }
      }
    },

    // Drought: Absorb inverts water entirely — instead of adding it, pull it out. The
    // water is not destroyed: it streams back to the caster and into their reserve,
    // and what the reserve cannot hold splashes down at their feet. Water only moves
    // water, so acid is left where it is.
    absorb(s, ctx, r) {
      let removed = 0;
      for (const [dx, dy] of discOffsets(r)) removed += drinkCell(s, ctx.gx + dx, ctx.gy + dy);
      s.fx.vortex(ctx.gx * PIXEL, ctx.gy * PIXEL, 'Water', { r: r * PIXEL * 1.5, life: 0.6, inward: true });
      if (removed) {
        bankWater(s, ctx, removed);
        s.fx.burst(ctx.gx * PIXEL, ctx.gy * PIXEL, Math.min(20, 4 + removed / 8), 'Water', {
          speed: 60, life: 0.5, rise: -20,
        });
        // The stream home, so the player can see where their pool went.
        const body = casterBody(s, ctx);
        const hx = body.x + body.w / 2, hy = body.y + body.h / 2;
        const sx = ctx.gx * PIXEL, sy = ctx.gy * PIXEL;
        const dist = Math.hypot(hx - sx, hy - sy);
        s.fx.streaks(sx, sy, Math.min(18, 3 + Math.round(removed / 10)), 'Arcane', {
          color: s.fx.palette('Water').glow, speed: 60 + dist * 2.2, life: 0.4, size: 1.8,
          angle: Math.atan2(hy - sy, hx - sx), spread: 0.25,
        });
      }
    },

    // Water's chain seeks *fires* and douses them outward — the one chain in the game
    // that puts things out instead of setting them off.
    chainTargets: (s, gx, gy, range, radius) =>
      scanRing(s, gx, gy, radius, range, (m) => m === FIRE || m === LAVA),

    chain(s, ctx, r) {
      const targets = ELEMENTS.Water.chainTargets(s, ctx.gx, ctx.gy, r + 8, r);
      // The impact kept half the cast's water back for the jumps (impactShare). With
      // nothing to jump to it splashes down here instead. An orbit's chain is the
      // exception: its pool belongs to the rest of the ring.
      if (!targets.length) {
        if (ctx.form !== 'Orbit' && ctx.matter) pourWater(s, ctx.gx, ctx.gy, takeWater(ctx, ctx.matter.left), r + 4);
        return;
      }
      Phaser.Utils.Array.Shuffle(targets);
      const n = Math.min(4, targets.length);
      for (let i = 0; i < n; i++) {
        const [tx, ty] = targets[i];
        s.time.delayedCall(130 + i * 110, () => {
          s.fx.bolt(ctx.gx * PIXEL, ctx.gy * PIXEL, tx * PIXEL, ty * PIXEL, 'Water', {
            life: 0.3, branches: 2, jitter: 10, width: 2,
          });
          // Each jump carries an even share of what is still left.
          const ration = ctx.matter ? Math.ceil(ctx.matter.left / (n - i)) : 0;
          detonateNow(s, { ...ctx, modifier: null, gx: tx, gy: ty, ration }, Math.max(3, Math.round(r * 0.5)));
        });
      }
    },

    volatile(s, ctx, r) {
      // Water's Volatile throws steam rather than fire: pure knockback, no damage.
      // Each burst now vents as a genuine column of steam and shoves harder than the
      // last, so the sequence reads as pressure escaping rather than three puffs.
      // The steam is the half of the cast's water the impact held back, boiled off —
      // this is the one Water modifier that spends water without putting it anywhere.
      for (let i = 0; i < 4; i++) {
        s.time.delayedCall(110 + i * 105, () => {
          if (ctx.matter) takeWater(ctx, ctx.matter.left / (4 - i));
          const ox = ctx.gx + Phaser.Math.Between(-r, r);
          const oy = ctx.gy + Phaser.Math.Between(-r, r);
          s.fx.column(ox * PIXEL, oy * PIXEL, 'Water', { h: (8 + i * 4) * PIXEL, w: 4 * PIXEL, life: 0.45 });
          s.fx.smoke(ox * PIXEL, oy * PIXEL, 6, 'Water', { life: 1.4, size: 4, rise: 80 });
          s.fx.burst(ox * PIXEL, oy * PIXEL, 12, 'Water', { speed: 80 + i * 30, life: 0.5, rise: 90 });
          s.knockback(ox * PIXEL, oy * PIXEL, r * PIXEL, 150 + i * 45);
        });
      }
      s.fx.hitstop(24);
    },

    // Water's Anchor is a rising tide: each pulse floods WIDER but shallower, and the
    // ring it leaves creeps outward. Where Fire's anchor escalates in heat, Water's
    // escalates in reach.
    pulse(s, ctx, r, n) {
      // The pulses share the half of the cast's water the first impact held back.
      if (ctx.matter) ctx.matter.parts = n + 1;
      anchorPulses(s, ctx, r, n + 1, {
        interval: 0.5,
        scale: (i) => 0.5 + i * 0.35,
        onPulse: (sc, pctx, pr) => {
          sc.knockback(pctx.gx * PIXEL, pctx.gy * PIXEL, pr * PIXEL * 2.2, 110);
          sc.fx.ring(pctx.gx * PIXEL, pctx.gy * PIXEL, 'Water', {
            r0: 2, r1: pr * PIXEL * 2.4, life: 0.5, width: 2,
          });
        },
      });
    },
  },

  // -- Earth: raises terrain, and is the only element that makes the world taller.
  //    Nearly non-destructive to entities but it rewrites the map. ----------------
  Earth: {
    radius: 8,
    // Weight: heavy knockback, moderate damage.
    directDamage: 12,
    boltSpeed: 250,
    boltGravity: 260,
    boltLife: 2.6,
    beamRange: 60,
    beamRangePierce: 95,
    orbitMin: 3,
    orbitInterval: 0.6,
    orbitRadius: 32,
    beamWidth: 0,          // Earth's beam draws no beam at all — see beamStep
    groundLength: 20,

    // A boulder: heavy, slow, low damage, but it leaves a pile of rock where it lands.
    impact(s, ctx, r) {
      // Spike Trap: buried stone that erupts upward through the ground when tripped.
      // Absorb inverts this into Sinkhole, which is handled by absorb() below.
      if (ctx.form === 'Mine') {
        const height = 14;
        for (let k = 1; k <= height; k++) {
          const y = ctx.gy - k;
          if (y <= 1) break;
          const id = s.idx(ctx.gx, y);
          const m = s.grid[id];
          if (m === EMPTY || m === WATER || m === FIRE) s.setCell(id, STONE);
        }
        s.sendNet({ t: 'place', gx: ctx.gx, gy: ctx.gy - 5, r: 3, mat: STONE });
        s.fx.burst(ctx.gx * PIXEL, ctx.gy * PIXEL, 20, 'Earth', {
          speed: 120, life: 0.7, rise: 220, angle: -Math.PI / 2, spread: 1.2,
        });
        s.launchPlayer(ctx.gx * PIXEL, ctx.gy * PIXEL, 36, 380);
        s.fx.shards(ctx.gx * PIXEL, ctx.gy * PIXEL, 16, 'Earth', {
          speed: 200, life: 0.8, angle: -Math.PI / 2, spread: 1.4,
        });
        s.fx.shake('Earth', 0.012, 240);
        s.fx.hitstop(50);
        return;
      }

      // Faultline: Earth's Nova does not pile rock up, it SPLITS the ground. A fissure
      // opens at the impact and the fault runs away along the surface in both
      // directions, dropping whatever was resting on it. Named in the ability table
      // but until now it just ran the generic stone-pile impact like every other form.
      if (ctx.form === 'Nova') {
        const cx = ctx.gx * PIXEL, cy = ctx.gy * PIXEL;
        // The fissure itself: a narrow, deep cut straight down.
        for (let dy = -2; dy <= r + 6; dy++) {
          for (let dx = -2; dx <= 2; dx++) {
            if (Math.abs(dx) > 2 - Math.abs(dy) / (r + 3)) continue;
            const x = ctx.gx + dx, y = ctx.gy + dy;
            if (x <= 0 || x >= COLS - 1 || y <= 0 || y >= ROWS - 1) continue;
            const id = s.idx(x, y);
            if (s.grid[id] === BEDROCK) continue;
            if (IS_RIGID[s.grid[id]] && Math.random() < 0.3) {
              s.spawnDebris(x, y, s.grid[id], ctx.gx, ctx.gy, true);
            }
            s.setCell(id, EMPTY);
          }
        }
        s.sendNet({ t: 'dig', gx: ctx.gx, gy: ctx.gy + 3, r: 3 });
        // The fault propagating outward: unsupported ground either side lets go, and
        // the world's own collapse rules bring it down over the next second.
        for (const dir of [-1, 1]) {
          for (let step = 1; step <= 5; step++) {
            s.time.delayedCall(step * 70, () => {
              const ox = ctx.gx + dir * step * Math.max(3, Math.round(r * 0.7));
              if (ox <= 2 || ox >= COLS - 3) return;
              s.destabilize(ox, ctx.gy, 6);
              s.fx.cracks(ox * PIXEL, ctx.gy * PIXEL, 'Earth', { arms: 4, len: 34, life: 1.0 });
              s.fx.burst(ox * PIXEL, ctx.gy * PIXEL, 6, 'Earth', { speed: 50, life: 0.7, rise: 50 });
            });
          }
        }
        damageEntities(s, ctx, r);
        s.knockback(cx, cy, r * PIXEL * 2.2, 180);
        return;
      }

      // Sinkstone: a homing boulder that does not add rock where it lands — it takes
      // the ground out from under whatever it was chasing. Earth's one seeking form,
      // and the inverse of every other Earth impact.
      if (ctx.form === 'Homing') {
        ELEMENTS.Earth.absorb(s, ctx, Math.round(r * 0.9));
        s.destabilize(ctx.gx, ctx.gy, r + 6);
        damageEntities(s, ctx, r);
        s.fx.cracks(ctx.gx * PIXEL, ctx.gy * PIXEL, 'Earth', { arms: 9, len: 52, life: 1.2 });
        s.fx.shake('Earth', 0.012, 280);
        return;
      }

      for (let dy = -r; dy <= r; dy++) {
        for (let dx = -r; dx <= r; dx++) {
          const dist = Math.hypot(dx, dy);
          if (dist > r) continue;
          const x = ctx.gx + dx, y = ctx.gy + dy;
          if (x <= 0 || x >= COLS - 1 || y <= 0 || y >= ROWS - 1) continue;
          const id = s.idx(x, y);
          const cur = s.grid[id];
          if (cur === BEDROCK) continue;
          const chance = 1 - dist / r;
          if (Math.random() < chance) {
            s.setCell(id, Math.random() < 0.7 ? STONE : SAND);
            if (Math.random() < 0.18) s.spawnDebris(x, y, STONE, ctx.gx, ctx.gy, true);
          }
        }
      }
      s.sendNet({ t: 'place', gx: ctx.gx, gy: ctx.gy, r: Math.min(r, 12), mat: STONE });
      damageEntities(s, ctx, r);
      s.fx.burst(ctx.gx * PIXEL, ctx.gy * PIXEL, Math.min(30, 10 + r), 'Earth', {
        speed: 90 + r * 4, life: 0.7, rise: 40,
      });
      s.knockback(ctx.gx * PIXEL, ctx.gy * PIXEL, r * PIXEL * 1.8, 140);
    },

    // Earth's impact stack is the heaviest in the game, and deliberately so: fracture
    // lines, tumbling rock shards, a dust cloud that lingers, the longest hitstop and
    // a low rolling shake. Earth should feel like it costs the world something.
    signature(s, ctx, r, opts = {}) {
      const cx = ctx.gx * PIXEL, cy = ctx.gy * PIXEL;
      s.fx.cracks(cx, cy, 'Earth', { arms: 6 + Math.round(r / 3), len: 30 + r * 2.4, life: 1.2 });
      s.fx.shockwave(cx, cy, 'Earth', {
        r0: 4, r1: r * PIXEL * 1.9, life: 0.55, width: 6, rings: 2,
      });
      s.fx.shards(cx, cy, Math.min(20, 7 + r), 'Earth', { speed: 170 + r * 5, life: 0.85 });
      s.fx.smoke(cx, cy, Math.min(12, 5 + Math.round(r / 2)), 'Earth', {
        life: 2.1, size: 5 + r * 0.25, rise: 20,
      });
      s.fx.afterglow(cx, cy, 'Earth', { r: r * PIXEL * 1.1, life: 1.4 });
      if (opts.minor) { s.fx.shake('Earth', 0.005, 110); return; }
      s.fx.shake('Earth', Math.min(0.015, 0.005 + r * 0.00055), Math.min(280, 115 + r * 9));
      s.fx.hitstop(40 + r * 3);
    },

    // Trench Ray: deliberately non-destructive. It lifts a ridge out of the ground
    // along a straight line and does nothing else — the one pure-utility beam.
    beamStep(s, gx, gy, ctx) {
      if (ctx.pierce) {
        // Earthquake: no visible ridge at all. The ground above the wave is marked
        // unstable and collapses a moment later, so the strike is hard to read and
        // hard to dodge.
        if (Math.random() < 0.5) s.destabilize(gx, gy, 6);
        if (Math.random() < 0.25) {
          s.fx.burst(gx * PIXEL, gy * PIXEL, 2, 'Earth', { speed: 25, life: 0.5, rise: 10, size: 1.2 });
        }
        return null;
      }
      // Find the surface and lift it.
      let y = gy;
      let guard = 0;
      while (y < ROWS - 2 && !s.solidAtCell(gx, y) && guard++ < 40) y++;
      if (y >= ROWS - 2) return null;
      for (let k = 1; k <= 3; k++) {
        const id = s.idx(gx, y - k);
        if (s.grid[id] === EMPTY || s.grid[id] === WATER) s.setCell(id, STONE);
      }
      s.sendNet({ t: 'place', gx, gy: y - 2, r: 2, mat: STONE });
      if (Math.random() < 0.5) {
        s.fx.burst(gx * PIXEL, y * PIXEL, 2, 'Earth', { speed: 30, life: 0.5, rise: 25, size: 1.2 });
      }
      return null;
    },

    // Stone Wall: a rolling wall of rock that blocks movement and projectiles.
    groundStep(s, x, y, ctx) {
      let gy = y;
      for (let i = 0; i < 8 && !s.solidAtCell(x, gy + 1); i++) gy++;
      const height = ctx.modifier === 'Amplify' ? 9 : 4;
      for (let k = 0; k < height; k++) {
        const id = s.idx(x, gy - k);
        const m = s.grid[id];
        if (m === EMPTY || m === WATER || m === FIRE || m === SMOKE || m === GAS) s.setCell(id, STONE);
      }
      s.sendNet({ t: 'place', gx: x, gy: gy - height + 1, r: 4, mat: STONE });
      s.fx.burst(x * PIXEL, gy * PIXEL, 3, 'Earth', { speed: 40, life: 0.5, rise: 30, size: 1.3 });
    },

    orbitTick(s, gx, gy, r, ctx, o) {
      // Tectonic Ribs: solid stone that blocks rather than damages.
      for (let dy = -1; dy <= 1; dy++) {
        for (let dx = -1; dx <= 1; dx++) {
          const x = gx + dx, y = gy + dy;
          if (x <= 0 || x >= COLS - 1 || y <= 0 || y >= ROWS - 1) continue;
          const id = s.idx(x, y);
          if (s.grid[id] === EMPTY) s.setCell(id, STONE);
        }
      }
      s.sendNet({ t: 'place', gx, gy, r: 2, mat: STONE });
      s.fx.burst(gx * PIXEL, gy * PIXEL, 4, 'Earth', { speed: 30, life: 0.5, rise: 20 });
    },

    trailStep(s, gx, gy) {
      // Rubble Road: a walkable path of compacted stone, bridging whatever is below.
      let y = gy;
      let guard = 0;
      while (y < ROWS - 2 && !s.solidAtCell(gx, y + 1) && guard++ < 30) y++;
      for (let dx = -1; dx <= 1; dx++) {
        const id = s.idx(gx + dx, y);
        const m = s.grid[id];
        if (m === EMPTY || m === WATER || m === LAVA || m === ACID) s.setCell(id, STONE);
      }
      s.sendNet({ t: 'place', gx, gy: y, r: 2, mat: STONE });
      if (Math.random() < 0.4) s.fx.burst(gx * PIXEL, y * PIXEL, 2, 'Earth', { speed: 25, life: 0.4, rise: 15 });
    },

    // Sinkhole: Absorb inverts Earth's direction — the ground gives way downward
    // instead of erupting up.
    absorb(s, ctx, r) {
      for (let dy = -4; dy <= r + 4; dy++) {
        for (let dx = -r; dx <= r; dx++) {
          if (Math.hypot(dx, dy) > r + 2) continue;
          const x = ctx.gx + dx, y = ctx.gy + dy;
          if (x <= 0 || x >= COLS - 1 || y <= 0 || y >= ROWS - 1) continue;
          const id = s.idx(x, y);
          const m = s.grid[id];
          if (m === BEDROCK) continue;
          if (IS_SOLID[m]) {
            if (dy > -2) s.setCell(id, EMPTY);
          }
        }
      }
      s.sendNet({ t: 'dig', gx: ctx.gx, gy: ctx.gy + 3, r: Math.min(r, 12) });
      s.fx.vortex(ctx.gx * PIXEL, ctx.gy * PIXEL, 'Earth', { r: r * PIXEL * 1.3, life: 0.6, inward: true });
      s.fx.shake('Earth', 0.01, 200);
    },

    // Earth's chain seeks terrain that is barely holding on and finishes the job.
    chainTargets: (s, gx, gy, range, radius) =>
      scanRing(s, gx, gy, radius, range, (m) => IS_RIGID[m] === 1 || m === SAND),

    chain(s, ctx, r) {
      // Rockslide: rather than blasting, it hooks into the world's own collapse
      // system and brings down what was already precarious. The fracture lines racing
      // out ahead of the collapse are the tell that something much bigger is about to
      // let go — without them, terrain simply started falling for no visible reason.
      s.destabilize(ctx.gx, ctx.gy, r + 12);
      s.fx.cracks(ctx.gx * PIXEL, ctx.gy * PIXEL, 'Earth', {
        arms: 12, len: (r + 12) * PIXEL * 0.9, life: 1.5, width: 3,
      });
      s.fx.shake('Earth', 0.008, 260);
      s.fx.smoke(ctx.gx * PIXEL, ctx.gy * PIXEL, 10, 'Earth', { life: 2.4, size: 6, rise: 14 });
      s.fx.burst(ctx.gx * PIXEL, ctx.gy * PIXEL, 14, 'Earth', { speed: 60, life: 0.7, rise: 50 });
      s.fx.hitstop(58);
    },

    volatile(s, ctx, r) {
      // Landslide: destabilises patches to either side, causing real cascading
      // structural collapse rather than cosmetic spikes. The patches now march
      // outward in both directions instead of landing at random, so you can see the
      // slide travelling and get out of its way — or fail to.
      for (let i = 0; i < 6; i++) {
        s.time.delayedCall(90 + i * 115, () => {
          const dir = i % 2 === 0 ? -1 : 1;
          const step = Math.floor(i / 2) + 1;
          const ox = ctx.gx + dir * step * Math.max(4, r);
          const oy = ctx.gy + Phaser.Math.Between(-r, r);
          if (ox <= 2 || ox >= COLS - 3) return;
          s.destabilize(ox, oy, 6);
          s.fx.cracks(ox * PIXEL, oy * PIXEL, 'Earth', { arms: 5, len: 38, life: 1.1 });
          s.fx.smoke(ox * PIXEL, oy * PIXEL, 5, 'Earth', { life: 1.8, size: 4.5, rise: 12 });
          s.fx.burst(ox * PIXEL, oy * PIXEL, 8, 'Earth', { speed: 50, life: 0.6, rise: 40 });
          s.fx.shake('Earth', 0.006, 160);
        });
      }
      s.fx.shake('Earth', 0.01, 300);
      s.fx.hitstop(46);
    },

    // Boulders tumble visibly and shed grit the whole way, which is most of what
    // makes Earth's slow, heavy bolt feel like it has mass.
    projectileTick(s, pr, dt) {
      pr.gritTimer = (pr.gritTimer || 0) - dt;
      if (pr.gritTimer <= 0) {
        pr.gritTimer = 0.055;
        s.fx.burst(pr.x, pr.y, 1, 'Earth', { speed: 28, life: 0.5, size: 1.3, spin: 10, shape: 'shard' });
      }
    },

    // Earth's Anchor is a piledriver: heavy, evenly-weighted blows on a slow beat,
    // each one cracking the ground again. No escalation and no decay — the point is
    // relentlessness, which is what makes it read as a machine rather than an echo.
    pulse(s, ctx, r, n) {
      anchorPulses(s, ctx, r, n + 2, {
        interval: 0.58,
        scale: () => 0.7,
        onPulse: (sc, pctx, pr) => {
          sc.fx.column(pctx.gx * PIXEL, pctx.gy * PIXEL, 'Earth', {
            h: 14 * PIXEL, w: 5 * PIXEL, life: 0.35, upward: false,
          });
          sc.knockback(pctx.gx * PIXEL, pctx.gy * PIXEL, pr * PIXEL * 2, 170);
        },
      });
    },
  },

  // -- Lightning: instantaneous, multi-target, and the only element that conducts.
  //    Writes almost no terrain — its identity is drawn lines, not matter. ----------
  Lightning: {
    radius: 7,
    // The burst element: high direct damage plus the EMP.
    directDamage: 19,
    boltSpeed: 620,
    boltGravity: 0,
    boltLife: 1.6,
    beamRange: 70,
    beamRangePierce: 110,
    orbitMin: 3,
    orbitInterval: 0.35,
    orbitRadius: 30,
    beamWidth: 2,
    groundLength: 22,
    sparkSize: 1.1,

    // A discharge. Everything in range is hit at once rather than in sequence — the
    // one element whose base Mine is naturally multi-target, and its Nova too.
    impact(s, ctx, r) {
      // Lightning's identity in one call: everyone caught takes the hit AND loses
      // the ability to cast for a moment.
      damageEntities(s, ctx, r, {
        effects: [{ name: 'Static Snap', duration: 2, emp: 1600 }],
      });
      // Glassifies sand into a brittle crust — the only terrain Lightning leaves.
      // Widened with the radius now, so a big discharge leaves a visible glass scar
      // rather than the same five-cell patch a small one does.
      const gr = Math.min(6, 2 + Math.round(r / 4));
      for (let dy = -gr; dy <= gr; dy++) {
        for (let dx = -gr; dx <= gr; dx++) {
          if (dx * dx + dy * dy > gr * gr) continue;
          const x = ctx.gx + dx, y = ctx.gy + dy;
          if (x <= 0 || x >= COLS - 1 || y <= 0 || y >= ROWS - 1) continue;
          const id = s.idx(x, y);
          if (s.grid[id] === SAND && Math.random() < 0.3) s.setCell(id, STONE);
        }
      }
    },

    // Lightning's impact stack is the odd one out: no shockwave, because lightning is
    // not pressure. Instead it is the brightest and the FASTEST — a blinding wash, a
    // web of arcs to everything nearby, a snap of a shake and barely any hitstop at
    // all. Where Earth hangs in the air, Lightning is over before you can look at it.
    signature(s, ctx, r, opts = {}) {
      const cx = ctx.gx * PIXEL, cy = ctx.gy * PIXEL;
      s.fx.ring(cx, cy, 'Lightning', { r0: 2, r1: r * PIXEL * 1.9, life: 0.18, width: 2 });
      s.fx.streaks(cx, cy, Math.min(30, 12 + r * 1.4), 'Lightning', {
        speed: 420 + r * 10, life: 0.2,
      });
      // Arc to everything caught in the blast, including the caster. Simultaneous,
      // never staggered — that is the whole difference between Lightning and a chain.
      const caught = s.bodiesInRadius(cx, cy, r * PIXEL * 1.5);
      s.fx.arcNet(cx, cy, caught.map((t) => [t.x, t.y]), 'Lightning', {
        life: 0.2, branches: 3, jitter: 18,
      });
      // A couple of arcs into empty air too, so a discharge that hits nobody still
      // looks like a discharge.
      for (let i = 0; i < 3; i++) {
        const a = Math.random() * Math.PI * 2;
        const d = r * PIXEL * (1.2 + Math.random());
        s.fx.bolt(cx, cy, cx + Math.cos(a) * d, cy + Math.sin(a) * d, 'Lightning', {
          life: 0.16, branches: 2, jitter: 20,
        });
      }
      s.fx.afterglow(cx, cy, 'Lightning', { r: r * PIXEL * 0.8, life: 0.7 });
      if (opts.minor) { s.fx.shake('Lightning', 0.004, 60); return; }
      s.fx.shake('Lightning', 0.006, 90);
      // Short and sharp. A long freeze would kill exactly the snappiness that makes
      // Lightning read as instantaneous.
      s.fx.hitstop(18);
      s.fx.tint('Lightning', 0.2, 0.1);
    },

    // Arc Lance: conducts through water and acid and re-emerges on the far side of
    // anything that is not conductive — a wall is not cover if it is standing in a
    // puddle.
    beamStep(s, gx, gy, ctx) {
      const m = s.grid[s.idx(gx, gy)];
      if (m === BEDROCK) return 'block';
      const conductive = m === WATER || m === ACID;
      if (!conductive && IS_SOLID[m]) {
        // Non-conductive solid stops the arc unless it is charged to pierce.
        if (!ctx.pierce) return 'block';
        return null;
      }
      if (Math.random() < 0.5) {
        s.fx.bolt(ctx.beamX - 8, ctx.beamY - 8, ctx.beamX + Phaser.Math.Between(-10, 10), ctx.beamY + Phaser.Math.Between(-10, 10),
          'Lightning', { life: 0.14, branches: 2, jitter: 14 });
      }
      // No self-damage here. This used to fire unconditionally on every cell the ray
      // crossed, so casting Arc Lance hurt you once per cell of its own length whether
      // or not you were standing in it — and now that Beam is held, that would have
      // been ~30 cells x 25 ticks a second. Damage for everything actually standing in
      // the beam is applied once, frame-rate independently, by the channel itself.
      const hit = s.bodiesInRadius(ctx.beamX, ctx.beamY, 10);
      for (const t of hit) {
        if (!t.self) s.fx.bolt(ctx.beamX, ctx.beamY, t.x, t.y, 'Lightning', { life: 0.15, branches: 2 });
      }
      return null;
    },

    // Static Field: propagates along conductive ground and leaps to anything standing
    // on it. It dies out the moment it leaves water or acid.
    groundStep(s, x, y, ctx) {
      const id = s.idx(x, y);
      const m = s.grid[id];
      const conductive = m === WATER || m === ACID || m === EMPTY;
      if (!conductive) return;
      s.fx.bolt(x * PIXEL, y * PIXEL, (x + ctx.facing * 3) * PIXEL, (y - 1) * PIXEL,
        'Lightning', { life: 0.15, branches: 2, jitter: 12 });
      const hit = s.bodiesInRadius(x * PIXEL, y * PIXEL, 16);
      for (const t of hit) {
        s.fx.bolt(x * PIXEL, y * PIXEL, t.x, t.y, 'Lightning', { life: 0.16, branches: 2 });
        if (t.self) {
          s.damagePlayer(16, { source: 'Lightning' });
          s.applyStatusEffect('Static Snap', { element: 'Lightning', duration: 1.5, emp: 1200 });
        }
      }
      if (Math.random() < 0.4) {
        s.fx.burst(x * PIXEL, y * PIXEL, 3, 'Lightning', { speed: 120, life: 0.2, size: 1 });
      }
    },

    // Ion Halo: the ring itself is the weapon — anything crossing it gets arced.
    orbitTick(s, gx, gy, r, ctx, o) {
      s.fx.bolt(gx * PIXEL - 12, gy * PIXEL - 12, gx * PIXEL + 12, gy * PIXEL + 12,
        'Lightning', { life: 0.14, branches: 2, jitter: 12 });
      const hit = s.bodiesInRadius(gx * PIXEL, gy * PIXEL, r * PIXEL);
      for (const t of hit) {
        if (t.self) {
          s.damagePlayer(7, { source: 'Lightning' });
        } else {
          s.fx.bolt(gx * PIXEL, gy * PIXEL, t.x, t.y, 'Lightning', { life: 0.16, branches: 2 });
        }
      }
      if (o.modifier === 'Chain') genericChain(s, { ...o.ctx, gx, gy }, r);
    },

    trailStep(s, gx, gy) {
      // Live Wire leaves a charged line; the arc is drawn by drawFields-equivalent
      // sparking rather than by writing matter, since Lightning does not touch terrain.
      if (Math.random() < 0.35) {
        s.fx.bolt(gx * PIXEL - 8, gy * PIXEL - 8, gx * PIXEL + 8, gy * PIXEL + 8,
          'Lightning', { life: 0.2, branches: 1, jitter: 10 });
      }
    },

    projectileTick(s, pr, dt) {
      if (Math.random() < 0.5) {
        s.fx.bolt(pr.x - 12, pr.y - 12, pr.x + 12, pr.y + 12, 'Lightning',
          { life: 0.1, branches: 1, jitter: 12 });
      }
    },

    // Overcharge: Absorb banks ambient charge instead of grounding it, and spends it
    // on the next spell rather than discharging now.
    absorb(s, ctx, r) {
      s.status.buffs.overcharge = (s.status.buffs.overcharge || 0) + 1;
      s.fx.vortex(ctx.gx * PIXEL, ctx.gy * PIXEL, 'Lightning', { r: r * PIXEL * 1.6, life: 0.6, inward: true });
      s.fx.burst(ctx.gx * PIXEL, ctx.gy * PIXEL, 22, 'Lightning', {
        speed: 120, life: 0.5, rise: -30, size: 1.2,
      });
      s.applyStatusEffect('Overcharge', { element: 'Lightning', duration: 8 });
    },

    // Lightning chains to anything that can carry a current, plus everything alive.
    chainTargets: (s, gx, gy, range, radius) =>
      scanRing(s, gx, gy, radius, range, (m) => m === WATER || m === ACID),

    chain(s, ctx, r) {
      // Storm Call behaviour: simultaneous, not sequential — every valid target arcs
      // at the same instant rather than one after another. Drawn as one web in a
      // single frame, which is what makes it land as one event instead of a volley.
      const targets = ELEMENTS.Lightning.chainTargets(s, ctx.gx, ctx.gy, r + 8, r);
      const cap = ctx.form === 'Nova' ? 12 : 4;
      Phaser.Utils.Array.Shuffle(targets);
      const picked = targets.slice(0, cap);
      s.fx.arcNet(ctx.gx * PIXEL, ctx.gy * PIXEL,
        picked.map(([tx, ty]) => [tx * PIXEL, ty * PIXEL]), 'Lightning',
        { life: 0.24, branches: 3, jitter: 16 });
      for (const [tx, ty] of picked) {
        detonateNow(s, { ...ctx, modifier: null, gx: tx, gy: ty }, Math.max(3, Math.round(r * 0.5)));
      }
      if (picked.length) {
        s.fx.tint('Lightning', 0.24, 0.16);
        s.fx.hitstop(40);
      }
    },

    // Storm Front: secondaries thrown far wider than any other element's, and now
    // they come DOWN out of the sky rather than appearing at ground level. A strike
    // that descends reads as weather; one that just happens reads as a bug.
    volatile(s, ctx, r) {
      for (let i = 0; i < 6; i++) {
        s.time.delayedCall(80 + i * 85, () => {
          const spread = r * 2.8;
          const ox = ctx.gx + Phaser.Math.Between(-spread, spread);
          const oy = ctx.gy + Phaser.Math.Between(-spread, spread);
          // The descending strike: a bolt from well above down onto the point.
          s.fx.bolt(ox * PIXEL, (oy - 42) * PIXEL, ox * PIXEL, oy * PIXEL, 'Lightning',
            { life: 0.26, branches: 4, jitter: 22, width: 3 });
          detonateNow(s, { ...ctx, modifier: null, gx: ox, gy: oy }, Math.max(3, Math.round(r * 0.45)));
        });
      }
      s.fx.flash('Lightning', 0.3);
      s.fx.hitstop(34);
    },

    // Lightning's Anchor is a stutter, not a pulse: many fast, light discharges in
    // quick succession. Every other element's anchor is a slow beat; this one buzzes.
    pulse(s, ctx, r, n) {
      anchorPulses(s, ctx, r, n * 3, {
        interval: 0.16,
        scale: () => 0.45,
        jitter: 2,
      });
    },
  },

  // -- Dark: touches no terrain at all. Everything it does is done to people, and
  //    the absence of any world change is its signature. ---------------------------
  Dark: {
    radius: 8,
    // Dark trades burst for a curse that keeps working after the hit.
    directDamage: 9,
    boltSpeed: 300,
    boltGravity: 0,
    boltLife: 2.6,
    beamRange: 46,
    beamRangePierce: 90,
    piercePhases: true,
    pierceCount: 0,
    orbitMin: 2,
    orbitInterval: 0.5,
    orbitRadius: 32,
    beamWidth: 2,
    groundLength: 16,
    groundSlows: true,

    // Wail: a pulse of dread that curses everything in range. It does not move any
    // matter, so the only evidence it happened is on the bodies of whoever it caught.
    impact(s, ctx, r) {
      const cx = ctx.gx * PIXEL, cy = ctx.gy * PIXEL;
      // Slow Death: rather than simply landing later, the curse escalates the longer
      // it is left uncleansed, so ignoring it is the mistake, not taking the hit.
      const escalating = ctx.modifier === 'Delay';
      // Despair: Amplify lowers the target's ceiling, not just their current health.
      // It reaches the `maxHealthMul` the status system derives max health from.
      const despair = ctx.modifier === 'Amplify';

      // Hex Trap: a double-tap by design. The trip applies a mild hex; a few seconds
      // later the real curse lands on anyone who is still standing there, and on the
      // local player if they are still carrying the hex at all. Dying cleanses, which
      // is the only cleanse in the game, so "uncleansed" means exactly that.
      if (ctx.form === 'Mine') {
        damageEntities(s, ctx, r, {
          amount: 4,
          effects: [{ name: 'Hex', dps: 3, duration: 5 }],
        });
        s.fx.rune(cx, cy, 'Dark', { r: r * PIXEL, life: 3.4, spin: 0.7, glyph: 'hex' });
        s.time.delayedCall(3500, () => {
          const stillHexed = s.status.effects.some((e) => e.name === 'Hex');
          s.fx.spiral(cx, cy, 'Dark', { r: r * PIXEL * 2.6, life: 0.8, arms: 4, turns: 2.4, inward: true });
          s.fx.vignette('Dark', 0.7, 0.9);
          damageEntities(s, ctx, Math.round(r * 1.3), {
            amount: 22,
            effects: [{ name: 'Hex Bloom', dps: 9, duration: 5, vision: 0.4 }],
          });
          if (stillHexed) {
            // Reaches them wherever they ran to — the hex itself is the delivery.
            s.damagePlayer(20, { source: 'Dark' });
            s.applyStatusEffect('Hex Bloom', { element: 'Dark', dps: 9, duration: 5, vision: 0.4 });
            s.fx.burst(s.player.x + s.player.w / 2, s.player.y + s.player.h / 2, 24, 'Dark', {
              speed: 80, life: 0.9, rise: -30, size: 1.6,
            });
          }
          s.fx.hitstop(52);
        });
        return;
      }

      const caught = s.bodiesInRadius(cx, cy, r * PIXEL * 1.4);
      for (const t of caught) {
        if (!t.self) s.fx.bolt(cx, cy, t.x, t.y, 'Dark', { life: 0.4, branches: 2, jitter: 12 });
      }
      // Dark's whole identity is that the damage keeps working after the hit, so the
      // curse travels with the damage report rather than being applied here.
      const effects = [{
        name: escalating ? 'Slow Death' : 'Wail',
        dps: escalating ? 4 : 7 + r * 0.4,
        duration: escalating ? 7 : 4,
        ramp: escalating,
        vision: 0.35,
      }];
      if (despair) effects.push({ name: 'Despair', duration: 8, maxHealthMul: 0.6 });
      const hits = damageEntities(s, ctx, r, { effects });

      // Soul Spike: Dark's Bolt is a SETUP tool — landing it marks the target so the
      // caster's next spell hits harder. `status.marks.soulSpike` was read by
      // castWheelSpell from the start and nothing ever wrote it, so Dark's whole
      // combo half was inert. This is the writer.
      if (ctx.form === 'Bolt' && hits.some((t) => !t.self)) {
        s.status.marks.soulSpike = s.time.now + 6000;
        s.applyStatusEffect('Soul Spike', { element: 'Dark', duration: 6 });
        s.fx.rune(cx, cy, 'Dark', { r: r * PIXEL * 0.9, life: 1.2, spin: 1.8, glyph: 'mark' });
      }
    },

    // Dark's impact stack is the only one that takes things AWAY rather than adding
    // them: an inward spiral instead of a shockwave, the screen closing in at the
    // edges, the longest and softest hitstop, and motes that crawl back toward the
    // caster. Almost no shake — Dark does not hit you, it settles on you.
    signature(s, ctx, r, opts = {}) {
      const cx = ctx.gx * PIXEL, cy = ctx.gy * PIXEL;
      s.fx.ring(cx, cy, 'Dark', { r0: r * PIXEL * 1.4, r1: r * PIXEL * 0.15, life: 0.6, width: 3 });
      s.fx.spiral(cx, cy, 'Dark', {
        r: r * PIXEL * 1.9, life: 0.75, arms: 3, turns: 1.9, inward: true,
      });
      s.fx.burst(cx, cy, Math.min(26, 10 + r), 'Dark', {
        speed: 70, life: 1.1, rise: -20, size: 1.6,
        seekX: ctx.originX, seekY: ctx.originY,
      });
      s.fx.smoke(cx, cy, Math.min(9, 4 + Math.round(r / 3)), 'Dark', {
        life: 2.3, size: 4.5, rise: -8,
      });
      s.fx.afterglow(cx, cy, 'Dark', { r: r * PIXEL * 1.3, life: 2.2 });
      if (opts.minor) return;
      s.fx.shake('Dark', 0.003, 130);
      // A long, soft hesitation rather than a punch — dread, not impact.
      s.fx.hitstop(34 + r * 1.6);
      s.fx.vignette('Dark', 0.5, 0.75);
    },

    // Soul Drain: a sustained siphon. Drains while it is on target and refunds part
    // of it to the caster — the closest thing Dark has to a heal.
    beamStep(s, gx, gy, ctx) {
      if (s.grid[s.idx(gx, gy)] === BEDROCK) return 'block';
      if (Math.random() < 0.3) {
        s.fx.burst(ctx.beamX, ctx.beamY, 1, 'Dark', { speed: 40, life: 0.5, size: 1.4, seekX: ctx.originX, seekY: ctx.originY });
      }
      const hit = s.bodiesInRadius(ctx.beamX, ctx.beamY, 12);
      for (const t of hit) {
        // The drain flows back to the caster, so the arc is drawn toward them.
        s.fx.bolt(ctx.beamX, ctx.beamY, ctx.originX, ctx.originY, 'Dark',
          { life: 0.3, branches: 2, jitter: 14, width: 2 });
        // The refund is the whole identity of Soul Drain, and it belongs to draining
        // someone ELSE. Previously this healed only when the beam was draining the
        // caster themselves, which meant it healed you for standing in your own beam
        // and gave nothing for landing it on a target. Damage on whatever is in the
        // beam is applied by the channel; this is just the siphon coming home.
        if (!t.self) s.healPlayer(18 / 40);
      }
      return null;
    },

    // Grasping Shade: crawls along the surface contour without caring what the
    // surface is made of, and roots whatever it passes.
    groundStep(s, x, y, ctx) {
      let gy = y;
      for (let i = 0; i < 6 && !s.solidAtCell(x, gy + 1); i++) gy++;
      s.fields.push({
        kind: 'curse', element: 'Dark', x, y: gy, r: 3,
        remaining: 3.5, dps: 5, slow: 0.55,
      });
      s.fx.burst(x * PIXEL, gy * PIXEL, 4, 'Dark', { speed: 30, life: 0.8, rise: -14, size: 1.4 });
    },

    // Shroud: motes that swallow whatever comes near them.
    orbitTick(s, gx, gy, r, ctx, o) {
      s.fx.burst(gx * PIXEL, gy * PIXEL, 3, 'Dark', { speed: 20, life: 0.7, size: 1.6 });
      const hit = s.bodiesInRadius(gx * PIXEL, gy * PIXEL, r * PIXEL);
      for (const t of hit) {
        if (t.self) {
          s.applyStatusEffect('Shroud', { element: 'Dark', dps: 3, duration: 2 });
        }
      }
      if (o.modifier === 'Chain') genericChain(s, { ...o.ctx, gx, gy }, r);
    },

    trailStep(s, gx, gy) {
      // Wake of Sorrow: leaves a lingering cursed patch rather than a direct hit. The
      // field is the weapon; the bolt is just the delivery.
      let y = gy;
      for (let i = 0; i < 6 && !s.solidAtCell(gx, y + 1); i++) y++;
      if (Math.random() < 0.4) {
        s.fields.push({
          kind: 'curse', element: 'Dark', x: gx, y, r: 3,
          remaining: 4, dps: 6,
        });
      }
    },

    projectileTick(s, pr, dt) {
      if (Math.random() < 0.4) {
        s.fx.burst(pr.x, pr.y, 1, 'Dark', {
          speed: 25, life: 0.7, size: 1.5, seekX: pr.ctx.originX, seekY: pr.ctx.originY,
        });
      }
      // Doom Sickle: the seeking scythe curses everything it PASSES rather than only
      // what it finally hits, leaving a cursed swathe along its whole curving path.
      // Named in the ability table with no implementation behind it until now.
      if (!pr.sickle) return;
      pr.sickleTimer = (pr.sickleTimer || 0) - dt;
      if (pr.sickleTimer > 0) return;
      pr.sickleTimer = 0.09;
      const gx = Math.floor(pr.x / PIXEL), gy = Math.floor(pr.y / PIXEL);
      s.fields.push({
        kind: 'curse', element: 'Dark', x: gx, y: gy, r: 3,
        remaining: 2.6, dps: 5,
      });
      // The blade itself: a short arc swept across the direction of travel.
      const ang = Math.atan2(pr.vy, pr.vx) + Math.PI / 2;
      s.fx.bolt(
        pr.x + Math.cos(ang) * 16, pr.y + Math.sin(ang) * 16,
        pr.x - Math.cos(ang) * 16, pr.y - Math.sin(ang) * 16,
        'Dark', { life: 0.22, branches: 1, jitter: 8, width: 2 },
      );
      for (const t of s.bodiesInRadius(pr.x, pr.y, 20)) {
        if (t.self) {
          s.damagePlayer(3, { source: 'Dark' });
          s.applyStatusEffect('Doom Sickle', { element: 'Dark', dps: 4, duration: 3 });
        } else if (t.enemy) {
          s.damageEnemy(t.enemy, 5, 'Dark');
        }
      }
    },

    // Harvest: drains everything in range at once and takes all of it.
    absorb(s, ctx, r) {
      const cx = ctx.gx * PIXEL, cy = ctx.gy * PIXEL;
      let drained = 0;
      const hit = s.bodiesInRadius(cx, cy, r * PIXEL * 1.5);
      for (const t of hit) {
        s.fx.bolt(t.x, t.y, ctx.originX, ctx.originY, 'Dark', { life: 0.45, branches: 3, jitter: 16 });
        if (t.self) drained += 18;
      }
      if (drained) {
        s.damagePlayer(drained, { source: 'Dark' });
        s.healPlayer(drained * 0.6);
      }
      s.fx.vortex(cx, cy, 'Dark', { r: r * PIXEL * 1.6, life: 0.6, inward: true });
      s.fx.burst(cx, cy, 20, 'Dark', { speed: 90, life: 0.7, rise: -30 });
    },

    // Dark's chain spreads between the cursed rather than the flammable.
    chainTargets: (s, gx, gy, range, radius) =>
      scanRing(s, gx, gy, radius, range, (m) => m === WOOD || m === TIMBER || m === LEAVES || m === GAS),

    chain(s, ctx, r) {
      // Plague: the mark is contagious. It spreads outward on its own rather than
      // resolving entirely at the moment of casting.
      const targets = ELEMENTS.Dark.chainTargets(s, ctx.gx, ctx.gy, r + 10, r);
      if (!targets.length) return;
      Phaser.Utils.Array.Shuffle(targets);
      for (let i = 0; i < Math.min(4, targets.length); i++) {
        const [tx, ty] = targets[i];
        s.time.delayedCall(160 + i * 180, () => {
          s.fx.bolt(ctx.gx * PIXEL, ctx.gy * PIXEL, tx * PIXEL, ty * PIXEL, 'Dark',
            { life: 0.35, branches: 2, jitter: 14 });
          s.fields.push({
            kind: 'curse', element: 'Dark', x: tx, y: ty, r: 4,
            remaining: 5, dps: 5,
          });
        });
      }
    },

    // Panic: the blast disorients rather than merely damaging. The world now visibly
    // closes in while it lasts — a control inversion you cannot see coming is just
    // confusing, where one announced by the screen going dark is frightening.
    volatile(s, ctx, r) {
      for (let i = 0; i < 4; i++) {
        s.time.delayedCall(110 + i * 115, () => {
          const ox = ctx.gx + Phaser.Math.Between(-r, r);
          const oy = ctx.gy + Phaser.Math.Between(-r, r);
          s.fx.burst(ox * PIXEL, oy * PIXEL, 10, 'Dark', { speed: 60, life: 0.8, rise: -20 });
          s.fx.spiral(ox * PIXEL, oy * PIXEL, 'Dark', { r: r * PIXEL, life: 0.5, arms: 2, inward: true });
          detonateNow(s, { ...ctx, modifier: null, gx: ox, gy: oy }, Math.max(3, Math.round(r * 0.45)));
        });
      }
      s.applyStatusEffect('Panic', { element: 'Dark', duration: 1.6, glitch: 1600, vision: 0.45 });
      s.fx.vignette('Dark', 0.95, 1.6);
      s.fx.tint('Dark', 0.2, 0.5);
      s.fx.hitstop(60);
    },

    // Dark's Anchor is a deepening dread: each pulse is stronger than the last and the
    // screen closes in a little further every time. The only anchor that gets harder
    // to look at rather than merely louder.
    pulse(s, ctx, r, n) {
      anchorPulses(s, ctx, r, n + 2, {
        interval: 0.62,
        scale: (i) => 0.5 + i * 0.22,
        onPulse: (sc, pctx, pr, i) => {
          sc.fx.vignette('Dark', 0.35 + i * 0.2, 0.7);
          sc.fields.push({
            kind: 'curse', element: 'Dark', x: pctx.gx, y: pctx.gy, r: pr,
            remaining: 3, dps: 4 + i * 2,
          });
        },
      });
    },
  },
};

// ---------------------------------------------------------------------------
// named abilities (abilities.md)
// ---------------------------------------------------------------------------
//
// Keyed `element|form|modifier`, with `*` matching anything. Resolution order is:
//   exact  ->  element form wildcard  ->  element any-form  ->  generic form
// which is exactly how abilities.md phrases them ("Fire + any Form + Amplify").
//
// Most of the 50 abilities need no entry here at all: they live in the element
// descriptor's impact/beamStep/groundStep/orbitTick hooks, which the generic form
// layer calls for every element. Only abilities whose SHAPE differs from their
// form's default need to be listed.

// --- shared signature helpers ---

// Raises a vertical barrier of a material. Sent as a stack of small ops rather than
// one big one so the server, which clamps placement radius, builds the same shape.
function raiseBarrier(s, ctx, mat, height, halfWidth, life) {
  const gx = Math.floor(ctx.targetX / PIXEL);
  let gy = Math.floor(ctx.targetY / PIXEL);
  let guard = 0;
  while (gy < ROWS - 2 && !s.solidAtCell(gx, gy + 1) && guard++ < 40) gy++;
  for (let dy = 0; dy < height; dy++) {
    const y = gy - dy;
    for (let dx = -halfWidth; dx <= halfWidth; dx++) {
      const x = gx + dx;
      if (x <= 0 || x >= COLS - 1 || y <= 1 || y >= ROWS - 1) continue;
      s.placeCircle(x, y, 1, mat, life);
    }
  }
  for (let dy = 0; dy < height; dy += 3) {
    s.sendNet({ t: 'place', gx, gy: gy - dy, r: 3, mat, life });
  }
  return { gx, gy };
}

const SIGNATURES = {

  // -- Fire -----------------------------------------------------------------
  // Fire Wall: instead of a wave that rushes off and burns out, the flame plants
  // itself as a standing barrier you can fight from behind.
  'Fire|Ground|Anchor': (s, ctx) => {
    const { gx, gy } = raiseBarrier(s, ctx, FIRE, 16, 2);
    const bx = gx * PIXEL, by = gy * PIXEL;
    // Three staggered columns across the wall's width rather than one in the middle,
    // so it reads as a sheet of flame instead of a single torch, and each one erupts
    // a beat after the last so the wall visibly *goes up*.
    for (let i = 0; i < 3; i++) {
      s.time.delayedCall(i * 110, () => {
        const ox = (gx + (i - 1) * 2) * PIXEL;
        s.fx.column(ox, by, 'Fire', { h: (13 + i * 3) * PIXEL, w: 5 * PIXEL, life: 1.0 });
        s.fx.burst(ox, by, 16, 'Fire', { speed: 60, life: 0.9, rise: 130, size: 1.5 });
        s.fx.smoke(ox, by - 10 * PIXEL, 5, 'Fire', { life: 2.4, size: 5, rise: 60 });
      });
    }
    s.fx.afterglow(bx, by, 'Fire', { r: 14 * PIXEL, life: 3.0 });
    s.fx.shake('Fire', 0.008, 260);
    s.fx.hitstop(46);
  },

  // -- Water ----------------------------------------------------------------
  // Ice Wall: water that cannot flow stops flowing and freezes solid. It is built at
  // the site, out of the site's water: anything already standing in the wall's shape
  // freezes where it is, and the rest is pulled in from pools around the base. The
  // wall rises from the bottom, so a short draw builds a short wall; with too little
  // water in reach it fails. It thaws back into a puddle where it stood.
  'Water|Ground|Anchor': (s, ctx) => {
    const HEIGHT = 14, HALF = 2;
    const gx = Math.floor(ctx.targetX / PIXEL);
    let gy = Math.floor(ctx.targetY / PIXEL);
    let guard = 0;
    while (gy < ROWS - 2 && !s.solidAtCell(gx, gy + 1) && guard++ < 40) gy++;

    // The wall's cells, bottom row first.
    const slots = [];
    for (let dy = 0; dy < HEIGHT; dy++) {
      for (let dx = -HALF; dx <= HALF; dx++) {
        const x = gx + dx, y = gy - dy;
        if (x <= 0 || x >= COLS - 1 || y <= 1 || y >= ROWS - 1) continue;
        const m = s.grid[s.idx(x, y)];
        if (m === EMPTY || m === WATER) slots.push([x, y]);
      }
    }
    const standing = slots.filter(([x, y]) => s.grid[s.idx(x, y)] === WATER).length;
    const need = slots.length - standing;
    const inWall = (x, y) => Math.abs(x - gx) <= HALF && y <= gy && y > gy - HEIGHT;
    const midY = gy - Math.floor(HEIGHT / 2);
    let budget = drawWater(s, gx, midY, need, {
      skip: inWall, toX: gx * PIXEL, toY: midY * PIXEL,
    }).got;
    if (standing + budget < slots.length * WATER_FIZZLE) {
      s.fx.burst(gx * PIXEL, gy * PIXEL, 8, 'Water', { speed: 40, life: 0.4, size: 1.1 });
      if (!ctx.caster) s.waterFizzle = { at: s.time.now, need: slots.length };
      pourWater(s, gx, gy, budget, 6);
      return;
    }
    let built = 0;
    for (const [x, y] of slots) {
      const id = s.idx(x, y);
      if (s.grid[id] === WATER) s.setCell(id, ICE, ICE_LIFE);
      else if (budget >= 1) { s.setCell(id, ICE, ICE_LIFE); budget -= 1; }
      else continue;
      built = Math.max(built, gy - y + 1);
    }
    pourWater(s, gx, gy, budget, 6);

    const bx = gx * PIXEL, by = gy * PIXEL;
    // The freeze itself: a hard flash-frost, a spray of ice shards off the surface,
    // and fracture lines through the new wall. A barrier that snaps into existence
    // needs to sound like it cracked, and this is the visual equivalent.
    const hPx = Math.max(4, built) * PIXEL;
    s.fx.column(bx, by, 'Water', { h: hPx, w: 6 * PIXEL, life: 0.7 });
    s.fx.shards(bx, by - hPx * 0.45, 26, 'Water', { speed: 190, life: 0.85, spread: Math.PI * 2 });
    s.fx.cracks(bx, by - hPx * 0.5, 'Water', { arms: 8, len: 40, life: 1.3 });
    s.fx.shockwave(bx, by, 'Water', { r0: 3, r1: 26 * PIXEL, life: 0.4, width: 3, rings: 2 });
    s.fx.burst(bx, by, 24, 'Water', { speed: 80, life: 0.7, rise: 45 });
    s.fx.tint('Water', 0.16, 0.2);
    s.fx.shake('Water', 0.006, 150);
    s.fx.hitstop(40);
  },

  // Rain Dance: not a delayed splash at one point but a whole-zone downpour. The water
  // is lifted off every pool in a wide area around the caster — it visibly rises as
  // mist — gathers as cloud, and comes back down as rain across the zone: the same
  // water, moved. With no water in reach the clouds stay thin and nothing falls.
  'Water|Nova|Delay': (s, ctx) => {
    const r = Math.round(ctx.radius * 3.2);
    const cx = ctx.originGx, cy = ctx.originGy;
    const wx = cx * PIXEL, wy = cy * PIXEL;
    const cloudY = (cy - 20) * PIXEL;
    const spanPx = r * PIXEL;

    const RAIN_MAX = 300;
    const lifted = drawWater(s, cx, cy, RAIN_MAX, { radius: r + 12, toX: wx, toY: cloudY }).got;
    if (lifted < RAIN_MAX * 0.08) {
      s.fx.smoke(wx, cloudY, 3, 'Water', { life: 1.6, size: 5, rise: -4, speed: 16 });
      if (!ctx.caster) s.waterFizzle = { at: s.time.now, need: Math.ceil(RAIN_MAX * 0.08) };
      pourWater(s, cx, cy, lifted, 6);
      return;
    }
    // Everything below scales with how much water actually went up.
    const heft = lifted / RAIN_MAX;
    let rain = lifted;

    // Stage one: the clouds gather. Dark puffs roll in across the whole span, so the
    // zone about to be hit is legible before it is hit.
    for (let i = 0; i < Math.max(2, Math.round(5 * heft)); i++) {
      s.time.delayedCall(i * 110, () => {
        s.fx.smoke(wx + Phaser.Math.Between(-spanPx, spanPx), cloudY + Phaser.Math.Between(-20, 20),
          5, 'Water', { life: 2.6, size: 7, rise: -6, speed: 22 });
      });
    }
    s.fx.vignette('Water', 0.35, 1.6);

    // Stage two: actual falling rain. Droplets spawn along the cloud line and fall
    // under Water's own gravity over more than a second — a downpour has to LAST, and
    // the old single burst at the end read as one splash rather than as weather.
    for (let i = 0; i < Math.max(4, Math.round(14 * heft)); i++) {
      s.time.delayedCall(560 + i * 95, () => {
        s.fx.burst(wx + Phaser.Math.Between(-spanPx, spanPx), cloudY, 7, 'Water', {
          speed: 40, life: 1.5, size: 1.3, angle: Math.PI / 2, spread: 0.8,
        });
      });
    }

    // Stage three: the water actually arrives, in three sweeps rather than one hit,
    // so the ground fills progressively as the rain lands on it. Each sweep puts out
    // fires in the zone first — those are what a Rain Dance is usually for — then
    // drops the rest of its share as rain over the upper half of the zone to fall.
    for (let pass = 0; pass < 3; pass++) {
      s.time.delayedCall(750 + pass * 330, () => {
        let share = pass === 2 ? rain : Math.ceil(lifted / 3);
        rain -= share;
        s.fx.ring(wx, wy, 'Water', { r0: 4, r1: spanPx, life: 0.5, width: 3 });
        for (const [dx, dy] of discOffsets(r)) {
          if (share < 1) break;
          const x = cx + dx, y = cy + dy;
          if (x <= 0 || x >= COLS - 1 || y <= 0 || y >= ROWS - 1) continue;
          const m = s.grid[s.idx(x, y)];
          if ((m === FIRE || m === LAVA) && Math.random() < 0.5 && wetCell(s, x, y)) share--;
        }
        for (let tries = share * 6; tries > 0 && share >= 1; tries--) {
          const x = cx + Phaser.Math.Between(-r, r);
          const y = cy - Phaser.Math.Between(0, r);
          if (wetCell(s, x, y)) share--;
        }
        // Rain that found nowhere to land (a zone packed solid) falls on the caster.
        if (share >= 1) pourWater(s, cx, cy, share, 10);
        s.fx.burst(wx, wy, 26, 'Water', { speed: 150, life: 0.7, rise: -40, size: 1.6 });
        s.fx.shake('Water', 0.006, 220);
      });
    }
    s.time.delayedCall(750, () => s.fx.hitstop(40));
  },


  // -- Fire (named twists) ---------------------------------------------------
  // Wildfire: Fire's Chain is normally capped at a couple of jumps. This removes the
  // cap — the flame keeps finding fuel for as long as fuel exists, which is exactly
  // as dangerous to your own forest as to anyone else's.
  'Fire|Bolt|Chain': (s, ctx) => {
    // The uncapped chain is the ability. genericChain normally allows 2 further jumps
    // (see its comment on why a cap has to exist at all); Wildfire is the one cast
    // that legitimately raises it, which is what turns a contained reaction into a
    // forest fire.
    ctx.chainBudget = 7;
    formBolt(s, ctx);
    const pr = s.projectiles[s.projectiles.length - 1];
    if (pr) pr.wildfire = true;
  },

  // Inferno Core: Amplify leaves a lasting mark. Ground scorched here burns hotter
  // and spreads further on every later cast, so fighting repeatedly over the same
  // spot is rewarded rather than being a series of identical one-off blasts.
  'Fire|*|Amplify': (s, ctx) => {
    const r = Math.round(ctx.radius * 1.6);
    detonateNow(s, ctx, r);
    const scorchR = r + 4;
    for (let dy = -scorchR; dy <= scorchR; dy++) {
      for (let dx = -scorchR; dx <= scorchR; dx++) {
        if (dx * dx + dy * dy > scorchR * scorchR) continue;
        const x = ctx.gx + dx, y = ctx.gy + dy;
        if (x <= 0 || x >= COLS - 1 || y <= 0 || y >= ROWS - 1) continue;
        const id = s.idx(x, y);
        s.scorch[id] = Math.min(255, s.scorch[id] + 90);
      }
    }
    // The scorched ground is visibly darker and smoulders where it is strongest.
    for (let i = 0; i < 30; i++) {
      s.fx.burst(
        (ctx.gx + Phaser.Math.Between(-scorchR, scorchR)) * PIXEL,
        (ctx.gy + Phaser.Math.Between(-scorchR, scorchR)) * PIXEL,
        1, 'Fire', { speed: 20, life: 1.4, rise: 14, size: 1.2 },
      );
    }

    // Inferno Core is Fire's ultimate, so it gets the full stack: a whiteout, a
    // firestorm column, a ring of secondary blasts walking outward from the core, and
    // a scorch glow that sits on the ground long after everything else has gone.
    const cx = ctx.gx * PIXEL, cy = ctx.gy * PIXEL;
    s.fx.tint('Fire', 0.42, 0.4);
    s.fx.flash('Fire', 0.35);
    s.fx.hitstop(95);
    s.fx.shake('Fire', 0.016, 420);
    s.fx.column(cx, cy, 'Fire', { h: 46 * PIXEL, w: 11 * PIXEL, life: 1.3 });
    s.fx.shockwave(cx, cy, 'Fire', { r0: 5, r1: scorchR * PIXEL * 2.4, life: 0.85, width: 7, rings: 4 });
    s.fx.afterglow(cx, cy, 'Fire', { r: scorchR * PIXEL * 1.3, life: 4.0 });
    s.fx.smoke(cx, cy - 8 * PIXEL, 18, 'Fire', { life: 3.2, size: 8, rise: 70 });
    // The firestorm collapsing outward: six blasts around the rim on a fast stagger.
    for (let i = 0; i < 6; i++) {
      s.time.delayedCall(130 + i * 85, () => {
        const a = (i / 6) * Math.PI * 2 + Math.random() * 0.6;
        const d = scorchR * (0.7 + Math.random() * 0.6);
        const ox = Math.round(ctx.gx + Math.cos(a) * d);
        const oy = Math.round(ctx.gy + Math.sin(a) * d * 0.7);
        detonateNow(s, { ...ctx, modifier: null, gx: ox, gy: oy }, Math.round(r * 0.4));
      });
    }
  },

  // -- Arcane ----------------------------------------------------------------
  // True Strike: a magic missile with no dodge window. Locally there is no position
  // prediction to defeat, so what it means here is perfect straightness — it will not
  // be curved off course by gravity or homing, and it ignores the drag other bolts feel.
  'Arcane|Bolt|*': (s, ctx) => {
    formBolt(s, ctx);
  },

  // Unraveling: the disintegration ray seeks out what is holding a structure up,
  // rather than whatever solid happens to be nearest. Aimed well, it takes down an
  // entire overhang by cutting out exactly the cells carrying the load.
  'Arcane|Beam|Chain': (s, ctx) => {
    formBeam(s, ctx);
    // Sever the supports under the beam's path; the world's own collapse rules do
    // the rest, which is why the structure falls a beat later rather than instantly.
    // The unravelling itself is the show: the load-bearing cells light up along the
    // beam before they go, so you can see WHAT is about to fail rather than just
    // watching a building drop for no visible reason.
    const angle = Math.atan2(ctx.targetY - ctx.originY, ctx.targetX - ctx.originX);
    for (let i = 0; i < 8; i++) {
      s.time.delayedCall(i * 28, () => {
        const d = (i / 8) * 18 * PIXEL * 2;
        const px = ctx.originX + Math.cos(angle) * d;
        const py = ctx.originY + Math.sin(angle) * d;
        s.fx.implode(px, py, 'Arcane', { r: 22, life: 0.3, spokes: 8 });
      });
    }
    s.time.delayedCall(180, () => {
      s.severSupports(ctx.originGx, ctx.originGy, 18);
      s.fx.cracks(ctx.originX + Math.cos(angle) * 60, ctx.originY + Math.sin(angle) * 60,
        'Arcane', { arms: 10, len: 60, life: 1.4 });
      s.fx.tint('Arcane', 0.18, 0.3);
      s.fx.hitstop(72);
    });
  },

  // Ward: Arcane's orbit shards are pure defence. Anything that touches them is
  // erased outright — the one Orbit that stops attacks instead of dealing them.
  'Arcane|Orbit|*': (s, ctx) => {
    formOrbit(s, ctx);
    const o = s.orbitSpells[s.orbitSpells.length - 1];
    if (o) o.ward = true;
  },

  // Null Trap: on top of its own detonation, the rune disarms every other mine caught
  // in the blast. The only ability that directly counters someone else's trap-laying.
  'Arcane|Mine|*': (s, ctx) => {
    const gx = Math.floor(ctx.targetX / PIXEL), gy = Math.floor(ctx.targetY / PIXEL);
    const disarmR = ctx.radius * 2.5;
    for (let i = s.mines.length - 1; i >= 0; i--) {
      const m = s.mines[i];
      if (m.element === 'Arcane' && m.gx === gx && m.gy === gy) continue;
      if (Math.hypot(m.gx - gx, m.gy - gy) > disarmR) continue;
      s.fx.burst(m.gx * PIXEL, m.gy * PIXEL, 8, 'Arcane', { speed: 40, life: 0.4, rise: -14 });
      s.mines.splice(i, 1);
    }
    formMine(s, ctx);
    s.fx.rune(gx * PIXEL, gy * PIXEL, 'Arcane', { r: ctx.radius * 2.5, life: 1.1, spin: 2.2, glyph: 'null' });
  },

  // Rift Anchor: Anchor turns the rift rune into a fixed two-way door. Cast it, walk
  // away, and cast it again from anywhere to warp back to that exact point.
  'Arcane|Mine|Anchor': (s, ctx) => {
    if (s.status.portal) {
      const p = s.status.portal;
      s.fx.bolt(s.player.x + s.player.w / 2, s.player.y + s.player.h / 2, p.x * PIXEL, p.y * PIXEL, 'Arcane',
        { life: 0.35, branches: 3, jitter: 14 });
      s.player.x = p.x * PIXEL;
      s.player.y = p.y * PIXEL;
      s.player.vx = 0;
      s.player.vy = 0;
      s.fx.burst(p.x * PIXEL, p.y * PIXEL, 28, 'Arcane', { speed: 110, life: 0.6, rise: -25 });
      s.status.portal = null;
      return;
    }
    const gx = Math.floor(ctx.targetX / PIXEL), gy = Math.floor(ctx.targetY / PIXEL);
    s.status.portal = { x: gx, y: gy };
    s.fx.rune(gx * PIXEL, gy * PIXEL, 'Arcane', { r: 16, life: 1.4, spin: 1.6, glyph: 'portal' });
    s.fx.burst(gx * PIXEL, gy * PIXEL, 24, 'Arcane', { speed: 70, life: 0.8, rise: -30 });
  },

  // -- Lightning ------------------------------------------------------------
  // Tesla Coil: Anchor removes the pulse limit entirely. The rune becomes a standing
  // turret that discharges at anything in range until something destroys it — the
  // only Anchor variant that is an unlimited, persistent hazard rather than a cap.
  'Lightning|Mine|Anchor': (s, ctx) => {
    const gx = Math.floor(ctx.targetX / PIXEL), gy = Math.floor(ctx.targetY / PIXEL);
    s.mines.push({
      gx, gy, element: 'Lightning', modifier: 'Anchor',
      radius: ctx.radius, ctx,
      fuse: null, fuseTotal: 0, age: 0, armTimer: 0.5,
      repeat: 0.7, pulseTimer: 0.7,
      detonateModifier: null,
      // Marks it as a permanent installation so drawMines can show it as a live
      // turret — a coil idling between discharges should still look dangerous.
      turret: true,
    });
    s.fx.rune(gx * PIXEL, gy * PIXEL, 'Lightning', { r: 10, life: 1.2, spin: 1.4, glyph: 'turret' });
    s.fx.column(gx * PIXEL, gy * PIXEL, 'Lightning', { h: 12 * PIXEL, w: 3 * PIXEL, life: 0.5 });
    s.fx.tint('Lightning', 0.14, 0.14);
  },

  // Storm Brewing: a slow build with visible cloud, then one wide strike across the
  // whole zone rather than a pinpoint hit.
  'Lightning|Mine|Delay': (s, ctx) => {
    const gx = Math.floor(ctx.targetX / PIXEL), gy = Math.floor(ctx.targetY / PIXEL);
    const r = ctx.radius * 2.4;
    s.fx.rune(gx * PIXEL, gy * PIXEL, 'Lightning', { r: 14, life: 1.3, spin: 0.8, glyph: 'storm' });
    for (let i = 0; i < 7; i++) {
      s.time.delayedCall(200 + i * 200, () => {
        s.fx.burst(gx * PIXEL + Phaser.Math.Between(-20, 20), (gy - 16) * PIXEL,
          4, 'Lightning', { speed: 40, life: 0.5, rise: -12, size: 1.6 });
        s.fx.bolt(gx * PIXEL - 30, (gy - 12) * PIXEL, gx * PIXEL + 30, (gy - 12) * PIXEL,
          'Lightning', { life: 0.16, branches: 3, jitter: 20 });
      });
    }
    s.time.delayedCall(1700, () => {
      s.fx.flash('Lightning', 0.3);
      for (let i = 0; i < 6; i++) {
        const ox = gx + Phaser.Math.Between(-r, r);
        const oy = gy + Phaser.Math.Between(-r * 0.5, r * 0.5);
        s.fx.bolt(ox * PIXEL, (oy - 30) * PIXEL, ox * PIXEL, oy * PIXEL, 'Lightning',
          { life: 0.3, branches: 4, jitter: 22, width: 3 });
        detonateNow(s, { ...ctx, modifier: null, gx: ox, gy: oy }, Math.round(ctx.radius * 0.9));
      }
      s.fx.shake('Lightning', 0.012, 260);
    });
  },

  // Forked Bolt: one bolt that splits mid-flight rather than a fan from the muzzle —
  // the spread starts halfway there, so it reaches around cover a fan cannot.
  'Lightning|Bolt|Split': (s, ctx) => {
    formBolt(s, ctx);
    const pr = s.projectiles[s.projectiles.length - 1];
    if (pr) {
      pr.forkAt = 0.5;
      pr.forked = false;
    }
  },

  // Marked for Storm: no travel time at all. It snaps to the nearest target and
  // marks them, so the *next* chain cast jumps to them first.
  'Lightning|Homing|*': (s, ctx) => {
    const cands = s.bodiesInRadius(ctx.originX, ctx.originY, 300 * PIXEL);
    const target = cands.find((t) => !t.self) || cands[0];
    if (target) {
      s.fx.bolt(ctx.originX, ctx.originY, target.x, target.y, 'Lightning',
        { life: 0.3, branches: 4, jitter: 20, width: 3 });
      s.fx.flash('Lightning', 0.18);
      if (target.self) {
        s.damagePlayer(12, { source: 'Lightning' });
      }
      s.status.marks.storm = s.time.now + 6000;
      s.applyStatusEffect('Marked for Storm', { element: 'Lightning', duration: 6 });
    } else {
      formBolt(s, ctx, { homing: true });
    }
  },

  // -- Dark -----------------------------------------------------------------
  // Soul Anchor: not a combat trap — it plants a personal respawn point. Die anywhere
  // on the map while it is active and you come back here instead of at the spawn.
  'Dark|Mine|Anchor': (s, ctx) => {
    const gx = Math.floor(ctx.targetX / PIXEL), gy = Math.floor(ctx.targetY / PIXEL);
    s.status.respawnPoint = { x: gx * PIXEL, y: gy * PIXEL };
    s.fx.rune(gx * PIXEL, gy * PIXEL, 'Dark', { r: 15, life: 1.4, spin: 0.5, glyph: 'beacon' });
    s.fx.burst(gx * PIXEL, gy * PIXEL, 24, 'Dark', { speed: 50, life: 1.0, rise: -35, size: 1.5 });
  },

  // Triple Curse: three independent bolts, each free to find a different victim
  // rather than three copies converging on one.
  'Dark|Bolt|Split': (s, ctx) => {
    formBolt(s, ctx);
    const spawned = s.projectiles.slice(-3);
    for (let i = 0; i < spawned.length; i++) {
      // Spread their aim so they fan out over time instead of all tracking one point.
      spawned[i].vx *= 1 + i * 0.06;
      spawned[i].vy *= 1 - i * 0.05;
    }
  },

  // Wraith Step: Dark never touches terrain anyway, so Pierce simply means the bolt
  // ignores walls outright and reaches whoever is hiding behind them.
  'Dark|Bolt|Pierce': (s, ctx) => {
    formBolt(s, ctx);
    const pr = s.projectiles[s.projectiles.length - 1];
    if (pr) pr.phase = true;
  },

  // -- Earth ----------------------------------------------------------------
  // Fortify: Anchor does not add pulses here, it changes permanence — a thick wall,
  // and one that Acid cannot chew through (acid only ever dissolves sand and wood).
  'Earth|Ground|Anchor': (s, ctx) => {
    const { gx, gy } = raiseBarrier(s, ctx, STONE, 12, 3);
    const bx = gx * PIXEL, by = gy * PIXEL;
    s.fx.burst(bx, by, 26, 'Earth', { speed: 70, life: 0.8, rise: 55 });
    s.fx.shards(bx, by, 20, 'Earth', { speed: 180, life: 0.9, rise: 90 });
    s.fx.cracks(bx, by, 'Earth', { arms: 8, len: 44, life: 1.4 });
    s.fx.smoke(bx, by, 10, 'Earth', { life: 2.2, size: 5.5, rise: 26 });
    s.fx.shake('Earth', 0.011, 260);
    s.fx.hitstop(58);
  },

  // Mountain: tall enough to genuinely break line of sight, not merely a bigger wall.
  'Earth|Ground|Amplify': (s, ctx) => {
    const { gx, gy } = raiseBarrier(s, ctx, STONE, 20, 3);
    const bx = gx * PIXEL, by = gy * PIXEL;
    // The mountain arrives in three tiers rather than all at once, so twenty cells of
    // stone appearing reads as ground being forced upward instead of a wall blinking
    // into existence.
    for (let i = 0; i < 3; i++) {
      s.time.delayedCall(i * 90, () => {
        const ty = by - i * 6 * PIXEL;
        s.fx.shards(bx, ty, 16, 'Earth', { speed: 190, life: 1.0, rise: 130 });
        s.fx.smoke(bx, ty, 7, 'Earth', { life: 2.6, size: 6.5, rise: 20 });
        s.fx.burst(bx, ty, 14, 'Earth', { speed: 90, life: 0.9, rise: 70 });
        s.fx.shake('Earth', 0.012, 200);
      });
    }
    s.fx.cracks(bx, by, 'Earth', { arms: 12, len: 66, life: 1.8, width: 3 });
    s.fx.shockwave(bx, by, 'Earth', { r0: 4, r1: 34 * PIXEL, life: 0.7, width: 7, rings: 3 });
    s.fx.tint('Earth', 0.16, 0.3);
    s.fx.shake('Earth', 0.014, 340);
    s.fx.hitstop(90);
  },

  // Doom Sickle: Dark's seeking form, and the only projectile in the game that is
  // dangerous along its whole path rather than at its endpoint. The curse is laid as
  // it flies; see Dark's projectileTick for the swathe it leaves.
  'Dark|Homing|*': (s, ctx) => {
    // Flag exactly the projectiles this cast created — Split spawns three, everything
    // else one — rather than the last N in the list, which could otherwise turn an
    // older Dark bolt still in flight into a sickle.
    const before = s.projectiles.length;
    formBolt(s, ctx, { homing: true });
    for (let i = before; i < s.projectiles.length; i++) s.projectiles[i].sickle = true;
    s.fx.spiral(ctx.originX, ctx.originY, 'Dark', { r: 40, life: 0.6, arms: 2, turns: 1.6 });
    s.fx.vignette('Dark', 0.3, 0.6);
  },

  // Ground Fault: the arc goes UNDER the wall. It hunts for buried conductive pockets
  // (water, acid) along the line of fire, hops between them out of sight, and comes up
  // on the far side of whatever the target thought was cover. abilities.md describes
  // exactly this; the code previously just let Pierce not stop at the first wall,
  // which looked identical to a normal beam.
  'Lightning|Beam|Pierce': (s, ctx) => {
    const angle = Math.atan2(ctx.targetY - ctx.originY, ctx.targetX - ctx.originX);
    const maxRange = (ELEMENTS.Lightning.beamRangePierce ?? 110);
    const ux = Math.cos(angle), uy = Math.sin(angle);

    // Walk the line of fire and, at each step, look down a few cells for something
    // that conducts. Those are the stepping stones the current actually travels.
    const nodes = [];
    for (let step = 4; step < maxRange; step += 3) {
      const gx = Math.round(ctx.originGx + ux * step);
      const gy = Math.round(ctx.originGy + uy * step);
      if (gx <= 1 || gx >= COLS - 2) break;
      for (let dy = 0; dy <= 10; dy++) {
        const y = gy + dy;
        if (y <= 1 || y >= ROWS - 2) break;
        const m = s.grid[s.idx(gx, y)];
        if (m === WATER || m === ACID) { nodes.push([gx, y]); break; }
      }
    }

    if (nodes.length < 2) {
      // Nothing buried to conduct through, so it behaves as the ordinary pierced
      // lance. The ability is only special when the ground cooperates, which is the
      // interesting version of "sneaky".
      formBeam(s, ctx);
      return;
    }

    // Hop along the buried nodes. Each hop is drawn, but they are underground, so the
    // arcs read as something travelling beneath the surface.
    let prev = [ctx.originGx, ctx.originGy];
    nodes.forEach((n, i) => {
      s.time.delayedCall(i * 22, () => {
        s.fx.bolt(prev[0] * PIXEL, prev[1] * PIXEL, n[0] * PIXEL, n[1] * PIXEL, 'Lightning', {
          life: 0.2, branches: 1, jitter: 7, width: 2,
        });
        s.fx.burst(n[0] * PIXEL, n[1] * PIXEL, 3, 'Lightning', { speed: 70, life: 0.25 });
        prev = n;
      });
    });

    // Then it surfaces at the far end and discharges there.
    const [ex, ey] = nodes[nodes.length - 1];
    s.time.delayedCall(nodes.length * 22 + 40, () => {
      s.fx.column(ex * PIXEL, ey * PIXEL, 'Lightning', { h: 16 * PIXEL, w: 4 * PIXEL, life: 0.45 });
      s.fx.tint('Lightning', 0.22, 0.12);
      detonateNow(s, { ...ctx, modifier: null, gx: ex, gy: ey }, Math.round(ctx.radius * 1.2));
    });
  },
};

// Water signatures that gather their water at the site of the spell (the wall's base,
// the storm's zone) rather than from the caster's reserve — see gatherForCast.
SIGNATURES['Water|Ground|Anchor'].drawsAtSite = true;
SIGNATURES['Water|Nova|Delay'].drawsAtSite = true;

function resolve(element, form, modifier) {
  return SIGNATURES[`${element}|${form}|${modifier}`]
    || SIGNATURES[`${element}|${form}|*`]
    || SIGNATURES[`${element}|*|${modifier}`]
    || null;
}

// ---------------------------------------------------------------------------
// channelled casts — spells you HOLD instead of firing
// ---------------------------------------------------------------------------
//
// Everything above is one-shot: press the button, the spell resolves, done. Three
// abilities cannot work that way, and one of them was already described as held in
// abilities.md without the engine having any way to express it ("Hydro Cannon ... for
// as long as it's held on target", "Soul Drain ... as long as the beam is held").
//
// So Beam is now a CHANNEL for every element: hold the button and the ray re-aims at
// the cursor every tick, spraying continuously. That single change is what turns Fire's
// beam into an actual flamethrower rather than a line that flashes once, and it makes
// the sustained-pressure wording in the design doc true. Beam combos that have their
// own hand-authored one-shot signature (Unraveling, Ground Fault) keep their shape.
//
// Telekinesis is the other channel, and it is not a ray at all — see channelTelekinesis.
//
// A channel is NOT free: it runs for at most CHANNEL_MAX seconds per press. Without a
// cap a flamethrower stops being a spell and becomes a terrain tool.

const CHANNEL_MAX = 3.5;

// How far a spray reaches, as a fraction of the element's one-shot beam range.
const CHANNEL_RANGE_MUL = 0.85;

// The spray leaves the caster's hands, not their centre. Nothing is written, drawn or
// damaged inside this radius, which is what stops a flamethrower cooking its own
// caster: the ray starts at the player's middle, so without this the first few cell
// steps were inside the player's own body — writing FIRE into them and reporting them
// as a body standing in the spray, every single frame.
// Derived from the caster rather than fixed, because the distance at which a spray
// clears your own body is a fact about how big your body is. The pad is what was
// tuned by hand; at the original body size this returns the 20 it always was.
const CHANNEL_MUZZLE_PAD = 11;
function muzzleFor(body) {
  const b = body || PLAYER_BOX;
  return Math.hypot(b.w, b.h) / 2 + CHANNEL_MUZZLE_PAD;
}

// Per-element spray character:
//   half    — half-angle of the cone at its tip, in radians. This is the shape.
//   rays    — raycasts per tick. More than one is what fills the cone with matter
//             rather than leaving a single line down its middle.
//   dps     — sustained damage to anything standing in it.
//   cadence — how often the cell-writing rays re-fire.
const CHANNEL_PROFILE = {
  Fire: { half: 0.34, rays: 3, dps: 34, cadence: 0.04, puff: 3 },
  Water: { half: 0.30, rays: 3, dps: 14, cadence: 0.04, puff: 3 },
  Earth: { half: 0.05, rays: 1, dps: 8, cadence: 0.07, puff: 1 },
  Lightning: { half: 0.13, rays: 1, dps: 40, cadence: 0.05, puff: 2 },
  Dark: { half: 0.07, rays: 1, dps: 26, cadence: 0.05, puff: 2 },
  Arcane: { half: 0.05, rays: 1, dps: 30, cadence: 0.045, puff: 2 },
};

// Telekinesis only reaches this far from the player — the whole point of the ability
// is that it is a close-range grab, not an arbitrary cursor-controlled crane.
const TK_RANGE = 30;          // cells
const TK_MAX_HELD = 14;       // objects carried at once
const TK_TEAR_INTERVAL = 0.11; // how often it rips a fresh chunk out of the terrain

function isChannel(element, form, modifier) {
  // Telekinesis: Arcane's orbit radius is already "a ring around the player", and
  // Absorb already means "pull in", so the combination reads as a grab without
  // needing a new form. Ward keeps every other Arcane Orbit modifier.
  if (element === 'Arcane' && form === 'Orbit' && modifier === 'Absorb') return true;
  if (form !== 'Beam') return false;
  // A Beam with its own one-shot signature keeps that shape rather than becoming a
  // spray — Unraveling and Ground Fault are single deliberate strikes.
  if (resolve(element, form, modifier)) return false;
  return true;
}

function startChannel(s, element, form, modifier, slot, radiusBoost = 1, caster = null) {
  const E = ELEMENTS[element];
  if (!E) return null;
  const ctx = makeContext(s, element, form, modifier, caster, null);
  if (radiusBoost !== 1) ctx.radius = Math.round(ctx.radius * radiusBoost);

  const kind = form === 'Beam' ? 'beam' : 'tk';
  const ch = {
    slot, element, form, modifier, ctx, kind,
    elapsed: 0, tickTimer: 0, netTimer: 0,
    // Telekinesis state.
    held: [], tearTimer: 0,
  };

  if (kind === 'tk') {
    s.fx.rune(ctx.originX, ctx.originY, 'Arcane', { r: 14, life: 0.5, spin: 2.4, glyph: 'grab' });
  }
  // A spray that has nothing to spray never starts.
  if (E.channelDraw && !E.channelDraw(s, ch, 0, true)) return null;
  s.fx.burst(ctx.originX, ctx.originY, 10, element, { speed: 60, life: 0.3 });
  return ch;
}

// Re-point the channel at wherever the caster and cursor are NOW. A held spell that
// kept its original aim would be unusable; re-aiming every tick is the whole feel of
// sweeping a flamethrower across a room.
function refreshAim(s, ch) {
  const body = ch.ctx.caster || s.player;
  const pointer = s.input.activePointer;
  const ctx = ch.ctx;
  ctx.originX = body.x + body.w / 2;
  ctx.originY = body.y + body.h / 2;
  ctx.originGx = Math.floor(ctx.originX / PIXEL);
  ctx.originGy = Math.floor(ctx.originY / PIXEL);
  ctx.casterX = ctx.originX;
  ctx.casterY = ctx.originY;
  ctx.targetX = pointer.worldX;
  ctx.targetY = pointer.worldY;
  ctx.facing = body.facing || ctx.facing;
}

// Returns false when the channel has run itself out and should be dropped.
function tickChannel(s, ch, dt) {
  ch.elapsed += dt;
  if (ch.elapsed >= CHANNEL_MAX) return false;
  // Lightning's EMP cuts a channel off mid-spray, same as it blocks a fresh cast.
  if (s.time.now < s.status.empUntil) return false;

  refreshAim(s, ch);

  // Water's spray keeps drawing water as it goes, and sputters out when there is none.
  const E = ELEMENTS[ch.element];
  if (E.channelDraw && !E.channelDraw(s, ch, dt)) return false;

  if (ch.kind === 'tk') {
    channelTelekinesis(s, ch, dt);
  } else {
    channelBeam(s, ch, dt);
  }

  // Keep other clients seeing the spray. Throttled hard: this is a visual relay, and
  // the terrain it writes already mirrors itself as cells.
  ch.netTimer -= dt;
  if (ch.netTimer <= 0) {
    ch.netTimer = 0.12;
    s.sendNet({
      t: 'cast',
      element: ch.element, form: ch.form, modifier: ch.modifier,
      ox: ch.ctx.originX, oy: ch.ctx.originY,
      tx: ch.ctx.targetX, ty: ch.ctx.targetY,
      r: ch.ctx.radius,
    });
  }
  return true;
}

function endChannel(s, ch) {
  if (ch.kind === 'tk') releaseTelekinesis(s, ch);
  const E = ELEMENTS[ch.element];
  if (E && E.channelEnd) E.channelEnd(s, ch);
  // A spray that simply stops looks like a dropped frame; a short vent of whatever it
  // was spraying, out of the nozzle, reads as the pressure dying off.
  const prof = CHANNEL_PROFILE[ch.element] || CHANNEL_PROFILE.Arcane;
  const angle = Math.atan2(ch.ctx.targetY - ch.ctx.originY, ch.ctx.targetX - ch.ctx.originX);
  const muzzle = muzzleFor(ch.ctx.caster || s.player);
  const mx = ch.ctx.originX + Math.cos(angle) * muzzle;
  const my = ch.ctx.originY + Math.sin(angle) * muzzle;
  s.fx.burst(mx, my, 7, ch.element, {
    speed: 50, life: 0.4, angle, spread: prof.half * 3,
    rise: ch.element === 'Fire' ? 30 : 0,
  });
}

// ---------------------------------------------------------------------------
// the beam channel: Flamethrower, Frost Spray, Hydro Cannon, Soul Drain, ...
// ---------------------------------------------------------------------------

function channelBeam(s, ch, dt) {
  const E = ELEMENTS[ch.element];
  const prof = CHANNEL_PROFILE[ch.element] || CHANNEL_PROFILE.Arcane;
  const ctx = ch.ctx;

  const baseAngle = Math.atan2(ctx.targetY - ctx.originY, ctx.targetX - ctx.originX);
  const ux = Math.cos(baseAngle), uy = Math.sin(baseAngle);
  const range = Math.round((ctx.modifier === 'Pierce'
    ? (E.beamRangePierce ?? 85)
    : (E.beamRange ?? 55)) * CHANNEL_RANGE_MUL) * PIXEL;

  // Frost Spray sprays; Hydro Cannon is a pressurised jet. Same element, same form,
  // opposite shapes — so the cone geometry has to come from the modifier, not just
  // from the element.
  let half = prof.half, rays = prof.rays;
  if (ch.element === 'Water' && ch.modifier !== 'Anchor') { half = 0.08; rays = 1; }

  // The nozzle: everything starts here rather than at the player's centre.
  const muzzle = muzzleFor(ctx.caster || s.player);
  const mx = ctx.originX + ux * muzzle;
  const my = ctx.originY + uy * muzzle;
  const spread = Math.tan(half);

  ch.tickTimer -= dt;
  const fire = ch.tickTimer <= 0;
  if (fire) ch.tickTimer = prof.cadence;

  // ---- sustained damage, down the axis of the cone ----
  //
  // The caster is never a target here. A spray physically emanates from your own
  // hands, so being "inside" it at the nozzle is not something you can avoid or
  // react to — it is just a bug that reads as the spell hurting you for casting it.
  // You can still burn yourself perfectly well by walking into the fire it leaves
  // behind, which applyEnvironmentDamage already handles.
  const samples = 9;
  for (let i = 1; i <= samples; i++) {
    const f = i / samples;
    const d = range * f;
    const px = mx + ux * d, py = my + uy * d;
    // The damage reach widens with the cone, so the wide end of a flamethrower
    // actually catches things the narrow end would miss.
    const reach = BODY_TOUCH + spread * d;
    for (const t of s.bodiesInRadius(px, py, reach)) {
      if (t.self) continue;
      if (t.enemy) s.damageEnemy(t.enemy, prof.dps * dt, ch.element);
      else if (Math.random() < dt * 6) s.reportHit(t.id, ch.element, prof.dps * 0.18, null);
    }
  }

  // ---- the matter: several rays fanned across the cone ----
  //
  // One ray leaves a line of cells down the middle of the cone no matter how wide the
  // artwork is. Fanning several, each writing a radius that GROWS with distance, is
  // what actually fills the cone with fire or ice.
  let reached = range;
  if (fire) {
    for (let rayI = 0; rayI < rays; rayI++) {
      // Spread the rays across the cone, jittered, so repeated ticks cover it evenly
      // rather than carving `rays` separate stripes.
      const t01 = rays === 1 ? 0 : (rayI / (rays - 1)) * 2 - 1;
      const angle = baseAngle + (t01 * 0.8 + (Math.random() - 0.5) * 0.7) * half;
      const rx = Math.cos(angle), ry = Math.sin(angle);

      const step = PIXEL * 0.9;
      let x = mx, y = my, traveled = 0;
      let lastGx = null, lastGy = null, lastCtx = null;

      while (traveled < range) {
        x += rx * step;
        y += ry * step;
        traveled += step;
        if (x < 0 || x >= WORLD_WIDTH || y < 0 || y >= WORLD_HEIGHT) break;
        const gx = Math.floor(x / PIXEL), gy = Math.floor(y / PIXEL);
        if (gx === lastGx && gy === lastGy) continue;
        lastGx = gx; lastGy = gy;

        // The element decides what the spray DOES to each cell. channelStep is the
        // per-element hook; beamStep is the fallback, so every element has a working
        // channel whether or not it has spray-specific behaviour. coneR is how wide
        // to paint at this distance — near the nozzle a single cell, at the tip a
        // fat blob, which is the widening expressed in matter rather than pixels.
        const f = traveled / range;
        const stepCtx = {
          ...ctx,
          beamAngle: angle, beamX: x, beamY: y,
          pierce: ctx.modifier === 'Pierce',
          coneR: 1 + Math.round(f * 2.4),
          coneF: f,
        };
        const hook = E.channelStep || E.beamStep;
        lastCtx = stepCtx;
        if (hook.call(E, s, gx, gy, stepCtx) === 'block') {
          if (traveled < reached) reached = traveled;
          break;
        }
      }
      // Where this ray stopped, for elements whose spray delivers something there
      // (Hydro Cannon's water lands against whatever the jet hit).
      if (E.channelRayEnd && lastCtx) E.channelRayEnd(s, lastGx, lastGy, lastCtx);
    }
  }

  // ---- the look ----
  // Redrawn every frame with a short life so it is continuous and always re-jittered.
  s.fx.cone(mx, my, baseAngle, reached, ch.element, {
    half, life: 0.1, steps: 9,
  });
  // Billowing along the cone: puffs spawned at random depths, thrown outward with a
  // spread that grows with distance. This is most of what sells it as flame or frost
  // rather than as a coloured triangle.
  for (let i = 0; i < prof.puff; i++) {
    const f = 0.25 + Math.random() * 0.75;
    const d = reached * f;
    const off = (Math.random() - 0.5) * 2 * spread * d;
    const px = mx + ux * d - uy * off;
    const py = my + uy * d + ux * off;
    s.fx.burst(px, py, 2, ch.element, {
      speed: 40 + 70 * f, life: 0.3 + 0.35 * f, size: 1.1 + f * 1.3,
      angle: baseAngle, spread: half * 4,
      rise: ch.element === 'Fire' ? 40 : 0,
    });
  }
  // Fire and frost both roll smoke/vapour off the far end of the jet.
  if (Math.random() < 0.4) {
    s.fx.smoke(mx + ux * reached * 0.9, my + uy * reached * 0.9, 2, ch.element, {
      life: 1.1, size: 3.2, rise: ch.element === 'Fire' ? 50 : 14, speed: 40,
    });
  }
  // A flare at the nozzle, so the spray visibly comes FROM you.
  s.fx.burst(mx, my, 2, ch.element, {
    speed: 150, life: 0.2, angle: baseAngle, spread: half * 1.6, size: 1.2,
  });
}

// ---------------------------------------------------------------------------
// telekinesis
// ---------------------------------------------------------------------------
//
// Hold to grab: every loose object within TK_RANGE is lifted, and if there is nothing
// loose nearby it TEARS chunks out of the terrain to give you something to throw. The
// held mass hovers between you and the cursor — clamped to the range, which is the
// constraint that makes the ability feel like telekinesis rather than a crane — and
// releasing hurls the whole lot wherever you are pointing.
//
// It is built entirely on the debris objects the world already simulates, so anything
// it throws collides, settles and rebuilds terrain exactly as blast debris does.

function channelTelekinesis(s, ch, dt) {
  const ctx = ch.ctx;
  const px = ctx.originX, py = ctx.originY;
  const rangePx = TK_RANGE * PIXEL;

  // Where the held mass wants to sit: toward the cursor, but never further out than
  // the ability's reach.
  const dx = ctx.targetX - px, dy = ctx.targetY - py;
  const dist = Math.max(1, Math.hypot(dx, dy));
  const holdDist = Math.min(dist, rangePx * 0.8);
  const hx = px + (dx / dist) * holdDist;
  const hy = py + (dy / dist) * holdDist;
  ch.holdX = hx; ch.holdY = hy;

  // -- grab anything loose that has come into range --
  for (const d of s.debris) {
    if (d.tkHeld) continue;
    if (ch.held.length >= TK_MAX_HELD) break;
    if (Math.hypot(d.x - px, d.y - py) > rangePx) continue;
    d.tkHeld = true;
    d.settleTimer = 999;   // it cannot settle while it is being carried
    d.bounces = 3;
    ch.held.push(d);
    s.fx.burst(d.x, d.y, 4, 'Arcane', { speed: 40, life: 0.3 });
  }

  // -- if there is nothing to hold, rip some out of the world --
  ch.tearTimer -= dt;
  if (ch.tearTimer <= 0 && ch.held.length < TK_MAX_HELD) {
    ch.tearTimer = TK_TEAR_INTERVAL;
    const torn = tearLooseCell(s, ctx, rangePx);
    if (torn) {
      torn.tkHeld = true;
      torn.settleTimer = 999;
      torn.bounces = 3;
      ch.held.push(torn);
    }
  }

  // -- carry what we have --
  for (let i = ch.held.length - 1; i >= 0; i--) {
    const d = ch.held[i];
    // Dropped out of the world's debris list (it settled or expired elsewhere), or
    // has drifted out of reach: let it go.
    if (!s.debris.includes(d) || Math.hypot(d.x - px, d.y - py) > rangePx * 1.6) {
      d.tkHeld = false;
      d.settleTimer = 6;
      ch.held.splice(i, 1);
      continue;
    }
    // Spring toward the hold point, with each object offset around it so the mass
    // churns instead of collapsing into a single point.
    const phase = (i / Math.max(1, ch.held.length)) * Math.PI * 2 + ch.elapsed * 3.2;
    const swirl = 9 + (i % 3) * 7;
    const tx = hx + Math.cos(phase) * swirl;
    const ty = hy + Math.sin(phase) * swirl;
    const ddx = tx - d.x, ddy = ty - d.y;
    d.vx += ddx * 14 * dt * 6;
    d.vy += ddy * 14 * dt * 6;
    // Heavy damping, or the spring overshoots and the mass oscillates wildly.
    d.vx *= 0.86;
    d.vy *= 0.86;
    if (Math.random() < 0.12) {
      s.fx.burst(d.x, d.y, 1, 'Arcane', { speed: 14, life: 0.3, size: 1 });
    }
  }

  // -- the field itself --
  if (Math.random() < 0.5) {
    s.fx.burst(hx, hy, 1, 'Arcane', { speed: 20, life: 0.3, size: 1.2 });
  }
  s.fx.ring(px, py, 'Arcane', { r0: rangePx, r1: rangePx, life: 0.08, width: 1 });
  s.fx.spiral(hx, hy, 'Arcane', { r: 22, life: 0.12, arms: 2, turns: 0.9, inward: true });
  // A tether from the caster to the held mass, so the ability reads as *yours*.
  s.fx.beam(px, py, hx, hy, 'Arcane', { life: 0.07, width: 1, jitter: 6 });
}

// Pulls one solid cell out of the terrain inside the reach and turns it into a debris
// object. Sampled at random rather than nearest-first so repeated tears chew a ragged
// hole instead of boring a neat tunnel.
function tearLooseCell(s, ctx, rangePx) {
  const pgx = Math.floor(ctx.originX / PIXEL), pgy = Math.floor(ctx.originY / PIXEL);
  // Bias sampling toward the cursor: you should be able to choose roughly what you
  // tear out rather than getting whatever happened to be underfoot.
  const aimAng = Math.atan2(ctx.targetY - ctx.originY, ctx.targetX - ctx.originX);
  for (let attempt = 0; attempt < 26; attempt++) {
    const ang = aimAng + (Math.random() - 0.5) * 2.2;
    const d = 3 + Math.random() * (TK_RANGE - 3);
    const x = Math.round(pgx + Math.cos(ang) * d);
    const y = Math.round(pgy + Math.sin(ang) * d);
    if (x <= 1 || x >= COLS - 2 || y <= 1 || y >= ROWS - 2) continue;
    const id = s.idx(x, y);
    const m = s.grid[id];
    if (!IS_SOLID[m] || m === BEDROCK) continue;
    // spawnDebris silently refuses when the debris list is full, so ask it FIRST and
    // only erase the cell once we know we got an object back. The other order digs a
    // hole and hands back nothing, quietly deleting terrain for free.
    const before = s.debris.length;
    s.spawnDebris(x, y, m, x, y, false);
    if (s.debris.length === before) return null;
    s.setCell(id, EMPTY);
    const torn = s.debris[s.debris.length - 1];
    s.fx.burst(x * PIXEL, y * PIXEL, 3, 'Arcane', { speed: 50, life: 0.3 });
    void rangePx;
    return torn;
  }
  return null;
}

// Let go: everything held is thrown at the cursor, hard, and flagged so that it hurts
// what it hits. This is the payoff, so it gets the full impact stack.
function releaseTelekinesis(s, ch) {
  const ctx = ch.ctx;
  if (!ch.held.length) return;
  const ang = Math.atan2(ctx.targetY - ctx.originY, ctx.targetX - ctx.originX);
  // More mass thrown at once hits harder per object, so a long grab is rewarded.
  const power = 340 + Math.min(ch.held.length, TK_MAX_HELD) * 26;

  for (const d of ch.held) {
    d.tkHeld = false;
    d.settleTimer = 6;
    d.bounces = 1;
    const spread = (Math.random() - 0.5) * 0.30;
    d.vx = Math.cos(ang + spread) * power * (0.85 + Math.random() * 0.4);
    d.vy = Math.sin(ang + spread) * power * (0.85 + Math.random() * 0.4);
    // The ordinary falling-impact path handles this chunk too; this flag preserves
    // the extra Telekinesis throw bonus against solid material.
    d.tkThrown = 14 + ch.held.length * 1.6;
    // ...but not the thrower, for the first fraction of a second. Releasing at your
    // own feet should not brain you before the rock has left your hand.
    d.tkArm = 0.18;
    s.fx.burst(d.x, d.y, 3, 'Arcane', { speed: 90, life: 0.3, angle: ang, spread: 0.8 });
  }

  const hx = ch.holdX ?? ctx.originX, hy = ch.holdY ?? ctx.originY;
  s.fx.shockwave(hx, hy, 'Arcane', { r0: 3, r1: 60, life: 0.35, width: 3, rings: 2 });
  s.fx.streaks(hx, hy, 14, 'Arcane', { speed: 320, life: 0.28, angle: ang, spread: 0.9 });
  s.fx.shake('Arcane', 0.008, 150);
  s.fx.hitstop(38);
  ch.held.length = 0;
}

// ---------------------------------------------------------------------------
// entry point
// ---------------------------------------------------------------------------

function cast(s, element, form, modifier, radiusBoost = 1, caster = null, aim = null) {
  const E = ELEMENTS[element];
  if (!E) return;
  const ctx = makeContext(s, element, form, modifier, caster, aim);
  GameAudio.cast(element, ctx.originX, ctx.originY);
  if (radiusBoost !== 1) ctx.radius = Math.round(ctx.radius * radiusBoost);

  const sig = resolve(element, form, modifier);
  const launch = () => {
    if (sig) { sig(s, ctx); return; }
    const formFn = FORMS[form];
    if (formFn) formFn(s, ctx);
  };

  // Water pays for itself before it exists (see the matter section): from the
  // reserve, then from water in reach. Site-drawn signatures gather their own.
  if (element === 'Water' && !(sig && sig.drawsAtSite)) {
    const cost = waterCost(form, modifier);
    const matter = gatherForCast(s, ctx, cost);
    if (!matter) return;
    ctx.matter = matter;
    if (modifier === 'Split' && WATER_SPLIT_PARTS[form]) matter.parts = WATER_SPLIT_PARTS[form];
    // A short draw casts a smaller spell: area follows mass.
    if (cost > 0 && matter.total < cost) {
      ctx.radius = Math.max(3, Math.round(ctx.radius * Math.sqrt(matter.total / cost)));
    }
    // Water pulled from the world has to arrive before it can be thrown.
    if (matter.windup > 0.05) {
      s.time.delayedCall(matter.windup * 1000, () => {
        const body = casterBody(s, ctx);
        if (body.dead) {
          pourWater(s, Math.floor((body.x + body.w / 2) / PIXEL), Math.floor((body.y + body.h) / PIXEL) - 1, matter.left, 8);
          return;
        }
        refreshOrigin(ctx, body);
        launch();
      });
      return;
    }
  }
  launch();
}

// Display names for abilities.md's named entries, so the HUD can tell you that the
// combination you just assembled is called "Wildfire" rather than "Fire Bolt Chain".
const ABILITY_NAMES = {
  'Fire|Bolt|Chain': 'Wildfire',
  'Fire|Ground|Anchor': 'Fire Wall',
  'Fire|*|Amplify': 'Inferno Core',
  'Water|Ground|Anchor': 'Ice Wall',
  'Water|Nova|Delay': 'Rain Dance',
  'Water|*|Absorb': 'Drought',
  'Earth|Ground|Anchor': 'Fortify',
  'Earth|Ground|Chain': 'Rockslide',
  'Earth|Ground|Volatile': 'Landslide',
  'Earth|Ground|Amplify': 'Mountain',
  'Earth|Beam|Pierce': 'Earthquake',
  'Earth|Mine|Absorb': 'Sinkhole',
  'Lightning|Mine|Anchor': 'Tesla Coil',
  'Lightning|Mine|Delay': 'Storm Brewing',
  'Lightning|Bolt|Split': 'Forked Bolt',
  'Lightning|Beam|Pierce': 'Ground Fault',
  'Lightning|Nova|Chain': 'Storm Call',
  'Lightning|Nova|Volatile': 'Storm Front',
  'Lightning|Orbit|Absorb': 'Overcharge',
  'Dark|Bolt|Chain': 'Plague',
  'Dark|Bolt|Split': 'Triple Curse',
  'Dark|Bolt|Pierce': 'Wraith Step',
  'Dark|Bolt|Delay': 'Slow Death',
  'Dark|Mine|Anchor': 'Soul Anchor',
  'Dark|Nova|Volatile': 'Panic',
  'Dark|Nova|Absorb': 'Harvest',
  'Dark|*|Amplify': 'Despair',
  'Arcane|Beam|Chain': 'Unraveling',
  'Arcane|Mine|Anchor': 'Rift Anchor',
  'Arcane|*|Absorb': 'Implosion',
  // Held casts. Frost Spray is Water's answer to the flamethrower and reuses this
  // element's established "Anchor means ice" rule (see Ice Wall); Telekinesis uses
  // Orbit for its radius-around-the-player and Absorb for the grab.
  'Water|Beam|Anchor': 'Frost Spray',
  'Arcane|Orbit|Absorb': 'Telekinesis',
};

// The (base) identities — the ability you get from an element+form regardless of
// modifier. Shown without a modifier-specific name.
const BASE_NAMES = {
  // Fire and Arcane had no base names at all, so 13 of their 16 element+form pairs
  // showed no ability name on the wheel while every other element named all eight.
  // These fill the gap; the behaviour they name is the element's own form hook.
  'Fire|Bolt': 'Fireball', 'Fire|Nova': 'Detonation', 'Fire|Beam': 'Flamethrower',
  'Fire|Ground': 'Fire Wave', 'Fire|Orbit': 'Ember Ring', 'Fire|Trail': 'Cinder Trail',
  'Fire|Mine': 'Firebomb', 'Fire|Homing': 'Hellseeker',
  'Arcane|Nova': 'Rupture', 'Arcane|Beam': 'Disintegration Ray',
  'Arcane|Ground': 'Rift Wave', 'Arcane|Trail': 'Erasure Line', 'Arcane|Homing': 'Seeker Rift',

  'Water|Ground': 'Flash Flood', 'Water|Nova': 'Maelstrom', 'Water|Bolt': 'Ice Shard',
  'Water|Beam': 'Hydro Cannon', 'Water|Trail': 'Riverwalk', 'Water|Homing': 'Tide Call',
  'Water|Mine': 'Geyser Trap', 'Water|Orbit': 'Tide Ring',
  'Earth|Beam': 'Trench Ray', 'Earth|Trail': 'Rubble Road', 'Earth|Mine': 'Spike Trap',
  'Earth|Bolt': 'Boulder', 'Earth|Nova': 'Faultline', 'Earth|Ground': 'Stone Wall',
  'Earth|Orbit': 'Tectonic Ribs', 'Earth|Homing': 'Sinkstone',
  'Lightning|Mine': 'Chain Rune', 'Lightning|Bolt': 'Static Snap',
  'Lightning|Homing': 'Marked for Storm', 'Lightning|Nova': 'Discharge',
  'Lightning|Beam': 'Arc Lance', 'Lightning|Ground': 'Static Field',
  'Lightning|Orbit': 'Ion Halo', 'Lightning|Trail': 'Live Wire',
  'Dark|Bolt': 'Soul Spike', 'Dark|Beam': 'Soul Drain', 'Dark|Mine': 'Hex Trap',
  'Dark|Nova': 'Wail', 'Dark|Trail': 'Wake of Sorrow', 'Dark|Ground': 'Grasping Shade',
  'Dark|Orbit': 'Shroud', 'Dark|Homing': 'Doom Sickle',
  'Arcane|Bolt': 'True Strike', 'Arcane|Orbit': 'Ward', 'Arcane|Mine': 'Null Trap',
};

function abilityName(element, form, modifier) {
  return ABILITY_NAMES[`${element}|${form}|${modifier}`]
    || ABILITY_NAMES[`${element}|${form}|*`]
    || ABILITY_NAMES[`${element}|*|${modifier}`]
    || BASE_NAMES[`${element}|${form}`]
    || null;
}

return {
  ELEMENTS, FORMS, SIGNATURES, ABILITY_NAMES,
  cast, detonate, detonateNow, schedulePulses, anchorPulses, abilityName,
  // Held casts. game.js owns the lifecycle (button down / held / released); this
  // module owns what the channel actually does each tick.
  isChannel, startChannel, tickChannel, endChannel, CHANNEL_MAX,
  // Exported so game.js's mine-turret loop fires the element's full impact stack
  // rather than its world effect alone — a Tesla Coil discharging with no signature
  // FX was the one place a blast could happen and look like nothing.
  elementImpact,
  // Water's matter: the reserve, wading refill, and what the HUD reads out.
  WATER_RESERVE_CAP, waterStatus, waterNearby, wade,
};

})();
