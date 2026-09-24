// Pixel-art characters.
//
// Everything else in this game is drawn either as raw grid cells (3x3 blocks of
// screen pixel) or as freeform vector FX. Bodies were the odd one out: a player was
// literally `fillRect(x, y, 10, 16)` with a two-pixel eye stuck on the front, which
// reads as a domino, not a person.
//
// This file gives bodies actual sprites. Each frame is authored as a grid of
// characters, one character per art pixel, at exactly the size of the body's
// collision box — 10x16 for a player, 10x14 for an enemy — so the art and the
// hitbox can never drift apart.
//
// Two decisions are worth knowing before editing the art:
//
//   * Nothing here draws its own outline. The compiler derives the silhouette and
//     lays a dark border around it, which buys back the two columns a hand-drawn
//     outline would eat at this size, and guarantees the character stays legible
//     against pale sand as well as against the near-black sky.
//
//   * Shading runs top-to-bottom, never left-to-right. Facing left is rendered by
//     mirroring the frame, and a left/right light source would flip with it.
//
// Frames compile once at load into colour-grouped runs of horizontal pixels, so a
// character costs a few dozen fillRects rather than 160.

// ---------- colour helpers ----------

function _mix(a, b, t) {
  const ar = (a >> 16) & 255, ag = (a >> 8) & 255, ab = a & 255;
  const br = (b >> 16) & 255, bg = (b >> 8) & 255, bb = b & 255;
  return ((((ar + (br - ar) * t) | 0) << 16)
    | (((ag + (bg - ag) * t) | 0) << 8)
    | ((ab + (bb - ab) * t) | 0));
}

const SPRITE_OUTLINE = 0x12101a;

// ---------- character scale ----------

// How many world units one art pixel covers. This is the single knob for how big
// bodies are: the collision boxes below are derived from it, so art and physics
// cannot disagree, and every reach that stands in for "close enough to have touched
// a body" is derived from those.
//
// Must be a whole number. The world is drawn as a 3x-scaled bitmap and a fractional
// scale would round some art pixels to one screen pixel and others to two, which is
// exactly the smeared look this file exists to get rid of.
//
// At 2, a player is 20x32 world units — about 6.7 x 10.7 simulation cells, roughly a
// fifteenth of the viewport's height. Going to 3 makes an art pixel exactly one
// simulation cell, which is the most cohesive the art can possibly look, but a body
// 16 cells tall needs wider tunnels than the dig brush cuts.
const CHAR_SCALE = 2;

const PLAYER_BOX = { w: 10 * CHAR_SCALE, h: 16 * CHAR_SCALE };
const ENEMY_BOX = { w: 10 * CHAR_SCALE, h: 14 * CHAR_SCALE };

// Stands in for "this point is close enough to a body's centre to have hit it".
// Half the body's diagonal, so it tracks CHAR_SCALE instead of being a literal that
// silently stops matching the thing it is testing against.
const BODY_TOUCH = Math.round(Math.hypot(PLAYER_BOX.w, PLAYER_BOX.h) / 2);

// ---------- compiler ----------

// Turns rows of characters into { spans, outline }.
//
// `spans` is grouped by palette key so the renderer sets a fill colour once per
// colour rather than once per pixel. `outline` is every transparent cell that
// touches a filled one, including the ring just outside the frame, which is why its
// coordinates run from -1 to w inclusive.
function compileSprite(rows) {
  const h = rows.length;
  const w = rows[0].length;
  for (const r of rows) {
    if (r.length !== w) throw new Error(`sprite row width mismatch: "${r}" is ${r.length}, expected ${w}`);
  }

  const byKey = {};
  for (let y = 0; y < h; y++) {
    const row = rows[y];
    let x = 0;
    while (x < w) {
      const k = row[x];
      if (k === '.') { x++; continue; }
      let run = 1;
      while (x + run < w && row[x + run] === k) run++;
      (byKey[k] || (byKey[k] = [])).push([x, y, run]);
      x += run;
    }
  }

  const filled = (x, y) => (x >= 0 && x < w && y >= 0 && y < h && rows[y][x] !== '.');
  // Eight-way, so diagonal steps in the silhouette get sealed too. A four-way outline
  // leaves a pinhole on every staircase corner, and this art is nothing but staircase
  // corners. Built as a mask first and run-length encoded after, because deciding
  // "is this an outline pixel" and "how far does this run reach" in one loop is how
  // off-by-one holes get in.
  const ow = w + 2, oh = h + 2;
  const mask = new Uint8Array(ow * oh);
  for (let y = -1; y <= h; y++) {
    for (let x = -1; x <= w; x++) {
      if (filled(x, y)) continue;
      let touches = false;
      for (let dy = -1; dy <= 1 && !touches; dy++) {
        for (let dx = -1; dx <= 1; dx++) {
          if ((dx || dy) && filled(x + dx, y + dy)) { touches = true; break; }
        }
      }
      if (touches) mask[(y + 1) * ow + (x + 1)] = 1;
    }
  }
  const outline = [];
  for (let my = 0; my < oh; my++) {
    let mx = 0;
    while (mx < ow) {
      if (!mask[my * ow + mx]) { mx++; continue; }
      let run = 1;
      while (mx + run < ow && mask[my * ow + mx + run]) run++;
      outline.push([mx - 1, my - 1, run]);
      mx += run;
    }
  }

  const groups = [];
  for (const k in byKey) groups.push({ key: k, rects: byKey[k] });
  return { w, h, groups, outline };
}

function compileSet(defs) {
  const out = {};
  for (const name in defs) out[name] = defs[name].map(compileSprite);
  return out;
}

// ---------- renderer ----------

// Draws one compiled frame with its top-left at (x, y).
//
// Coordinates are rounded: the world is drawn as a 3x-scaled bitmap, so a body sitting
// on a fractional pixel is the one thing on screen that would shimmer.
function drawSprite(g, frame, x, y, palette, opts = {}) {
  const alpha = opts.alpha ?? 1;
  if (alpha <= 0) return;
  const flip = opts.facing === -1;
  const sc = opts.scale ?? CHAR_SCALE;
  const ox = Math.round(x), oy = Math.round(y);
  const w = frame.w;
  const rotation = Number.isFinite(opts.rotation) ? opts.rotation : 0;
  const pivotX = opts.pivotX ?? (x + frame.w * sc / 2);
  const pivotY = opts.pivotY ?? (y + frame.h * sc / 2);
  const cos = rotation ? Math.cos(rotation) : 1;
  const sin = rotation ? Math.sin(rotation) : 0;
  const fillSpriteRect = (rx, ry, rw) => {
    const left = ox + rx * sc, top = oy + ry * sc, width = rw * sc;
    if (!rotation) { g.fillRect(left, top, width, sc); return; }
    const points = [[left, top], [left + width, top], [left + width, top + sc], [left, top + sc]]
      .map(([px, py]) => {
        const dx = px - pivotX, dy = py - pivotY;
        return { x: pivotX + dx * cos - dy * sin, y: pivotY + dx * sin + dy * cos };
      });
    g.fillPoints(points, true);
  };

  if (opts.outline !== false) {
    g.fillStyle(opts.outlineColor ?? SPRITE_OUTLINE, alpha * (opts.outlineAlpha ?? 1));
    for (const [rx, ry, rw] of frame.outline) {
      const px = flip ? w - rx - rw : rx;
      fillSpriteRect(px, ry, rw);
    }
  }

  for (const grp of frame.groups) {
    const col = palette[grp.key];
    if (col === undefined) continue;
    g.fillStyle(col, alpha);
    for (const [rx, ry, rw] of grp.rects) {
      const px = flip ? w - rx - rw : rx;
      fillSpriteRect(px, ry, rw);
    }
  }
}

// ---------- palettes ----------

// `tint` drives every cloth pixel, which is what makes one player distinguishable
// from another in multiplayer and what gives each enemy archetype its element colour.
// Skin, eyes and leather stay fixed so a red player still looks like a person.
function robePalette(tint, glow) {
  return {
    r: tint,
    R: _mix(tint, 0x14121c, 0.48),
    l: _mix(tint, 0xffffff, 0.38),
    s: 0xe8b48c,
    S: 0xa9765a,
    w: 0xf2f4ff,
    e: 0x18141f,
    m: 0x4a3a28,
    M: 0xc9b271,
    k: 0x2b2736,
    g: glow ?? 0xffe9a8,
  };
}

function creaturePalette(tint, glow) {
  return {
    r: tint,
    R: _mix(tint, 0x14121c, 0.5),
    l: _mix(tint, 0xffffff, 0.42),
    w: glow ?? 0xf6faff,
    k: _mix(tint, 0x14121c, 0.72),
    e: 0x18141f,
  };
}

// Every colour pushed the same distance toward one colour. Used for being on fire /
// submerged (the liquid stains the whole body) and for hit flashes (everything goes
// white for a couple of frames, so a hit is obvious even off-screen).
function tintPalette(base, colour, amount) {
  const out = {};
  for (const k in base) out[k] = _mix(base[k], colour, amount);
  return out;
}

// ---------- player art ----------
//
// 10 wide, 16 tall, facing right. A hooded-hat silhouette with a beard: at this size
// the only things that survive are the outline and one strong shape, and a pointed
// hat leaning back reads as "caster" from across the screen at a glance.
//
//   r/R/l  robe, its shade and its highlight (tinted per player)
//   s/S    skin and skin shadow      w  beard and eye white
//   e      pupil                     m/M  belt leather and buckle
//   k      boots                     g  spell glow at the casting hand

const PLAYER_FRAMES = compileSet({
  idle: [
    [
      '..ll......',
      '..lll.....',
      '..lrrr....',
      '.rrrrrr...',
      'rrrrrrrr..',
      '.RRRRRR...',
      '..ssswe...',
      '..swwwS...',
      '...www....',
      '..rrwrr...',
      '.rrrwrrs..',
      '.rmmmmrs..',
      '.rrrrrrr..',
      '.RRRRRRR..',
      '..kk.kk...',
      '..kk.kk...',
    ],
    [
      '..ll......',
      '..lll.....',
      '..lrrr....',
      '.rrrrrr...',
      'rrrrrrrr..',
      '.RRRRRR...',
      '..ssswe...',
      '..swwwS...',
      '...www....',
      '..rrwrr...',
      '.rrrwrr...',
      '.rmmmmrs..',
      '.rrrrrrs..',
      '.RRRRRRR..',
      '..kk.kk...',
      '..kk.kk...',
    ],
  ],

  // Four-frame cycle: contact, passing, contact, passing. The head shifts one pixel
  // forward on the contact frames, which is the whole of the forward lean.
  run: [
    [
      '...ll.....',
      '...lll....',
      '...lrrr...',
      '..rrrrrr..',
      '.rrrrrrrr.',
      '..RRRRRR..',
      '...ssswe..',
      '...swwwS..',
      '....www...',
      '..rrwrr...',
      '.rrrwrrs..',
      '.rmmmmrs..',
      '.rrrrrrr..',
      '.RRRRRR...',
      '..kk..kk..',
      '.kk....kk.',
    ],
    [
      '..ll......',
      '..lll.....',
      '..lrrr....',
      '.rrrrrr...',
      'rrrrrrrr..',
      '.RRRRRR...',
      '..ssswe...',
      '..swwwS...',
      '...www....',
      '..rrwrr...',
      '.rrrwrr...',
      '.rmmmmrs..',
      '.rrrrrrs..',
      '.RRRRRRR..',
      '...kkk....',
      '...kk.k...',
    ],
    [
      '...ll.....',
      '...lll....',
      '...lrrr...',
      '..rrrrrr..',
      '.rrrrrrrr.',
      '..RRRRRR..',
      '...ssswe..',
      '...swwwS..',
      '....www...',
      '..rrwrr...',
      '.rrrwrr.s.',
      '.rmmmmr.s.',
      '.rrrrrrr..',
      '..RRRRRR..',
      '.kk..kk...',
      'kk....kk..',
    ],
    [
      '..ll......',
      '..lll.....',
      '..lrrr....',
      '.rrrrrr...',
      'rrrrrrrr..',
      '.RRRRRR...',
      '..ssswe...',
      '..swwwS...',
      '...www....',
      '..rrwrr...',
      '.rrrwrrs..',
      '.rmmmmrs..',
      '.rrrrrrr..',
      '.RRRRRRR..',
      '...kkk....',
      '..k.kk....',
    ],
  ],

  // Rising: knees tucked, robe pulled tight, hand thrown up.
  jump: [
    [
      '..ll......',
      '..lll.....',
      '..lrrr....',
      '.rrrrrr...',
      'rrrrrrrr..',
      '.RRRRRR...',
      '..ssswe...',
      '..swwwS...',
      '...www....',
      '..rrwrrs..',
      '.rrrwrrs..',
      '.rmmmmr...',
      '.rrrrrr...',
      '..RRRRR...',
      '..kk.kk...',
      '...k..k...',
    ],
  ],

  // Falling: the robe catches the air and flares, arms out for balance.
  fall: [
    [
      '..ll......',
      '..lll.....',
      '..lrrr....',
      '.rrrrrr...',
      'rrrrrrrr..',
      '.RRRRRR...',
      '..ssswe...',
      '..swwwS...',
      '...www....',
      '.srrwrrs..',
      '.rrrwrrr..',
      '.rmmmmrr..',
      'rrrrrrrr..',
      '.RRRRRRR..',
      '..kk.kk...',
      '..k...k...',
    ],
  ],

  swim: [
    [
      '..ll......',
      '..lll.....',
      '..lrrr....',
      '.rrrrrr...',
      'rrrrrrrr..',
      '.RRRRRR...',
      '..ssswe...',
      '..swwwS...',
      '...www....',
      's.rrwrr.s.',
      '.rrrwrrr..',
      '.rmmmmrr..',
      '.rrrrrrr..',
      '.RRRRRRR..',
      '.kk..kk...',
      '..k....k..',
    ],
    [
      '..ll......',
      '..lll.....',
      '..lrrr....',
      '.rrrrrr...',
      'rrrrrrrr..',
      '.RRRRRR...',
      '..ssswe...',
      '..swwwS...',
      '...www....',
      '..rrwrr...',
      'srrrwrrrs.',
      '.rmmmmrr..',
      '.rrrrrrr..',
      '.RRRRRRR..',
      '..kkkk....',
      '...k..k...',
    ],
  ],

  // Casting: arm forward, magic gathering in the hand, and the eye lit by it.
  cast: [
    [
      '..ll......',
      '..lll.....',
      '..lrrr....',
      '.rrrrrr...',
      'rrrrrrrr..',
      '.RRRRRR...',
      '..sssge...',
      '..swwwS...',
      '...www....',
      '..rrwrrr..',
      '.rrrwrrsg.',
      '.rmmmmr...',
      '.rrrrrrr..',
      '.RRRRRRR..',
      '..kk.kk...',
      '..kk.kk...',
    ],
    [
      '..ll......',
      '..lll.....',
      '..lrrr....',
      '.rrrrrr...',
      'rrrrrrrr..',
      '.RRRRRR...',
      '..sssge...',
      '..swwwS...',
      '...www....',
      '..rrwrrsg.',
      '.rrrwrrrg.',
      '.rmmmmr...',
      'rrrrrrrr..',
      '.RRRRRRR..',
      '..kk.kk...',
      '..kk.kk...',
    ],
  ],

  // Struck: rocked backwards, eye screwed shut, arms flung wide.
  hurt: [
    [
      '...ll.....',
      '...lll....',
      '...lrrr...',
      '..rrrrrr..',
      '.rrrrrrrr.',
      '..RRRRRR..',
      '...sssSs..',
      '...swwwS..',
      '....www...',
      's.rrwrr.s.',
      '.rrrwrrr..',
      '.rmmmmrr..',
      '.rrrrrrr..',
      '.RRRRRRR..',
      '..kk.kk...',
      '.kk...kk..',
    ],
  ],

  // Crumpled on the ground: closed eye, tucked hood and limbs no longer braced.
  // Corpses use this still pose while their body tumbles from physical impulses.
  dead: [
    [
      '..........',
      '...lll....',
      '..lrrrl...',
      '.rrrrrr...',
      'rrrrrrrr..',
      '.RRRRRR...',
      '..sssSs...',
      '..swwwS...',
      '...www....',
      '.srrwrrs..',
      'srrrwrrrs.',
      '.rmmmmr...',
      '..rr.rr...',
      '.RRRRRR...',
      '.kk...kk..',
      '..........',
    ],
  ],
});

// ---------- enemy art ----------
//
// 10 wide, 14 tall, two frames each. These are not people, so the brief for each is a
// silhouette you can name at a glance with the colour removed: a horned imp, a slab,
// a spark, a droplet, a hood, a shard cluster.

const ENEMY_FRAMES = {
  // Fire: a small hunched imp with a flame licking off its skull.
  Emberling: [
    compileSprite([
      '....l.....',
      '...lll....',
      '...lrl....',
      '..rrrrr...',
      '..rwrwr...',
      '..rrkrr...',
      '.rrrrrrr..',
      '.rrRRRrr..',
      '.rrrrrrr..',
      '..rrrrr...',
      '..rr.rr...',
      '..kk.kk...',
      '..kk.kk...',
      '.kkk.kkk..',
    ]),
    compileSprite([
      '...ll.....',
      '...lll....',
      '..llrl....',
      '..rrrrr...',
      '..rwrwr...',
      '..rrkrr...',
      '.rrrrrrr..',
      '.rrRRRrr..',
      '.rrrrrrr..',
      '..rrrrr...',
      '..rr.rr...',
      '..kk.kk...',
      '.kk...kk..',
      '.kk...kk..',
    ]),
  ],

  // Earth: no neck, no waist, all shoulder. Twice as wide as it is agile.
  Pebbleback: [
    compileSprite([
      '..........',
      '..llllll..',
      '.rrrrrrrr.',
      '.rrwrrwrr.',
      '.rrrrrrrr.',
      'rrrrrrrrrr',
      'rrRrrrrRrr',
      'rrrrrrrrrr',
      '.rrrrrrrr.',
      '.rRRRRRRr.',
      '.rr....rr.',
      '.kk....kk.',
      '.kk....kk.',
      'kkk....kkk',
    ]),
    compileSprite([
      '..........',
      '..llllll..',
      '.rrrrrrrr.',
      '.rrwrrwrr.',
      '.rrrrrrrr.',
      'rrrrrrrrrr',
      'rrRrrrrRrr',
      'rrrrrrrrrr',
      '.rrrrrrrr.',
      '.rRRRRRRr.',
      '..r....r..',
      '..k....k..',
      '.kk....kk.',
      '.kkk..kkk.',
    ]),
  ],

  // Lightning: thin, jagged, permanently mid-discharge.
  Sparkling: [
    compileSprite([
      '..l....l..',
      '...l..l...',
      '....ll....',
      '...rrrr...',
      '...wrrw...',
      '...rrrr...',
      '..lrrrrl..',
      '...rrrr...',
      '..r.rr.r..',
      '...rrrr...',
      '...r..r...',
      '...r..r...',
      '..kk..kk..',
      '..kk..kk..',
    ]),
    compileSprite([
      '...l..l...',
      '..l....l..',
      '....ll....',
      '...rrrr...',
      '...wrrw...',
      '...rrrr...',
      '...rrrr...',
      '..lrrrrl..',
      '..r.rr.r..',
      '...rrrr...',
      '...r..r...',
      '..k....k..',
      '..kk..kk..',
      '.kk....kk.',
    ]),
  ],

  // Water: a droplet that grew eyes, wide at the shoulder and tapering to a trickle.
  Tidewisp: [
    compileSprite([
      '....ll....',
      '...llll...',
      '..llrrll..',
      '..rrrrrr..',
      '.rwrrrrwr.',
      '.rrrrrrrr.',
      '.rrrrrrrr.',
      '..rrrrrr..',
      '..rRRRRr..',
      '...rrrr...',
      '..r.rr.r..',
      '..r.rr.r..',
      '...rrrr...',
      '..RR..RR..',
    ]),
    compileSprite([
      '...ll.....',
      '..llll....',
      '..llrrl...',
      '..rrrrrr..',
      '.rwrrrrwr.',
      '.rrrrrrrr.',
      '.rrrrrrrr.',
      '..rrrrrr..',
      '..rRRRRr..',
      '..rrrrrr..',
      '..r.rr.r..',
      '...rrrr...',
      '..rr..rr..',
      '..R....R..',
    ]),
  ],

  // Dark: a hood with two lights in it and nothing underneath but tatters.
  Shade: [
    compileSprite([
      '...RRR....',
      '..RrrrR...',
      '..RrrrR...',
      '.RrwrwrR..',
      '.Rrrrrrr..',
      '.rrrrrrr..',
      'rrrrrrrrr.',
      'rrrrrrrrr.',
      '.rrrrrrr..',
      '.rrrrrrr..',
      '..rrrrr...',
      '..R.r.R...',
      '...R.R....',
      '..R...R...',
    ]),
    compileSprite([
      '...RRR....',
      '..RrrrR...',
      '..RrrrR...',
      '.RrwrwrR..',
      '.Rrrrrrr..',
      '.rrrrrrr..',
      '.rrrrrrrr.',
      '.rrrrrrrr.',
      '.rrrrrrr..',
      '..rrrrr...',
      '..rrrrr...',
      '...r.r....',
      '..R.R.R...',
      '...R...R..',
    ]),
  ],

  // Arcane: not a body at all — a cluster of shards orbiting one open eye.
  Riftling: [
    compileSprite([
      '....l.....',
      '...lrl....',
      '..lrrrl...',
      '.lrrrrrl..',
      'lrrrwrrrl.',
      '.lrrrrrl..',
      '..lrrrl...',
      '...lrl....',
      '....l.....',
      '..r....r..',
      '...r..r...',
      '....rr....',
      '...R..R...',
      '..R....R..',
    ]),
    compileSprite([
      '..........',
      '....l.....',
      '..llrll...',
      '.lrrrrrl..',
      'lrrrwrrrl.',
      'lrrrrrrrl.',
      '.lrrrrrl..',
      '..llrll...',
      '....l.....',
      '...r..r...',
      '..r....r..',
      '...rr.....',
      '..R..R....',
      '...R...R..',
    ]),
  ],
};

// ---------- animation ----------

// Chooses which clip a player should be in. Shared by the local player and by every
// remote one, so a networked body animates from its interpolated motion exactly the
// way the local body animates from its real motion.
function playerClip(st) {
  if (st.dead) return 'dead';
  if (st.hurt) return 'hurt';
  if (st.casting) return 'cast';
  if (st.liquid) return 'swim';
  if (!st.grounded) return st.vy < -18 ? 'jump' : 'fall';
  if (Math.abs(st.vx) > 6) return 'run';
  return 'idle';
}

// Seconds per frame, per clip. Running is re-timed by actual speed at the call site.
const PLAYER_CLIP_RATE = {
  idle: 0.62,
  run: 0.10,
  jump: 1,
  fall: 1,
  swim: 0.30,
  cast: 0.08,
  hurt: 1,
  dead: 0.8,
};

// Advances an animation cursor and returns the frame to draw. `anim` is any object
// the caller keeps around per body; it needs no initialisation.
function advanceAnim(anim, clip, dt, speedMul = 1) {
  if (anim.clip !== clip) {
    anim.clip = clip;
    anim.t = 0;
    anim.i = 0;
  }
  const frames = PLAYER_FRAMES[clip];
  // Clamped at both ends: a remote body snapped across the map by a respawn produces
  // an enormous apparent speed for one frame, and an unclamped divisor would spin the
  // cursor loop below hundreds of times to land on a frame nobody can perceive.
  const rate = (PLAYER_CLIP_RATE[clip] ?? 0.2) / Math.min(4, Math.max(0.2, speedMul));
  anim.t += dt;
  while (anim.t >= rate) {
    anim.t -= rate;
    anim.i = (anim.i + 1) % frames.length;
  }
  return frames[anim.i];
}

const Sprites = {
  compileSprite,
  drawSprite,
  robePalette,
  creaturePalette,
  tintPalette,
  playerClip,
  advanceAnim,
  mix: _mix,
  PLAYER_FRAMES,
  ENEMY_FRAMES,
  OUTLINE: SPRITE_OUTLINE,
  CHAR_SCALE,
  PLAYER_BOX,
  ENEMY_BOX,
  BODY_TOUCH,
};
