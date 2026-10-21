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

// `tint` drives every outer-cloth pixel, which is what makes one player distinguishable
// from another in multiplayer. Skin, trim, wraps and boots stay fixed so a red player
// still looks like the same person in a different tunic. `glow` lights the arrow
// tattoo and the casting hand together, so the bender visibly "powers up" with the
// element they are about to cast.
function robePalette(tint, glow) {
  const g = glow ?? 0xffe9a8;
  return {
    r: tint,
    R: _mix(tint, 0x14121c, 0.48),
    l: _mix(tint, 0xffffff, 0.38),
    y: 0xf0bf4a,
    Y: 0xb07a2a,
    s: 0xe8b48c,
    S: 0xa9765a,
    t: _mix(0x6fd0ff, g, 0.3),
    e: 0x18141f,
    m: 0x6b4a34,
    p: _mix(tint, 0x14121c, 0.3),
    k: 0x2b2736,
    g,
  };
}

// Enemy palettes are built from the archetype's own colour, so each element reads at a
// glance: red armour, green stone-coloured robes, parka blues and so on. Gold trim,
// skin and the dark armour/hair stay fixed. `glow` is the element's FX colour and lights
// the eyes and the casting hand — the only tell you get at range before a spell leaves.
function enemyPalette(tint, glow) {
  return {
    r: tint,
    R: _mix(tint, 0x14121c, 0.5),
    l: _mix(tint, 0xffffff, 0.42),
    a: 0xe0b84e,
    f: 0xeef4fa,
    s: 0xe0aa84,
    S: 0xa06e54,
    k: _mix(tint, 0x14121c, 0.76),
    h: 0x2b2230,
    e: 0x18141f,
    w: glow ?? 0xf6faff,
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
// 10 wide, 16 tall, facing right. A bald airbender-style monk: a round head with the
// glowing arrow tattoo, a short outer tunic over yellow under-sleeves, a wide sash, and
// baggy trousers tucked into boots. At this size the identity lives in three things —
// the blue arrow on a bare head, the yellow sash against the tunic, and the wrapped
// forearm — so those are what every frame keeps.
//
// Frames are assembled from a head, a torso and a pair of legs rather than drawn out
// whole: the head never changes between clips except for the eye, and sharing it
// guarantees the face cannot drift from one frame to the next.
//
//   r/R/l  outer tunic, its shade and its highlight (tinted per player)
//   y/Y    under-sleeves and sash         s/S  skin and skin shadow
//   t      arrow tattoo (lit by the cast) e    eye           g  spell glow at the hand
//   m      wrist wrap                     p    trousers      k  boots

// Rows are stacked top to bottom: 6 head + 7 torso + 3 legs = 16.
const _stack = (...parts) => [].concat(...parts);

// Leans a block of rows one pixel forward. Every row has to end in a transparent pixel.
const _lean = (rows) => rows.map((r) => `.${r.slice(0, -1)}`);

const _HEAD = [
  '...ssss...',
  '..ssstts..',
  '..ssssts..',
  '..Ssssses.',
  '..sssssss.',
  '....SSSS..',
];
const _eye = (head, c) => head.map((r) => r.replace('e', c));
const _HEAD_CAST = _eye(_HEAD, 'g');
const _HEAD_SHUT = _eye(_HEAD, 'S');

const _TORSO_A = [
  '.rrryyrr..',
  '.rrrryrry.',
  '.rrrryrry.',
  '.yyyyyyyY.',
  '.rrrrrrrs.',
  '.rrrrrrr..',
  '.RRRRRRR..',
];
const _TORSO_B = [
  '.rrryyrr..',
  '.rrrryrry.',
  '.rrrryrry.',
  '.yyyyyyyY.',
  '.rrrrrrry.',
  '.rrrrrrrs.',
  '.RRRRRRR..',
];
const _TORSO_CAST_A = [
  '.rrryyrr..',
  '.rrrryrry.',
  '.rrrryyysg',
  '.yyyyyyyY.',
  '.rrrrrrr..',
  '.rrrrrrr..',
  '.RRRRRRR..',
];
const _TORSO_CAST_B = [
  '.rrryyrr..',
  '.rrrryrrsg',
  '.rrrryyysg',
  '.yyyyyyyY.',
  '.rrrrrrr..',
  '.rrrrrrr..',
  '.RRRRRRR..',
];
const _TORSO_JUMP = [
  '.rrryyrrs.',
  '.rrrryrry.',
  '.rrrryrr..',
  '.yyyyyyY..',
  '.rrrrrr...',
  '.rrrrrr...',
  '..RRRRR...',
];
const _TORSO_FALL = [
  '.rrryyrr..',
  'srrrryrrs.',
  '.rrrryrrr.',
  '.yyyyyyyY.',
  'rrrrrrrrr.',
  '.rrrrrrrr.',
  '.RRRRRRRR.',
];
const _TORSO_SWIM_A = [
  '.rrryyrr..',
  '.rrrryrr..',
  'syrrryrrys',
  '.yyyyyyyY.',
  '.rrrrrrr..',
  '.rrrrrrr..',
  '.RRRRRRR..',
];
const _TORSO_SWIM_B = [
  '.rrryyrr..',
  '.rrrryrr..',
  '.rrrryrrys',
  'syyyyyyyY.',
  '.rrrrrrr..',
  '.rrrrrrr..',
  '.RRRRRRR..',
];
const _TORSO_HURT = [
  '.rrryyrr.s',
  '.rrrryrry.',
  'syrrryrry.',
  '.yyyyyyyY.',
  '.rrrrrrr..',
  '.rrrrrrr..',
  '.RRRRRRR..',
];

const _LEGS_STAND = ['..pp.pp...', '..pp.pp...', '.kkk.kkk..'];
const _LEGS_RUN_A = ['..pp..pp..', '.pp....pp.', 'kkk....kkk'];
const _LEGS_RUN_B = ['..pp.pp...', '...pppp...', '...kk.kk..'];
const _LEGS_RUN_C = ['..pp..pp..', '.pp..pp...', 'kkk..kkk..'];
const _LEGS_RUN_D = ['..pp.pp...', '..ppp.pp..', '..kk..kk..'];

const PLAYER_FRAMES = compileSet({
  idle: [
    _stack(_HEAD, _TORSO_A, _LEGS_STAND),
    _stack(_HEAD, _TORSO_B, _LEGS_STAND),
  ],

  // Four-frame cycle: contact, passing, contact, passing. The upper body leans a pixel
  // forward on every frame, which is the whole of the forward lean.
  run: [
    _stack(_lean(_HEAD), _lean(_TORSO_A), _LEGS_RUN_A),
    _stack(_lean(_HEAD), _lean(_TORSO_B), _LEGS_RUN_B),
    _stack(_lean(_HEAD), _lean(_TORSO_A), _LEGS_RUN_C),
    _stack(_lean(_HEAD), _lean(_TORSO_B), _LEGS_RUN_D),
  ],

  // Rising: knees tucked, one hand thrown up.
  jump: [
    _stack(_HEAD, _TORSO_JUMP, ['..pp.pp...', '..p...p...', '..k...k...']),
  ],

  // Falling: the tunic catches the air and flares, arms out for balance.
  fall: [
    _stack(_HEAD, _TORSO_FALL, ['..pp.pp...', '..p...p...', '.kk...kk..']),
  ],

  swim: [
    _stack(_HEAD, _TORSO_SWIM_A, ['.pp...pp..', '..p...p...', '..kk.kk...']),
    _stack(_HEAD, _TORSO_SWIM_B, ['..ppp.pp..', '..p...p...', '...kk.k...']),
  ],

  // Casting: arm thrust forward, magic gathering in the hand, and the eye and the
  // arrow tattoo lit by it.
  cast: [
    _stack(_HEAD_CAST, _TORSO_CAST_A, _LEGS_STAND),
    _stack(_HEAD_CAST, _TORSO_CAST_B, _LEGS_STAND),
  ],

  // Struck: head rocked back, eye screwed shut, arms flung wide.
  hurt: [
    _stack(_HEAD_SHUT.map((r) => r.slice(1) + '.'), _TORSO_HURT, ['..pp.pp...', '.pp...pp..', 'kk.....kk.']),
  ],

  // Crumpled on the ground. Corpses use this still pose while their body tumbles from
  // physical impulses.
  dead: [
    _stack(['..........'], _HEAD_SHUT, [
      'srrryyrrs.',
      '.rrrryrry.',
      '.yyyyyyyY.',
      '.rrrrrrr..',
      '.rrrrrrr..',
      '.RRRRRRR..',
    ], ['..pp.pp...', '.pp...pp..', '.kk...kk..']).slice(0, 16),
  ],
});

// ---------- enemy art ----------
//
// 10 wide, 14 tall, two frames each. Enemies are rival benders, one per element, and the
// brief for each is a silhouette you can name with the colour removed: a spiked helm
// over broad pauldrons, a wide straw hat, wild hair and sparking fingers, a fur hood, a
// bare black cloak, a tall glowing crown.
//
//   r/R/l  cloth in the archetype colour   a  gold trim       f  white fur
//   k      dark armour / cloak             h  hair and mask   s/S  skin and shadow
//   w      element glow (eyes, hands)      e  pupil

// Shared leg cycles. Each enemy supplies its top 11 rows; the second frame bobs the top
// down a pixel and swaps legs, which is all the animation a two-frame walk needs.
function _enemyPair(top, legsA, legsB) {
  return [
    compileSprite(_stack(top, legsA)),
    compileSprite(_stack(['..........'], top.slice(0, 10), legsB)),
  ];
}
const _E_LEGS_A = ['..RR.RR...', '..RR.RR...', '..kk.kk...'];
const _E_LEGS_B = ['..RR.RR...', '.RR...RR..', '.kk...kk..'];

const ENEMY_FRAMES = {
  // Fire: spiked helm, flared pauldrons, gold-trimmed red armour.
  'Cinder Guard': _enemyPair([
    '....aa....',
    '...aaaa...',
    '..kkkkkk..',
    '..kkkkkkk.',
    '..kssswsk.',
    '...sSSSS..',
    '.kkrrrrkk.',
    '.krraarrks',
    '.krrrrrrk.',
    '..aaaaaa..',
    '..rrrrrr..',
  ], _E_LEGS_A, _E_LEGS_B),

  // Earth: broad straw hat over a squat, wide-shouldered robe.
  'Stone Warden': _enemyPair([
    '....aa....',
    '...aaaa...',
    '.aaaaaaaa.',
    '..ssswss..',
    '..sssSSs..',
    '..rrrrrr..',
    '.rrrllrrr.',
    'rrrrllrrrs',
    '.rrrrrrrr.',
    '.RRRRRRRR.',
    '..RRRRRR..',
  ], _E_LEGS_A, _E_LEGS_B),

  // Lightning: wild spiked hair and a hand that will not stop sparking.
  'Storm Adept': _enemyPair([
    '..h.h.h...',
    '..hhhhhh..',
    '..hhhhhh..',
    '..sswsss..',
    '...ssSS...',
    '..rrrrrr..',
    '.rrllrrrr.',
    '.rrllrrrrs',
    '..rrrrrr.w',
    '..rrrrrr..',
    '..RRRRRR..',
  ], _E_LEGS_A, _E_LEGS_B),

  // Water: a face peering out of a fur-trimmed parka hood.
  'Tide Mystic': _enemyPair([
    '...ffff...',
    '..ffffff..',
    '.ffsswsff.',
    '.ffsssSff.',
    '..frrrrf..',
    '.rrrllrrr.',
    '.rrllllrrs',
    '.rrrrrrrr.',
    '.rrraarrr.',
    '.RRRRRRRR.',
    '..RRRRRR..',
  ], _E_LEGS_A, _E_LEGS_B),

  // Dark: a bottomless hood with two lit eyes and nothing else.
  'Dusk Stalker': _enemyPair([
    '...kkkk...',
    '..kkkkkk..',
    '.kkkhhkkk.',
    '.kkhwhwkk.',
    '.kkhhhhkk.',
    '..kkkkkk..',
    '.kkkrrkkk.',
    '.kkrrrrkks',
    '.kkkrrkkk.',
    '.kkkkkkkk.',
    '..kkkkkk..',
  ], _E_LEGS_A, _E_LEGS_B),

  // Arcane: a tall glowing crown over a carved mask, a rune burning on the chest.
  'Spirit Mask': _enemyPair([
    '....ww....',
    '...wllw...',
    '..llllll..',
    '..lhwhwl..',
    '..lhhhhl..',
    '...rrrr...',
    '..rrwwrr..',
    '.rrrwwrrrs',
    '..rrwwrr..',
    '..rrrrrr..',
    '..RRRRRR..',
  ], _E_LEGS_A, _E_LEGS_B),
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
  enemyPalette,
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
