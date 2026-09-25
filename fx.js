// Visual effects library for the spell system.
//
// Everything a spell does visually beyond writing cells into the world goes through
// here: particles, beams, lightning bolts, shockwave rings, columns, ground runes.
// The pixel grid (renderGrid) is still the strongest visual lever in the game — a
// spell that writes cells always reads as more real than one that only draws on top —
// so this layer is for the parts matter can't express: motion, glow, shape, impact.
//
// Design rule: every element must FEEL different at the same call site. So the
// element argument selects not just a colour but a whole motion model (fire embers
// rise and flicker, earth chips tumble heavily, lightning streaks in straight jittered
// lines, dark motes crawl back toward the caster). Same primitive, six behaviours.
//
// ---------------------------------------------------------------------------
// The impact vocabulary
// ---------------------------------------------------------------------------
//
// A blast that only spawns particles reads as decoration. What makes a hit feel like
// a hit is a stack of cues landing in a specific order, so the primitives below are
// grouped by which part of that stack they serve:
//
//   FRAME     hitstop()  — the whole world hesitates for ~60ms. This is the single
//                          biggest lever in the file; an explosion with hitstop and
//                          one without are not the same explosion.
//   SCREEN    tint() / flash() / vignette() — full-frame colour and darkness, drawn
//                          on a non-scrolling layer so they sit still while the
//                          camera moves.
//   FORCE     shake()    — per-element profiles, so Earth rolls and Lightning snaps.
//   SHAPE     shockwave() / cracks() / implode() / spiral() / column() / ring()
//   MATTER    shards() / smoke() / streaks() / burst()
//   RESIDUE   afterglow() — the part that is still there a second later, which is
//                          what stops a blast from feeling like it never happened.
//
// Nothing here simulates; every effect is a dumb bag of numbers that ages out and
// redraws itself from a fresh random seed each frame. That is deliberate — flicker
// comes free, and no effect can ever leak state into the world.

// Per-element colour ramps. `core` is the hot centre, `glow` the body, `deep` the
// outer falloff, `spark` the particle tint, `accent` a secondary hue for variety,
// `smoke` the tint of the puffs an impact leaves hanging in the air.
const FX_PALETTE = {
  Fire: { core: 0xffdd33, glow: 0xff6600, deep: 0x8a2400, spark: 0xffaa33, accent: 0xff4422, smoke: 0x3a2a22 },
  Water: { core: 0xe8f8ff, glow: 0x3a9bdc, deep: 0x14407a, spark: 0x8fd4ff, accent: 0x66ccee, smoke: 0x9fc4d8 },
  Earth: { core: 0xe0c898, glow: 0x8a6a3c, deep: 0x3a2a18, spark: 0xb09060, accent: 0x6a5030, smoke: 0x6b5a44 },
  Lightning: { core: 0xffffff, glow: 0x9f7cff, deep: 0x2a1a7a, spark: 0xd0c0ff, accent: 0x66ccff, smoke: 0x5a4a8a },
  Dark: { core: 0xcc88ff, glow: 0x7a3bcf, deep: 0x1a0530, spark: 0x9a5ae0, accent: 0x4a1080, smoke: 0x1c0a2e },
  Arcane: { core: 0xeafcff, glow: 0x66d9ff, deep: 0x116688, spark: 0xa0f0ff, accent: 0x9966ff, smoke: 0x2a5a70 },
  Air: { core: 0xf0fbff, glow: 0xb8e6f0, deep: 0x5c7a82, spark: 0xdff5fa, accent: 0x9fd8e8, smoke: 0xc8ecf5 },
};

// Fallback so an unknown element still draws something rather than throwing.
const FX_DEFAULT_PALETTE = FX_PALETTE.Arcane;

// Shake character, per element. Amplitude and duration are multipliers on whatever
// the call site asks for, so one `shake('Earth', ...)` lands heavier and rolls longer
// than the same call for Lightning without every caster having to know that.
const FX_SHAKE = {
  Fire: { amp: 1.0, dur: 1.0 },
  Water: { amp: 0.75, dur: 1.35 },
  Earth: { amp: 1.7, dur: 1.8 },   // low, heavy, long — the ground itself moved
  Lightning: { amp: 0.7, dur: 0.4 }, // a snap, gone before you register it
  Dark: { amp: 0.55, dur: 2.2 },   // a shudder that will not quite stop
  Arcane: { amp: 1.15, dur: 0.75 },
  Air: { amp: 0.6, dur: 0.5 },   // a snap of pressure, gone as fast as Lightning's
};

// Particle motion models. Each is a per-frame tweak applied on top of the shared
// integration in updateParticles, which is what makes the six elements distinguishable
// even when they spawn the same number of particles at the same speed.
const FX_MOTION = {
  Fire: (p, dt) => {
    p.vy -= 140 * dt;          // heat rises
    p.vx *= 0.90;
    p.vy *= 0.94;
    p.flicker = true;
  },
  Water: (p, dt) => {
    p.vy += 320 * dt;          // droplets arc and fall
    p.vx *= 0.98;
  },
  Earth: (p, dt) => {
    p.vy += 620 * dt;          // heavy, short-lived chips
    p.vx *= 0.86;
    p.vy *= 0.90;
    p.spin = true;
  },
  Lightning: (p, dt) => {
    // barely affected by anything — travels in a straight, fast line
    p.vx *= 0.97;
    p.vy *= 0.97;
    p.jitter = true;
  },
  Dark: (p, dt) => {
    p.vx *= 0.96;
    p.vy *= 0.96;
    p.vy -= 20 * dt;           // slow malevolent drift upward
    p.seek = true;             // drawn toward the caster when one is known
  },
  Arcane: (p, dt) => {
    p.vx *= 0.99;              // clean geometric travel, no gravity
    p.vy *= 0.99;
  },
  Air: (p, dt) => {
    p.vx *= 0.985;              // barely any drag — a gust carries far
    p.vy *= 0.985;
    p.vy -= 30 * dt;             // a light upward loft, never a fall
  },
};

// Raised well above the old ceiling: the impact stack spends particles freely now
// (a single big detonation can ask for 120 across shards, smoke and sparks), and
// hitting the cap mid-blast is what makes an explosion look half-drawn.
const FX_MAX_PARTICLES = 2400;
const FX_MAX_EFFECTS = 340;

class FXSystem {
  constructor(scene) {
    this.scene = scene;
    // Drawn above terrain and the player but below the spell wheel / HUD.
    this.gfx = scene.add.graphics().setDepth(16);
    // Residue sits UNDER the live effects so a fresh blast reads on top of the scorch
    // and steam its predecessor left behind.
    this.glowGfx = scene.add.graphics().setDepth(15.5);
    // Screen-space layer: tints, flashes and vignettes must not scroll with the world,
    // or a full-frame wash slides off the edge of the screen as the camera moves.
    this.screenGfx = scene.add.graphics().setScrollFactor(0).setDepth(19);
    this.particles = [];
    this.effects = [];
    this.screenEffects = [];
    // A *sustained* darkening, as opposed to the one-shot vignette() effect: the scene
    // sets this every frame from the player's current vision level, so a Wail curse
    // holds the world closed in for its whole duration instead of flickering once.
    this.visionDim = 0;
    this.visionElement = 'Dark';
    this.time = 0;
  }

  palette(element) {
    return FX_PALETTE[element] || FX_DEFAULT_PALETTE;
  }

  // ---------- frame: hitstop ----------

  // Freezes the world for a beat. The scene's update() divides its own dt by this,
  // so the simulation, projectiles, particles and player all hesitate together while
  // Phaser's clock (and therefore every delayedCall a spell scheduled) keeps running.
  //
  // Capped hard: past about 120ms a freeze stops reading as impact and starts reading
  // as a dropped frame. Overlapping calls take the longest one rather than stacking,
  // so a chain reaction cannot lock the game up.
  hitstop(ms = 55) {
    const now = this.scene.time.now;
    const until = now + Math.min(ms, 120);
    if (!this.scene.hitstopUntil || this.scene.hitstopUntil < until) {
      this.scene.hitstopUntil = until;
    }
  }

  // ---------- particles ----------

  // opts: { count, speed, spread, angle, life, size, color, gravity, drag, rise,
  //         seekX, seekY, shape, spin, fade }
  burst(x, y, count, element, opts = {}) {
    if (this.particles.length >= FX_MAX_PARTICLES) return;
    const pal = this.palette(element);
    const speed = opts.speed ?? 70;
    const life = opts.life ?? 0.5;
    const size = opts.size ?? 1.4;
    const color = opts.color ?? pal.spark;
    const spread = opts.spread ?? Math.PI * 2;
    const baseAngle = opts.angle ?? 0;
    const rise = opts.rise ?? 0;
    const spin = opts.spin ?? 0;

    for (let i = 0; i < count; i++) {
      const a = baseAngle + (Math.random() - 0.5) * spread;
      const spd = speed * (0.35 + Math.random() * 0.9);
      this.particles.push({
        x, y,
        vx: Math.cos(a) * spd,
        vy: Math.sin(a) * spd - rise,
        life: life * (0.7 + Math.random() * 0.6),
        maxLife: life,
        size: size * (0.6 + Math.random() * 0.8),
        color,
        element,
        shape: opts.shape ?? 'circle',
        seekX: opts.seekX,
        seekY: opts.seekY,
        gravity: opts.gravity ?? 0,
        // Shards and chips tumble; everything else keeps a fixed orientation.
        rot: Math.random() * Math.PI * 2,
        rotSpeed: spin ? (Math.random() - 0.5) * spin : 0,
      });
    }
  }

  // Solid chunks thrown off an impact: triangular, tumbling, and heavy enough to
  // arc visibly. This is the difference between "a cloud appeared" and "something
  // broke". Earth and Water (ice) lean on it hardest.
  shards(x, y, count, element, opts = {}) {
    const pal = this.palette(element);
    this.burst(x, y, count, element, {
      speed: opts.speed ?? 150,
      life: opts.life ?? 0.75,
      size: opts.size ?? 2.4,
      color: opts.color ?? pal.glow,
      gravity: opts.gravity ?? 420,
      spread: opts.spread ?? Math.PI * 2,
      angle: opts.angle ?? 0,
      rise: opts.rise ?? 60,
      shape: 'shard',
      spin: opts.spin ?? 14,
    });
  }

  // Soft dark puffs that expand, drift and hang around. An explosion without smoke
  // clears instantly and therefore never happened; this is the cue that says it did.
  smoke(x, y, count, element, opts = {}) {
    const pal = this.palette(element);
    this.burst(x, y, count, element, {
      speed: opts.speed ?? 34,
      life: opts.life ?? 1.7,
      size: opts.size ?? 5.5,
      color: opts.color ?? pal.smoke,
      rise: opts.rise ?? 34,
      spread: opts.spread ?? Math.PI * 2,
      angle: opts.angle ?? 0,
      shape: 'puff',
    });
  }

  // Thin fast lines drawn along their own velocity. Reads as speed rather than as
  // debris — used for beams venting, lightning spray and Arcane's clean geometry.
  streaks(x, y, count, element, opts = {}) {
    this.burst(x, y, count, element, {
      speed: opts.speed ?? 260,
      life: opts.life ?? 0.3,
      size: opts.size ?? 2.2,
      color: opts.color,
      spread: opts.spread ?? Math.PI * 2,
      angle: opts.angle ?? 0,
      rise: opts.rise ?? 0,
      shape: 'streak',
    });
  }

  updateParticles(dt) {
    const arr = this.particles;
    for (let i = arr.length - 1; i >= 0; i--) {
      const p = arr[i];
      p.life -= dt;
      if (p.life <= 0) {
        arr.splice(i, 1);
        continue;
      }
      if (p.gravity) p.vy += p.gravity * dt;

      const motion = FX_MOTION[p.element];
      if (motion) motion(p, dt);

      // Puffs ignore their element's motion model — smoke behaves like smoke whether
      // it came off a fireball or a rockslide — and simply slow, rise and swell.
      if (p.shape === 'puff') {
        p.vx *= 0.94;
        p.vy = p.vy * 0.94 - 8 * dt;
      }

      // Dark's motes crawl back toward the caster: the one element whose particles
      // move toward you rather than away, which is most of why Dark reads as sinister.
      if (p.seek && p.seekX !== undefined) {
        const dx = p.seekX - p.x, dy = p.seekY - p.y;
        const d = Math.max(1, Math.hypot(dx, dy));
        p.vx += (dx / d) * 90 * dt;
        p.vy += (dy / d) * 90 * dt;
      }
      // Lightning particles snap along a jittered line instead of curving.
      if (p.jitter) {
        p.vx += (Math.random() - 0.5) * 400 * dt;
        p.vy += (Math.random() - 0.5) * 400 * dt;
      }

      if (p.rotSpeed) p.rot += p.rotSpeed * dt;

      p.x += p.vx * dt;
      p.y += p.vy * dt;
    }
  }

  drawParticles() {
    const g = this.gfx;
    for (const p of this.particles) {
      const t = Math.max(0, p.life / p.maxLife);
      // Fire flickers as it dies; everything else fades smoothly.
      const a = p.flicker ? t * (0.55 + Math.random() * 0.45) : t;
      const s = p.size * (0.35 + t * 0.65) * 3;

      if (p.shape === 'square') {
        g.fillStyle(p.color, a);
        g.fillRect(p.x - s / 2, p.y - s / 2, s, s);
      } else if (p.shape === 'shard') {
        // A tumbling triangle. Three rotated points is the cheapest shape that still
        // reads as a solid fragment rather than a dot.
        const c = Math.cos(p.rot), sn = Math.sin(p.rot);
        const pt = (dx, dy) => [p.x + dx * c - dy * sn, p.y + dx * sn + dy * c];
        const [ax, ay] = pt(s, 0);
        const [bx, by] = pt(-s * 0.6, s * 0.7);
        const [cx, cy] = pt(-s * 0.6, -s * 0.7);
        g.fillStyle(p.color, a);
        g.fillTriangle(ax, ay, bx, by, cx, cy);
      } else if (p.shape === 'streak') {
        // Drawn along its own velocity, so the faster it moves the longer it looks.
        const sp = Math.hypot(p.vx, p.vy);
        if (sp < 1) continue;
        const len = Math.min(26, sp * 0.045) * (0.4 + t);
        g.lineStyle(Math.max(1, s * 0.4), p.color, a);
        g.beginPath();
        g.moveTo(p.x, p.y);
        g.lineTo(p.x - (p.vx / sp) * len, p.y - (p.vy / sp) * len);
        g.strokePath();
      } else if (p.shape === 'puff') {
        // Swells as it dies rather than shrinking — the one particle that gets
        // bigger and fainter, which is exactly how smoke dissipates.
        const r = p.size * 3 * (1.5 - t * 0.5);
        g.fillStyle(p.color, a * 0.32);
        g.fillCircle(p.x, p.y, r);
        g.fillStyle(p.color, a * 0.18);
        g.fillCircle(p.x, p.y, r * 1.5);
      } else {
        g.fillStyle(p.color, a);
        g.fillCircle(p.x, p.y, s);
      }
    }
  }

  // ---------- timed overlay effects ----------
  //
  // Every effect is { kind, x, y, life, maxLife, ... } and self-expires. They are
  // drawn every frame with a fresh random seed for flicker, so nothing here needs
  // per-effect update logic beyond ageing.

  _push(effect) {
    if (this.effects.length >= FX_MAX_EFFECTS) this.effects.shift();
    effect.maxLife = effect.life;
    this.effects.push(effect);
  }

  _pushScreen(effect) {
    // Screen effects are few and large; a backlog of them would just muddy the frame.
    if (this.screenEffects.length >= 12) this.screenEffects.shift();
    effect.maxLife = effect.life;
    this.screenEffects.push(effect);
  }

  // A sustained beam — this is what makes Beam-form spells read differently from
  // Bolt-form: the lance *stays on screen* and keeps flickering rather than flashing.
  beam(x1, y1, x2, y2, element, opts = {}) {
    this._push({
      kind: 'beam', x: x1, y: y1, x2, y2, element,
      life: opts.life ?? 0.3,
      width: opts.width ?? 4,
      jitter: opts.jitter ?? 1.5,
    });
  }

  // Forked lightning between two points. Recursively branches, which is what makes
  // it read as electricity rather than a bent line.
  bolt(x1, y1, x2, y2, element, opts = {}) {
    const branches = opts.branches ?? 3;
    const segs = opts.segments ?? 8;
    const points = this._fork(x1, y1, x2, y2, segs, opts.jitter ?? 14);
    const forks = [];
    for (let b = 0; b < branches; b++) {
      // Branch from a random point along the spine, out to a random nearby endpoint.
      const at = points[1 + ((Math.random() * (points.length - 2)) | 0)];
      if (!at) continue;
      const ex = at[0] + (Math.random() - 0.5) * 90;
      const ey = at[1] + (Math.random() - 0.5) * 90;
      forks.push(this._fork(at[0], at[1], ex, ey, 4, 10));
    }
    this._push({
      kind: 'bolt', points, forks, element,
      life: opts.life ?? 0.22,
      width: opts.width ?? 2,
    });
  }

  // Every arc in one instant rather than a stagger. Storm Call and Tesla Coil are
  // *simultaneous* by design, and a web that appears all at once looks nothing like
  // the same arcs fired 120ms apart.
  arcNet(x, y, points, element, opts = {}) {
    for (const [px, py] of points) {
      this.bolt(x, y, px, py, element, {
        life: opts.life ?? 0.26,
        branches: opts.branches ?? 3,
        jitter: opts.jitter ?? 18,
        width: opts.width ?? 2,
      });
    }
  }

  // Recursive midpoint displacement: start with a straight line, repeatedly shove the
  // midpoint sideways, recurse. Standard lightning-generation trick.
  _fork(x1, y1, x2, y2, segs, jitter) {
    let pts = [[x1, y1], [x2, y2]];
    let amp = jitter;
    let n = 1;
    for (let pass = 0; pass < segs; pass++) {
      const next = [];
      for (let i = 0; i < pts.length - 1; i++) {
        const [ax, ay] = pts[i], [bx, by] = pts[i + 1];
        const mx = (ax + bx) / 2, my = (ay + by) / 2;
        // Displace perpendicular to the segment so the kink is always sideways.
        const dx = bx - ax, dy = by - ay;
        const len = Math.max(1, Math.hypot(dx, dy));
        const nx = -dy / len, ny = dx / len;
        const off = (Math.random() - 0.5) * amp;
        next.push(pts[i], [mx + nx * off, my + ny * off]);
      }
      next.push(pts[pts.length - 1]);
      pts = next;
      amp *= 0.55;
      n *= 2;
      if (n >= 32) break;
    }
    return pts;
  }

  // Expanding shockwave ring — the visual signature of Nova.
  ring(x, y, element, opts = {}) {
    this._push({
      kind: 'ring', x, y, element,
      r0: opts.r0 ?? 2,
      r1: opts.r1 ?? 60,
      life: opts.life ?? 0.4,
      width: opts.width ?? 3,
      fill: opts.fill ?? false,
    });
  }

  // The heavy version of ring(): a white-hot leading edge with coloured rings trailing
  // behind it, all decelerating on an ease-out curve. A linear ring reads as a drawn
  // circle; one that punches out fast and then coasts reads as pressure.
  shockwave(x, y, element, opts = {}) {
    this._push({
      kind: 'shockwave', x, y, element,
      r0: opts.r0 ?? 3,
      r1: opts.r1 ?? 90,
      life: opts.life ?? 0.5,
      width: opts.width ?? 4,
      rings: opts.rings ?? 3,
    });
  }

  // Radial fracture lines, generated once and then held. The cue that says the hit
  // landed on something solid — Earth's whole identity, and the punctuation on any
  // big impact against terrain.
  cracks(x, y, element, opts = {}) {
    const arms = opts.arms ?? 7;
    const len = opts.len ?? 46;
    const lines = [];
    for (let i = 0; i < arms; i++) {
      const a = (i / arms) * Math.PI * 2 + Math.random() * 0.5;
      const pts = [[x, y]];
      let cx = x, cy = y, ang = a;
      const segs = 3 + ((Math.random() * 3) | 0);
      for (let k = 0; k < segs; k++) {
        ang += (Math.random() - 0.5) * 0.8;
        const step = (len / segs) * (0.6 + Math.random() * 0.8);
        cx += Math.cos(ang) * step;
        cy += Math.sin(ang) * step;
        pts.push([cx, cy]);
      }
      lines.push(pts);
    }
    this._push({
      kind: 'cracks', x, y, element, lines,
      life: opts.life ?? 1.1,
      width: opts.width ?? 2,
    });
  }

  // Converging streaks that collapse to a point, then a hard flash at the centre.
  // The inverse of shockwave, and the reason Absorb reads as a *pull* instantly.
  implode(x, y, element, opts = {}) {
    const spokes = opts.spokes ?? 14;
    const dirs = [];
    for (let i = 0; i < spokes; i++) {
      dirs.push((i / spokes) * Math.PI * 2 + Math.random() * 0.3);
    }
    this._push({
      kind: 'implode', x, y, element, dirs,
      r: opts.r ?? 70,
      life: opts.life ?? 0.5,
      width: opts.width ?? 2,
    });
  }

  // Rotating arms winding in or out. Dark's dread pulses and Arcane's rifts both
  // want rotation rather than a clean expanding circle.
  spiral(x, y, element, opts = {}) {
    this._push({
      kind: 'spiral', x, y, element,
      r: opts.r ?? 50,
      arms: opts.arms ?? 3,
      turns: opts.turns ?? 1.4,
      life: opts.life ?? 0.7,
      width: opts.width ?? 2,
      inward: opts.inward ?? false,
    });
  }

  // A tapered spray cone — flamethrowers, frost jets, pressurised water.
  //
  // This exists because a held beam drawn with beam() is a LINE, and a line does not
  // read as flame no matter what colour it is. Real spray widens as it loses pressure,
  // so this is drawn as a stack of quads that fan out with distance, hottest at the
  // nozzle and cooling toward the tip, with the width of every band re-jittered each
  // frame so the whole thing licks and gutters instead of sitting still.
  cone(x, y, angle, len, element, opts = {}) {
    this._push({
      kind: 'cone', x, y, angle, len, element,
      half: opts.half ?? 0.3,      // half-angle at the tip, radians
      life: opts.life ?? 0.09,
      steps: opts.steps ?? 8,
      alpha: opts.alpha ?? 1,
    });
  }

  // Vertical pillar — geysers, fire walls, tesla discharges.
  column(x, y, element, opts = {}) {
    this._push({
      kind: 'column', x, y, element,
      h: opts.h ?? 60,
      w: opts.w ?? 10,
      life: opts.life ?? 0.5,
      upward: opts.upward !== false,
    });
  }

  // A ground glyph that pulses in place — mines, traps, anchors, portals. This is the
  // visual that tells you a persistent thing is sitting in the world.
  rune(x, y, element, opts = {}) {
    this._push({
      kind: 'rune', x, y, element,
      r: opts.r ?? 12,
      life: opts.life ?? 1.0,
      spin: opts.spin ?? 0,
      glyph: opts.glyph ?? 'mine',
    });
  }

  // Inward spiral (Absorb) or outward burst. Absorb reading as a *pull* is the main
  // way the inverted modifier is legible at a glance.
  vortex(x, y, element, opts = {}) {
    this._push({
      kind: 'vortex', x, y, element,
      r: opts.r ?? 40,
      life: opts.life ?? 0.5,
      inward: opts.inward !== false,
    });
  }

  // A single glowing orb that lives for a while — orbiting satellites, seeking motes.
  orb(x, y, element, opts = {}) {
    this._push({
      kind: 'orb', x, y, element,
      r: opts.r ?? 5,
      life: opts.life ?? 0.4,
    });
  }

  // Residue. A soft glow that outlives the blast by a second or two and is drawn
  // *under* everything else, so the ground a fireball hit still looks hot after the
  // fireball is gone. Cheap, and it does more for weight than any number of sparks.
  afterglow(x, y, element, opts = {}) {
    this._push({
      kind: 'afterglow', x, y, element,
      r: opts.r ?? 30,
      life: opts.life ?? 1.6,
      color: opts.color,
    });
  }

  // ---------- screen space ----------

  // A full-frame colour wash. Unlike camera.flash this honours its alpha and its
  // duration independently, which is what lets a small cast tint faintly and an
  // ultimate wash the screen out.
  tint(element, alpha = 0.22, life = 0.22) {
    this._pushScreen({ kind: 'tint', element, alpha, life });
  }

  // Darkening from the edges inward. Dark's vision debuff (and Wail's dread) are
  // supposed to close the world in around you; this is the only thing that expresses
  // it, since the pixel grid itself cannot be dimmed cheaply.
  vignette(element, strength = 0.6, life = 0.9) {
    this._pushScreen({ kind: 'vignette', element, strength, life });
  }

  // Kept for compatibility with every existing call site, but it now actually uses
  // the alpha it is handed instead of discarding it, and layers a camera flash under
  // the wash for the genuinely big moments.
  flash(element, alpha = 0.25) {
    this.tint(element, alpha, 0.2);
    if (alpha >= 0.28) {
      const pal = this.palette(element);
      const c = Phaser.Display.Color.IntegerToRGB(pal.core);
      this.scene.cameras.main.flash(110, c.r, c.g, c.b, false, undefined, this.scene);
    }
  }

  // Per-element shake character. Callers still pass the magnitude they want; the
  // element decides whether that lands as a roll or a snap.
  shake(element, magnitude, duration) {
    const prof = FX_SHAKE[element] || { amp: 1, dur: 1 };
    this.scene.cameras.main.shake(
      (duration ?? 120) * prof.dur,
      (magnitude ?? 0.006) * prof.amp,
    );
  }

  // ---------- frame ----------

  update(dt) {
    this.time += dt;
    this.updateParticles(dt);
    const arr = this.effects;
    for (let i = arr.length - 1; i >= 0; i--) {
      arr[i].life -= dt;
      if (arr[i].life <= 0) arr.splice(i, 1);
    }
    const scr = this.screenEffects;
    for (let i = scr.length - 1; i >= 0; i--) {
      scr[i].life -= dt;
      if (scr[i].life <= 0) scr.splice(i, 1);
    }
  }

  draw() {
    const g = this.gfx;
    const gl = this.glowGfx;
    g.clear();
    gl.clear();
    for (const e of this.effects) {
      const t = Math.max(0, e.life / e.maxLife);
      const pal = this.palette(e.element);
      switch (e.kind) {
        case 'beam': this._drawBeam(g, e, t, pal); break;
        case 'bolt': this._drawBolt(g, e, t, pal); break;
        case 'ring': this._drawRing(g, e, t, pal); break;
        case 'shockwave': this._drawShockwave(g, e, t, pal); break;
        case 'cracks': this._drawCracks(g, e, t, pal); break;
        case 'implode': this._drawImplode(g, e, t, pal); break;
        case 'spiral': this._drawSpiral(g, e, t, pal); break;
        case 'cone': this._drawCone(g, e, t, pal); break;
        case 'column': this._drawColumn(g, e, t, pal); break;
        case 'rune': this._drawRune(g, e, t, pal); break;
        case 'vortex': this._drawVortex(g, e, t, pal); break;
        case 'orb': this._drawOrb(g, e, t, pal); break;
        // Residue draws on the lower layer so live effects sit on top of it.
        case 'afterglow': this._drawAfterglow(gl, e, t, pal); break;
      }
    }
    this.drawParticles();
    this.drawScreen();
  }

  drawScreen() {
    const g = this.screenGfx;
    g.clear();
    if (!this.screenEffects.length && this.visionDim <= 0.01) return;
    const cam = this.scene.cameras.main;
    const w = cam.width, h = cam.height;

    // Sustained vision loss first, so one-shot washes layer on top of it.
    if (this.visionDim > 0.01) {
      this._vignetteBands(g, w, h, this.visionElement, this.visionDim);
    }

    for (const e of this.screenEffects) {
      const t = Math.max(0, e.life / e.maxLife);
      const pal = this.palette(e.element);
      if (e.kind === 'tint') {
        g.fillStyle(pal.glow, e.alpha * t);
        g.fillRect(0, 0, w, h);
      } else if (e.kind === 'vignette') {
        this._vignetteBands(g, w, h, e.element, e.strength * t);
      }
    }
  }

  // Nested bands from the edge inward, each a little more transparent. Twelve steps
  // is enough to read as a gradient at this resolution and costs twelve rect strokes,
  // where a real radial gradient would cost a texture.
  _vignetteBands(g, w, h, element, strength) {
    const pal = this.palette(element);
    const bands = 12;
    const short = Math.min(w, h);
    for (let i = 0; i < bands; i++) {
      const f = 1 - i / bands;
      const inset = (i / bands) * short * 0.42;
      g.lineStyle(short * 0.042, pal.deep, strength * f * 0.34);
      g.strokeRect(inset, inset, w - inset * 2, h - inset * 2);
    }
  }

  _drawBeam(g, e, t, pal) {
    // Three passes: wide soft glow, mid body, thin white-hot core. The jitter is
    // re-rolled each frame so the beam crackles instead of sitting still.
    const j = e.jitter;
    const ox = (Math.random() - 0.5) * j, oy = (Math.random() - 0.5) * j;
    const x2 = e.x2 + ox, y2 = e.y2 + oy;
    g.lineStyle(e.width * 3.0, pal.deep, 0.28 * t);
    g.beginPath(); g.moveTo(e.x, e.y); g.lineTo(x2, y2); g.strokePath();
    g.lineStyle(e.width * 1.6, pal.glow, 0.75 * t);
    g.beginPath(); g.moveTo(e.x, e.y); g.lineTo(x2, y2); g.strokePath();
    g.lineStyle(Math.max(1, e.width * 0.5), pal.core, 0.95 * t);
    g.beginPath(); g.moveTo(e.x, e.y); g.lineTo(x2, y2); g.strokePath();
  }

  _drawBolt(g, e, t, pal) {
    const stroke = (pts, width, color, alpha) => {
      g.lineStyle(width, color, alpha);
      g.beginPath();
      g.moveTo(pts[0][0], pts[0][1]);
      for (let i = 1; i < pts.length; i++) g.lineTo(pts[i][0], pts[i][1]);
      g.strokePath();
    };
    stroke(e.points, e.width * 3.5, pal.deep, 0.3 * t);
    for (const f of e.forks) stroke(f, e.width * 1.4, pal.glow, 0.5 * t);
    stroke(e.points, e.width * 1.8, pal.glow, 0.85 * t);
    stroke(e.points, Math.max(1, e.width * 0.7), pal.core, t);
  }

  _drawRing(g, e, t, pal) {
    const r = e.r0 + (e.r1 - e.r0) * (1 - t);
    // Fade out as it expands; thicker at the start so the punch lands early.
    if (e.fill) {
      g.fillStyle(pal.glow, 0.20 * t);
      g.fillCircle(e.x, e.y, r);
    }
    g.lineStyle(e.width * t + 0.5, pal.deep, 0.35 * t);
    g.strokeCircle(e.x, e.y, r);
    g.lineStyle(e.width * 0.6 * t + 0.5, pal.core, 0.9 * t);
    g.strokeCircle(e.x, e.y, r);
  }

  _drawShockwave(g, e, t, pal) {
    // Ease-out on the radius: most of the travel happens in the first third of the
    // life, so the wave leaves fast and then coasts. This curve is the whole effect.
    const p = 1 - t;
    const eased = 1 - Math.pow(1 - p, 3);
    const lead = e.r0 + (e.r1 - e.r0) * eased;

    // A translucent disc behind the leading edge sells it as displaced air.
    g.fillStyle(pal.glow, 0.13 * t);
    g.fillCircle(e.x, e.y, lead);

    for (let i = 0; i < e.rings; i++) {
      // Trailing rings lag progressively further behind the leading edge.
      const lag = i * 0.16;
      const rp = Math.max(0, eased - lag);
      if (rp <= 0) continue;
      const r = e.r0 + (e.r1 - e.r0) * rp;
      const fade = t * (1 - i / (e.rings + 1));
      g.lineStyle(e.width * (1 - i * 0.22) * t + 0.5, i === 0 ? pal.core : pal.glow, 0.85 * fade);
      g.strokeCircle(e.x, e.y, r);
    }
    // The white-hot leading edge, always thin and always brightest.
    g.lineStyle(Math.max(1, e.width * 0.45), 0xffffff, 0.75 * t);
    g.strokeCircle(e.x, e.y, lead);
  }

  _drawCracks(g, e, t, pal) {
    // Draw outward progressively — the fractures race away from the impact over the
    // first ~200ms rather than appearing whole, then hold and fade.
    const grow = Math.min(1, (1 - t) * 4);
    for (const pts of e.lines) {
      const n = Math.max(2, Math.ceil(pts.length * grow));
      g.lineStyle(e.width * 2, pal.deep, 0.55 * t);
      g.beginPath();
      g.moveTo(pts[0][0], pts[0][1]);
      for (let i = 1; i < n; i++) g.lineTo(pts[i][0], pts[i][1]);
      g.strokePath();
      g.lineStyle(Math.max(1, e.width * 0.7), pal.core, 0.7 * t);
      g.beginPath();
      g.moveTo(pts[0][0], pts[0][1]);
      for (let i = 1; i < n; i++) g.lineTo(pts[i][0], pts[i][1]);
      g.strokePath();
    }
  }

  _drawImplode(g, e, t, pal) {
    // Spokes ride inward from the rim to the centre; the last 25% of the life is the
    // flash that says everything arrived at once.
    const p = 1 - t;
    const outer = e.r * (1 - p * 0.85);
    const inner = outer * 0.35;
    for (const a of e.dirs) {
      const c = Math.cos(a), s = Math.sin(a);
      g.lineStyle(e.width, pal.glow, 0.8 * t);
      g.beginPath();
      g.moveTo(e.x + c * outer, e.y + s * outer);
      g.lineTo(e.x + c * inner, e.y + s * inner);
      g.strokePath();
    }
    g.lineStyle(1.5, pal.core, 0.6 * t);
    g.strokeCircle(e.x, e.y, outer);
    if (p > 0.75) {
      const f = (p - 0.75) / 0.25;
      g.fillStyle(pal.core, 0.9 * (1 - f));
      g.fillCircle(e.x, e.y, 4 + 26 * f);
    }
  }

  _drawSpiral(g, e, t, pal) {
    const p = 1 - t;
    const prog = e.inward ? 1 - p : p;
    const steps = 22;
    for (let a = 0; a < e.arms; a++) {
      const base = (a / e.arms) * Math.PI * 2 + p * 3.4;
      g.lineStyle(e.width, a === 0 ? pal.core : pal.glow, 0.7 * t);
      g.beginPath();
      for (let i = 0; i <= steps; i++) {
        const f = (i / steps) * prog;
        const ang = base + f * e.turns * Math.PI * 2;
        const r = e.r * f;
        const px = e.x + Math.cos(ang) * r, py = e.y + Math.sin(ang) * r;
        if (i === 0) g.moveTo(px, py); else g.lineTo(px, py);
      }
      g.strokePath();
    }
  }

  _drawCone(g, e, t, pal) {
    const c = Math.cos(e.angle), s = Math.sin(e.angle);
    // Perpendicular to the spray direction — this is the axis the cone widens along.
    const nx = -s, ny = c;
    const spread = Math.tan(e.half);

    for (let i = 0; i < e.steps; i++) {
      const f0 = i / e.steps, f1 = (i + 1) / e.steps;
      const d0 = e.len * f0, d1 = e.len * f1;
      // Width grows with distance. The extra 3px keeps the nozzle end from pinching
      // to a mathematical point, which looks like a bug rather than a jet.
      const w0 = 3 + spread * d0 * (0.8 + Math.random() * 0.4);
      const w1 = 3 + spread * d1 * (0.8 + Math.random() * 0.4);

      const ax = e.x + c * d0 + nx * w0, ay = e.y + s * d0 + ny * w0;
      const bx = e.x + c * d0 - nx * w0, by = e.y + s * d0 - ny * w0;
      const cx2 = e.x + c * d1 - nx * w1, cy2 = e.y + s * d1 - ny * w1;
      const dx2 = e.x + c * d1 + nx * w1, dy2 = e.y + s * d1 + ny * w1;

      // Hot core near the nozzle, body through the middle, thin haze at the tip —
      // and the tip is the most transparent, so the spray fades out rather than
      // stopping at a hard edge.
      const col = f0 < 0.3 ? pal.core : (f0 < 0.65 ? pal.glow : pal.deep);
      const fade = (1 - f0 * 0.75) * t * e.alpha;
      g.fillStyle(col, 0.30 * fade);
      g.fillTriangle(ax, ay, bx, by, cx2, cy2);
      g.fillTriangle(ax, ay, cx2, cy2, dx2, dy2);
    }

    // A thin bright streak down the axis for the first third only, which is what
    // reads as pressure at the nozzle.
    g.lineStyle(3, pal.core, 0.5 * t * e.alpha);
    g.beginPath();
    g.moveTo(e.x, e.y);
    g.lineTo(e.x + c * e.len * 0.33, e.y + s * e.len * 0.33);
    g.strokePath();
  }

  _drawColumn(g, e, t, pal) {
    const dir = e.upward ? -1 : 1;
    const h = e.h * (1 - t * 0.35);
    const x0 = e.x - e.w / 2, x1 = e.x + e.w / 2;
    const y0 = e.y, y1 = e.y + dir * h;
    // A per-frame horizontal wobble makes the pillar look like it is under pressure
    // rather than being a rectangle someone drew.
    const wob = (Math.random() - 0.5) * e.w * 0.25;
    g.fillStyle(pal.deep, 0.3 * t);
    g.fillRect(x0 - e.w * 0.4 + wob, Math.min(y0, y1), e.w * 1.8, Math.abs(h));
    g.fillStyle(pal.glow, 0.6 * t);
    g.fillRect(x0 + wob, Math.min(y0, y1), e.w, Math.abs(h));
    g.fillStyle(pal.core, 0.9 * t);
    g.fillRect(e.x - e.w * 0.18 + wob, Math.min(y0, y1), e.w * 0.36, Math.abs(h));
    void x1;
  }

  _drawRune(g, e, t, pal) {
    const pulse = 0.7 + 0.3 * Math.sin(this.time * 9 + e.x);
    const r = e.r * (0.85 + 0.15 * pulse);
    // Fade in quickly, then hold, then vanish — a trap should look *armed*, not fading.
    const a = t > 0.8 ? (1 - t) / 0.2 : Math.min(1, t / 0.2);
    g.lineStyle(2, pal.glow, 0.8 * a);
    g.strokeCircle(e.x, e.y, r);
    g.lineStyle(1, pal.core, 0.9 * a);
    g.strokeCircle(e.x, e.y, r * 0.55);
    // Four ticks around the rim: reads as "armed" at a glance.
    for (let i = 0; i < 4; i++) {
      const ang = (i / 4) * Math.PI * 2 + e.spin * this.time;
      const cx = Math.cos(ang), cy = Math.sin(ang);
      g.lineStyle(2, pal.core, 0.85 * a);
      g.beginPath();
      g.moveTo(e.x + cx * r * 0.72, e.y + cy * r * 0.72);
      g.lineTo(e.x + cx * r * 1.0, e.y + cy * r * 1.0);
      g.strokePath();
    }
    g.fillStyle(pal.core, 0.6 * a);
    g.fillCircle(e.x, e.y, r * 0.18);
  }

  _drawVortex(g, e, t, pal) {
    const rings = 3;
    for (let i = 0; i < rings; i++) {
      // Each ring contracts (inward) or expands (outward) on its own phase offset,
      // which reads as a spiral rather than a single collapsing circle.
      const phase = (i / rings + (1 - t) * 0.6) % 1;
      const r = e.inward ? e.r * (1 - phase) : e.r * phase;
      if (r <= 0) continue;
      g.lineStyle(2, pal.glow, 0.55 * t);
      g.strokeCircle(e.x, e.y, r);
    }
    g.fillStyle(pal.core, 0.5 * t);
    g.fillCircle(e.x, e.y, 3 * t + 1);
  }

  _drawOrb(g, e, t, pal) {
    const flicker = 0.85 + Math.random() * 0.3;
    g.fillStyle(pal.glow, 0.35 * t);
    g.fillCircle(e.x, e.y, e.r * 2.2 * flicker);
    g.fillStyle(pal.glow, 0.7 * t);
    g.fillCircle(e.x, e.y, e.r * flicker);
    g.fillStyle(pal.core, t);
    g.fillCircle(e.x, e.y, e.r * 0.5);
  }

  _drawAfterglow(g, e, t, pal) {
    // Three stacked translucent discs approximate a falloff. Drawn on the lower layer,
    // so this is what a fresh blast lands on top of.
    const color = e.color ?? pal.deep;
    const breathe = 0.9 + 0.1 * Math.sin(this.time * 4 + e.x * 0.05);
    g.fillStyle(color, 0.20 * t);
    g.fillCircle(e.x, e.y, e.r * 1.5 * breathe);
    g.fillStyle(color, 0.16 * t);
    g.fillCircle(e.x, e.y, e.r * breathe);
    g.fillStyle(pal.glow, 0.13 * t);
    g.fillCircle(e.x, e.y, e.r * 0.5 * breathe);
  }

  // Clear everything — used on world regen so leftover effects don't hang in the air.
  clear() {
    this.particles.length = 0;
    this.effects.length = 0;
    this.screenEffects.length = 0;
    this.visionDim = 0;
    this.gfx.clear();
    this.glowGfx.clear();
    this.screenGfx.clear();
    this.scene.hitstopUntil = 0;
  }
}
