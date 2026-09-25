// Falling-sand pixel simulation demo, Noita-inspired, built with Phaser 3.
// Every cell in a grid is a material (see world.js for the material table,
// simulation rules and world generation, shared with the multiplayer server).
// A player character walks/jumps over the terrain and can dig or place materials.

const {
  COLS, ROWS, SIZE, MAT, FIRE_LIFE, SMOKE_LIFE, ICE_LIFE,
  IS_SOLID, BLOCKS_BODY, IS_RIGID, IS_OPEN, FLAMMABILITY, PALETTE,
} = PixelWorld;
const PIXEL = 3;
const WORLD_WIDTH = COLS * PIXEL;
const WORLD_HEIGHT = ROWS * PIXEL;

// Screen/viewport size — what's actually visible at once. The camera scrolls
// around the bigger world, and only this window's worth of pixels is rendered
// each frame so render cost stays constant regardless of world size.
const VIEW_COLS = 280;
const VIEW_ROWS = 160;
const SCREEN_WIDTH = VIEW_COLS * PIXEL;
const SCREEN_HEIGHT = VIEW_ROWS * PIXEL;

const {
  EMPTY, SAND, WATER, STONE, WOOD, FIRE, SMOKE, BEDROCK, LAVA, ACID, GAS, ICE,
  GRASS, LEAVES, GLASS, GOLD, SNOW, OIL, TIMBER,
} = MAT;

// Number keys 1-9: what left-click digs away / right-click places.
const MATERIALS = [
  { name: 'Stone', mat: STONE, radius: 4 },
  { name: 'Wood', mat: WOOD, radius: 4 },
  { name: 'Water', mat: WATER, radius: 5 },
  { name: 'Lava', mat: LAVA, radius: 4 },
  { name: 'Acid', mat: ACID, radius: 4 },
  { name: 'Gas', mat: GAS, radius: 5 },
  { name: 'Sand', mat: SAND, radius: 4 },
  { name: 'Oil', mat: OIL, radius: 5 },
  { name: 'Snow', mat: SNOW, radius: 4 },
];

// Bodies walk up ledges this many cells tall without jumping. It has to match what
// world.js assumes when it sizes furniture, steps and door aprons.
const STEP_UP_CELLS = CHAR_SCALE + 1;

// Solo worlds can be pinned with ?seed=123 in the URL.
function seedFromUrl() {
  const s = new URLSearchParams(location.search).get('seed');
  return s !== null && s !== '' ? Number(s) >>> 0 : undefined;
}

// The dig brush has to cut a hole the player can actually walk down, so it is derived
// from the body instead of being a literal that quietly stops fitting the moment
// CHAR_SCALE changes. Half the body's height in cells, plus a cell of clearance at
// the head and the feet.
const DIG_RADIUS = Math.ceil(PLAYER_BOX.h / PIXEL / 2) + 1;

const NEIGHBORS4 = [[1, 0], [-1, 0], [0, 1], [0, -1]];
const NEIGHBORS8 = [[1, 0], [-1, 0], [0, 1], [0, -1], [1, 1], [-1, -1], [1, -1], [-1, 1]];

// ---------- concentric spell wheel ----------
// Hold Q (primary) or E (secondary), sweep through element -> form -> modifier, release
// to lock the combo in; left/right click then casts it through Spells.cast(). All 384
// combinations resolve to something — see spells.js.

const WHEEL_ELEMENTS = ['Fire', 'Water', 'Earth', 'Air'];
const WHEEL_FORMS = ['Bolt', 'Nova', 'Beam', 'Ground', 'Orbit', 'Trail', 'Mine', 'Homing'];
const WHEEL_MODIFIERS = ['Chain', 'Split', 'Pierce', 'Delay', 'Volatile', 'Absorb', 'Amplify', 'Anchor'];
const WHEEL_ELEMENT_COLORS = [0xff5522, 0x3388ff, 0x8a6a3c, 0xb8e6f0];
const WHEEL_RINGS = [
  { key: 'element', names: WHEEL_ELEMENTS, rMin: 30, rMax: 65, baseColor: 0x888888 },
  { key: 'form', names: WHEEL_FORMS, rMin: 72, rMax: 107, baseColor: 0x3a5a7a },
  { key: 'modifier', names: WHEEL_MODIFIERS, rMin: 114, rMax: 149, baseColor: 0x5a3a7a },
];
for (const ring of WHEEL_RINGS) {
  ring.segments = ring.names.length;
  ring.segAngle = (Math.PI * 2) / ring.segments;
}

// Bending's own Form picker (bending.js). Modifiers aren't wired up for
// bending yet, so this is one ring, not three, and it isn't keyed by
// primary/secondary slot the way the spell wheel is — bending only has one
// button. A third/fourth form is just another array entry.
const BEND_FORMS = ['Bolt', 'Orbit'];
const BEND_FORM_RING = { rMin: 30, rMax: 90, baseColor: 0x4a4a58 };

class SandScene extends Phaser.Scene {
  constructor() {
    super('sand');
  }

  // Which mode to run in. Chosen from the menu; defaults to solo so the scene is
  // still usable if launched directly.
  init(data) {
    this.netMode = (data && data.netMode) === 'multi' ? 'multi' : 'solo';
    this.roomId = (data && data.roomId) || null;
    this.roomName = (data && data.roomName) || null;
    this.returningToMenu = false;
    // The menu may already have opened a socket and taken a seat in a room. Reusing
    // that connection is what makes the room you picked on the menu the room you
    // actually play in, with no gap in between for the room to be reaped.
    this.initSocket = (data && data.socket) || null;
    this.prejoined = (data && data.prejoined) || null;
    this.campaign = !!(data && data.campaign);
    this.level = (data && data.level) || 1;
  }

  create() {
    this.world = new PixelWorld.World();
    this.grid = this.world.grid;
    this.life = this.world.life;
    this.falling = this.world.falling;
    // The support map from the last collapse pass; destabilize() reads it.
    this.suppVisited = this.world.visited;
    this.backdrop = new Uint8Array(SIZE * 3);
    this.collapseTimer = 0;

    if (CHAR_SCALE !== PixelWorld.DEFAULT_BODY_SCALE) {
      // The server generates rooms with world.js's default, so its doors and shafts
      // would be sized for a different body than the one being drawn here.
      console.warn(`CHAR_SCALE ${CHAR_SCALE} != PixelWorld.DEFAULT_BODY_SCALE ${PixelWorld.DEFAULT_BODY_SCALE}; multiplayer worlds will be sized for the wrong body`);
    }
    this.generateWorld(seedFromUrl());

    this.multiplayer = false;
    this.netId = null;
    this.netColor = 0xf0f0f0;
    this.remotePlayers = {};
    this.remoteRender = {};
    this.netSendTimer = 0;
    this.fallImpactCooldown = new WeakMap();
    this.remoteFallImpactAt = new Map();
    // Only reach for the network when the player actually asked for multiplayer.
    // Free play must not silently join a shared world.
    // In multiplayer we wait for the server's world rather than simulating our own
    // and discarding it a moment later when init arrives.
    this.awaitingServer = this.netMode === 'multi';
    if (this.netMode === 'multi') this.connectMultiplayer();

    this.viewCols = VIEW_COLS + 2;
    this.viewRows = VIEW_ROWS + 2;
    // The canvas texture is keyed globally, so starting the scene a second time
    // (return to menu, then play again) would fail with "Texture key already in use"
    // and leave create() dead half-way through. Drop the old one first.
    if (this.textures.exists('world')) this.textures.remove('world');
    this.worldTexture = this.textures.createCanvas('world', this.viewCols, this.viewRows);
    this.imageData = this.worldTexture.context.createImageData(this.viewCols, this.viewRows);
    this.worldImage = this.add.image(0, 0, 'world').setOrigin(0, 0).setScale(PIXEL).setDepth(0);

    // Ground-level spell furniture sits under everything else, just above the world
    // grid — lingering cursed patches and river currents are painted on the floor.
    this.groundFxGfx = this.add.graphics().setDepth(1);

    this.debrisGfx = this.add.graphics().setDepth(8);
    this.remoteGfx = this.add.graphics().setDepth(9);
    this.playerGfx = this.add.graphics().setDepth(10);
    this.projectileGfx = this.add.graphics().setDepth(11);
    this.orbitGfx = this.add.graphics().setDepth(12);
    this.minesGfx = this.add.graphics().setDepth(13);
    this.brushGfx = this.add.graphics().setDepth(15);

    // The FX system owns its own layer (depth 16) for beams, bolts, rings and sparks.
    this.fx = new FXSystem(this);
    // Present in every mode so targeting and damage can call into it unconditionally;
    // only campaign actually puts anything in it.
    this.enemies = new EnemySystem(this);
    // Bending: the left mouse button's third mode, next to dig and cast. B cycles
    // dig -> water -> earth -> fire -> air -> dig; bendElement says which bender
    // has the button.
    this.benders = {
      Water: new WaterBending(this), Earth: new EarthBending(this),
      Fire: new FireBending(this), Air: new AirBending(this),
    };
    this.bendElement = 'Water';
    // Bending's own Form choice per element (see BEND_FORMS above). Q opens the
    // picker while a bend is selected; a bender reads its own `.form` field
    // directly, so this is just the remembered choice plus the picker's state.
    this.bendStyle = { Water: 'Bolt', Earth: 'Bolt', Fire: 'Bolt', Air: 'Bolt' };
    this.bendWheelOpen = false;
    this.bendFormSel = 0;

    this.projectiles = [];
    this.debris = [];
    // Cells written since the last flush, mirrored to the server as concrete values.
    this.pendingCells = new Map();
    this.mines = [];
    this.orbitSpells = [];
    this.waves = [];
    this.fields = [];
    // One held cast per mouse button. Null when that button is not channelling.
    this.channels = { primary: null, secondary: null };
    // Animation cursor for the local body, and how long the cast pose is held after
    // a one-shot spell. Channels hold the pose for as long as they run.
    this.playerAnim = {};
    this.castAnimUntil = 0;
    this.castGlowElement = null;
    this.prevLeftDown = false;
    this.prevRightDown = false;
    this.leftClickMode = 'dig'; // 'dig' | 'primary' | 'bend'
    this.rightClickMode = 'legacy'; // 'legacy' | 'secondary'

    this.player = {
      x: (COLS / 2) * PIXEL,
      y: 2 * PIXEL,
      w: PLAYER_BOX.w,
      h: PLAYER_BOX.h,
      vx: 0,
      vy: 0,
      grounded: false,
      liquid: null,
      facing: 1,
      health: 100,
      maxHealth: 100,
      dead: false,
      respawnAt: 0,
      burning: false,
      burnFxTimer: 0,
      impulseX: 0,
      rotation: 0,
      rotationV: 0,
    };

    // Status effects live entirely on the caster: per the multiplayer scope, spells
    // damage and curse *you*, and remote players are affected by terrain and FX only.
    this.status = {
      effects: [],       // { name, element, dps, remaining, ramp } — curses and burns
      marks: {},         // { soulSpike: expiry, storm: expiry } — set up by one cast, spent by the next
      slowMul: 1,
      slowUntil: 0,
      empUntil: 0,       // Lightning's Static Snap: cannot cast while this is in the future
      vision: 1,         // 1 = normal, lower = the world darkens around you (Wail)
      glitchUntil: 0,    // Panic: controls invert
      maxHealthMul: 1,   // Despair lowers the ceiling, not just the current value
      buffs: {},         // { overcharge: n }
      respawnPoint: null,
      portal: null,
    };
    // Base max health is immutable; maxHealth is always derived from it so that
    // Despair can expire cleanly without permanently weakening the player.
    this.baseMaxHealth = 100;

    // Water spells move real water (spells.js, "matter"). This is what you carry: it
    // starts full, is spent first, and refills by wading or with Absorb casts.
    this.reserve = { water: Spells.WATER_RESERVE_CAP };
    this.wadeAcc = 0;
    this.waterFizzle = null;   // { at, need } — the last Water cast that had nothing to draw
    this.waterHud = { at: -Infinity, key: null, nearby: 0 };

    // Cells repeatedly scorched by Fire's Inferno Core burn hotter on later casts.
    // A separate map rather than a material, so the simulation needs no new rules.
    this.scorch = new Uint8Array(COLS * ROWS);

    this.keys = this.input.keyboard.addKeys({
      up: Phaser.Input.Keyboard.KeyCodes.UP,
      down: Phaser.Input.Keyboard.KeyCodes.DOWN,
      left: Phaser.Input.Keyboard.KeyCodes.LEFT,
      right: Phaser.Input.Keyboard.KeyCodes.RIGHT,
      w: Phaser.Input.Keyboard.KeyCodes.W,
      a: Phaser.Input.Keyboard.KeyCodes.A,
      s: Phaser.Input.Keyboard.KeyCodes.S,
      d: Phaser.Input.Keyboard.KeyCodes.D,
      space: Phaser.Input.Keyboard.KeyCodes.SPACE,
      one: Phaser.Input.Keyboard.KeyCodes.ONE,
      two: Phaser.Input.Keyboard.KeyCodes.TWO,
      three: Phaser.Input.Keyboard.KeyCodes.THREE,
      four: Phaser.Input.Keyboard.KeyCodes.FOUR,
      five: Phaser.Input.Keyboard.KeyCodes.FIVE,
      six: Phaser.Input.Keyboard.KeyCodes.SIX,
      seven: Phaser.Input.Keyboard.KeyCodes.SEVEN,
      eight: Phaser.Input.Keyboard.KeyCodes.EIGHT,
      nine: Phaser.Input.Keyboard.KeyCodes.NINE,
      r: Phaser.Input.Keyboard.KeyCodes.R,
      q: Phaser.Input.Keyboard.KeyCodes.Q,
      e: Phaser.Input.Keyboard.KeyCodes.E,
      b: Phaser.Input.Keyboard.KeyCodes.B,
      esc: Phaser.Input.Keyboard.KeyCodes.ESC,
    });

    this.cameras.main.setBounds(0, 0, WORLD_WIDTH, WORLD_HEIGHT);

    this.materialIndex = 2; // start with water
    this.input.mouse.disableContextMenu();

    this.input.keyboard.on('keydown-F', () => {
      if (this.scale.isFullscreen) this.scale.stopFullscreen();
      else this.scale.startFullscreen();
    });

    this.accumulator = 0;
    this.SIM_STEP = 1000 / 40;

    this.healthBarGfx = this.add.graphics().setScrollFactor(0).setDepth(20);

    // A persistent readout of what each mouse button will actually cast. With 384
    // combinations and no reminder on screen, you would otherwise be guessing.
    this.hudGfx = this.add.graphics().setScrollFactor(0).setDepth(21);
    this.hudText = this.add.text(16, 46, '', {
      fontFamily: 'monospace', fontSize: '12px', color: '#dfe4ff',
      lineSpacing: 3,
    }).setScrollFactor(0).setDepth(22);
    this.statusHudText = this.add.text(16, 132, '', {
      fontFamily: 'monospace', fontSize: '11px', color: '#ffbb88',
      lineSpacing: 2,
    }).setScrollFactor(0).setDepth(22);

    this.wheelOpen = false;
    this.wheelSlot = null; // 'primary' | 'secondary' while the wheel is open
    this.wheelHoverRing = null;
    this.wheelSelections = {
      primary: { element: 0, form: 0, modifier: 0 },
      secondary: { element: 0, form: 0, modifier: 0 },
    };
    this.spellCombos = { primary: null, secondary: null };
    this.wheelGfx = this.add.graphics().setScrollFactor(0).setDepth(25);
    this.setupWheelPreview();

    this.drawHealthBar();

    // Campaign fills the freshly generated world with hostiles, once every system
    // they touch (FX layer, graphics) actually exists. Level 1 is a handful; the
    // count scales with the level for whatever comes later.
    if (this.campaign) {
      const count = 4 + this.level * 2;
      this.campaignGoal = count;
      this.enemies.populate(count, this.level);
    }
  }

  setupWheelPreview() {
    const cx = SCREEN_WIDTH / 2, cy = SCREEN_HEIGHT / 2;
    this.wheelPreviewText = this.add.text(cx, cy + 165, '', {
      fontFamily: 'monospace',
      fontSize: '13px',
      color: '#ffffff',
      backgroundColor: '#000000aa',
      padding: { x: 6, y: 3 },
    }).setOrigin(0.5, 0).setScrollFactor(0).setDepth(26).setVisible(false);
  }

  idx(x, y) {
    return y * COLS + x;
  }

  setCell(id, mat, customLife) {
    this.world.setCell(id, mat, customLife);

    // In multiplayer, every concrete change is recorded and shipped to the server.
    //
    // This is deliberately the RESULT and not the operation. Sending "explode here"
    // let the server re-roll its own randomness and produce a different crater than
    // the caster had already drawn on their screen — cells the server never touched
    // were never corrected by a delta, so clients silently drifted apart. Shipping
    // the exact cells the caster computed makes the whole thing deterministic.
    if (this.multiplayer) this.pendingCells.set(id, [mat, this.life[id]]);
  }

  // Sends everything written this frame as one compact op. Bounded so a huge spell
  // cannot produce an unbounded message; anything skipped is re-buffered for the
  // next flush rather than dropped.
  flushCellChanges() {
    if (!this.multiplayer || this.pendingCells.size === 0) return;
    const MAX_PER_FLUSH = 900;
    const cells = [];
    for (const [id, v] of this.pendingCells) {
      cells.push([id, v[0], v[1]]);
      if (cells.length >= MAX_PER_FLUSH) break;
    }
    for (const c of cells) this.pendingCells.delete(c[0]);
    this.sendNet({ t: 'cells', cells });
  }

  // ---------- world (rules live in world.js) ----------

  generateWorld(seed) {
    const info = PixelWorld.generateWorld(this.world, seed, { bodyScale: CHAR_SCALE, stepUpCells: STEP_UP_CELLS });
    this.world.onRigidImpact = (hit) => {
      if (!this.multiplayer) this.handleRigidFallImpact(hit);
    };
    this.fallImpactCooldown = new WeakMap();
    if (this.remoteFallImpactAt) this.remoteFallImpactAt.clear();
    if (this.debris) this.debris.length = 0;
    this.buildBackdrop();
    console.log(`world seed ${info.seed}:`, info.regions.map((r) => r.biome).join(' / '), '|', info.structures.join(', '));
  }

  buildBackdrop() {
    PixelWorld.buildBackdrop(this.world.bg, this.backdrop);
  }

  checkStructuralSupport() {
    this.world.checkStructuralSupport();
  }

  simulate() {
    this.world.simulate();
  }

  // ---------- player ----------

  // Solid to projectiles, spells and the simulation — trees and doors included.
  solidAt(px, py) {
    const gx = Math.floor(px / PIXEL);
    const gy = Math.floor(py / PIXEL);
    if (gx < 0 || gx >= COLS || gy < 0 || gy >= ROWS) return true;
    return IS_SOLID[this.grid[this.idx(gx, gy)]] === 1;
  }

  solidAtCell(gx, gy) {
    if (gx < 0 || gx >= COLS || gy < 0 || gy >= ROWS) return true;
    return IS_SOLID[this.grid[this.idx(gx, gy)]] === 1;
  }

  // Solid to a body. Timber (trunks, doors, furniture) and leaves are passable, so
  // players and enemies walk through forests and doorways that still stop a bolt.
  bodySolidAt(px, py) {
    const gx = Math.floor(px / PIXEL);
    const gy = Math.floor(py / PIXEL);
    if (gx < 0 || gx >= COLS || gy < 0 || gy >= ROWS) return true;
    return BLOCKS_BODY[this.grid[this.idx(gx, gy)]] === 1;
  }

  rectSolid(x, y, w, h) {
    const pts = [
      [x, y], [x + w, y], [x, y + h], [x + w, y + h],
      [x + w / 2, y], [x + w / 2, y + h], [x, y + h / 2], [x + w, y + h / 2],
    ];
    for (const [px, py] of pts) {
      if (this.bodySolidAt(px, py)) return true;
    }
    return false;
  }

  materialFraction(x, y, w, h, mat) {
    const samples = [
      [x + w / 2, y + h / 2], [x + w / 2, y], [x + w / 2, y + h],
      [x, y + h / 2], [x + w, y + h / 2],
    ];
    let count = 0;
    for (const [px, py] of samples) {
      const gx = Math.floor(px / PIXEL), gy = Math.floor(py / PIXEL);
      if (gx >= 0 && gx < COLS && gy >= 0 && gy < ROWS && this.grid[this.idx(gx, gy)] === mat) count++;
    }
    return count / samples.length;
  }

  // ---------- health ----------

  applyEnvironmentDamage(dt) {
    const p = this.player;
    if (p.dead) return;
    const lavaFrac = this.materialFraction(p.x, p.y, p.w, p.h, LAVA);
    const fireFrac = this.materialFraction(p.x, p.y, p.w, p.h, FIRE);
    const acidFrac = this.materialFraction(p.x, p.y, p.w, p.h, ACID);
    const gasFrac = this.materialFraction(p.x, p.y, p.w, p.h, GAS);

    let dps = 0, source = null;
    if (lavaFrac > 0) { dps += 45 * lavaFrac; source = 'Fire'; }
    else if (fireFrac > 0) { dps += 12 * fireFrac; source = 'Fire'; }
    if (acidFrac > 0) { dps += 20 * acidFrac; source ||= 'Acid'; }
    if (gasFrac > 0) { dps += 6 * gasFrac; source ||= 'Gas'; }

    if (dps > 0) this.damagePlayer(dps * dt, { source: source || 'Environment' });
  }

  damagePlayer(amount, opts = {}) {
    const p = this.player;
    if (p.dead || p.health <= 0 || !(amount > 0)) return;
    p.health = Math.max(0, p.health - amount);
    const source = opts.source || 'Impact';
    this.lastDamageSource = source;
    GameAudio.hurt(source, p.x + p.w / 2, p.y + p.h / 2);
    if (p.health <= 0) {
      GameAudio.death(p.x + p.w / 2, p.y + p.h / 2);
      p.health = 0;
      p.dead = true;
      p.respawnAt = this.time.now + 3000;
      p.burning = source === 'Fire';
      p.burnFxTimer = 0;
      p.impulseX = Phaser.Math.Clamp(p.impulseX + p.vx, -600, 600);
      p.vx = 0;
      p.rotationV = Phaser.Math.Clamp((Math.random() < 0.5 ? -1 : 1) * 2.6 + p.impulseX * 0.004, -7, 7);
      this.abortDeadChannels();
      this.wheelOpen = false;
      this.wheelSlot = null;
      this.wheelHoverRing = null;
      this.wheelGfx.clear();
      this.wheelPreviewText.setVisible(false);
      this.prevLeftDown = this.input.activePointer.leftButtonDown();
      this.prevRightDown = this.input.activePointer.rightButtonDown();
    }
  }

  respawnPlayer() {
    const p = this.player;
    const anchor = this.status.respawnPoint;
    p.dead = false;
    p.respawnAt = 0;
    p.burning = false;
    p.burnFxTimer = 0;
    p.rotation = 0;
    p.rotationV = 0;
    p.impulseX = 0;
    p.maxHealth = this.baseMaxHealth;
    p.health = this.baseMaxHealth;
    // A Soul Anchor placed earlier overrides the default spawn — that is its entire
    // purpose — and is spent in the process, so you get one save, not a checkpoint.
    if (anchor) {
      p.x = anchor.x;
      p.y = anchor.y;
      this.status.respawnPoint = null;
    } else {
      p.x = (COLS / 2) * PIXEL;
      p.y = 2 * PIXEL;
    }
    p.vx = 0;
    p.vy = 0;
    p.grounded = false;
    p.liquid = null;
    // Curses do not follow you through death; dying is also a cleanse.
    this.status.effects.length = 0;
    this.status.slowMul = 1;
    this.status.slowUntil = 0;
    this.status.vision = 1;
    this.status.maxHealthMul = 1;
    this.status.marks = {};
    this.status.empUntil = 0;
    this.status.glitchUntil = 0;
    this.status.buffs = {};
    this.status.portal = null;
    this.prevLeftDown = this.input.activePointer.leftButtonDown();
    this.prevRightDown = this.input.activePointer.rightButtonDown();
  }

  abortDeadChannels() {
    // Death cancels Telekinesis without throwing the held mass; ending it normally is
    // an active attack and could mutate the world after the caster is already dead.
    for (const slot of ['primary', 'secondary']) {
      const ch = this.channels[slot];
      if (ch && ch.held) {
        for (const debris of ch.held) {
          debris.tkHeld = false;
          debris.tkThrown = 0;
        }
        ch.held.length = 0;
      }
      this.channels[slot] = null;
    }
  }

  drawHealthBar() {
    const p = this.player;
    const w = 140, h = 12, x = 16, y = 16;
    const frac = Phaser.Math.Clamp(p.health / p.maxHealth, 0, 1);
    const gfx = this.healthBarGfx;
    gfx.clear();
    gfx.fillStyle(0x000000, 0.55);
    gfx.fillRect(x - 2, y - 2, w + 4, h + 4);
    gfx.fillStyle(0x330000, 1);
    gfx.fillRect(x, y, w, h);
    const color = frac > 0.5 ? 0x4ad84a : frac > 0.25 ? 0xdcc832 : 0xdc3232;
    gfx.fillStyle(color, 1);
    gfx.fillRect(x, y, w * frac, h);
    gfx.lineStyle(1, 0xffffff, 0.5);
    gfx.strokeRect(x, y, w, h);

    // The water reserve, directly under health: the other thing a fight can run you
    // out of. The outline flashes red when a Water cast just failed for want of it.
    const wy = y + h + 5, wh = 5;
    const wfrac = Phaser.Math.Clamp(this.reserve.water / Spells.WATER_RESERVE_CAP, 0, 1);
    const dry = this.waterFizzle && this.time.now - this.waterFizzle.at < 700;
    gfx.fillStyle(0x000000, 0.55);
    gfx.fillRect(x - 2, wy - 2, w + 4, wh + 4);
    gfx.fillStyle(0x0b1a33, 1);
    gfx.fillRect(x, wy, w, wh);
    gfx.fillStyle(0x3a8cff, 1);
    gfx.fillRect(x, wy, w * wfrac, wh);
    gfx.lineStyle(1, dry ? 0xff5a5a : 0xffffff, dry ? 0.95 : 0.4);
    gfx.strokeRect(x, wy, w, wh);
  }

  // What a Water combo costs and whether you can pay, appended to its HUD line.
  waterReadout(combo) {
    const st = Spells.waterStatus(this, combo.element, combo.form, combo.modifier);
    if (!st) return '';
    if (st.site) return '  · water drawn at the target';
    if (st.cost === 0) return '  · collects water';
    // Counting nearby water is a disc scan, so it is refreshed a few times a second
    // rather than every frame.
    const NEARBY_CAP = 400;
    if (this.time.now - this.waterHud.at > 250) {
      this.waterHud.at = this.time.now;
      this.waterHud.nearby = Spells.waterNearby(this, NEARBY_CAP);
    }
    const nearby = this.waterHud.nearby;
    const unit = st.perSecond ? '/s' : '';
    return `  · water ${st.cost}${unit}, have ${st.reserve}+${nearby}${nearby >= NEARBY_CAP ? '+' : ''}`;
  }

  // Names the assembled combo for each mouse button, and lists what is currently
  // afflicting you — without the second half, a curse is just a number going down.
  drawStatusHud() {
    const describe = (slot) => {
      const combo = this.spellCombos[slot];
      if (!combo) return 'empty';
      const label = Spells.abilityName(combo.element, combo.form, combo.modifier);
      const comboText = `${combo.element} + ${combo.form} + ${combo.modifier}`;
      return (label ? `${comboText}  [${label}]` : comboText) + this.waterReadout(combo);
    };
    if (this.campaign) {
      const alive = this.enemies.list.length;
      const killed = this.enemies.killCount;
      const done = killed >= this.campaignGoal;
      this.hudText.setText([
        `CAMPAIGN  level ${this.level}${done ? '  —  cleared' : ''}`,
        '',
        `hostiles  ${alive} left   ·   ${killed}/${this.campaignGoal} down`,
        '',
        `LMB  ${this.leftButtonLabel(describe)}`,
        `RMB  ${this.rightClickMode === 'secondary' ? describe('secondary') : 'place'}`,
      ]);
      this.statusHudText.setText(this.statusHudLines().join('\n'));
      this.hudText.setAlpha((this.wheelOpen || this.bendWheelOpen) ? 0.25 : 1);
      this.statusHudText.setAlpha((this.wheelOpen || this.bendWheelOpen) ? 0.25 : 1);
      return;
    }

    let mode = this.netMode === 'multi'
      ? (this.multiplayer
          ? `MULTIPLAYER  ${this.roomName || 'room'}  [${this.roomId || '?'}]`
          : (this.netError ? `connection failed: ${this.netError}` : 'connecting...'))
      : 'SINGLEPLAYER  free play';
    this.hudText.setText([
      mode,
      '',
      `LMB  ${this.leftButtonLabel(describe)}`,
      `RMB  ${this.rightClickMode === 'secondary' ? describe('secondary') : 'place'}`,
    ]);

    this.statusHudText.setText(this.statusHudLines().join('\n'));

    // Dim the whole HUD while the wheel is open so it does not fight the wheel.
    this.hudText.setAlpha((this.wheelOpen || this.bendWheelOpen) ? 0.25 : 1);
    this.statusHudText.setAlpha((this.wheelOpen || this.bendWheelOpen) ? 0.25 : 1);
  }

  leftButtonLabel(describe) {
    if (this.leftClickMode === 'primary') return describe('primary');
    if (this.leftClickMode === 'bend') {
      const n = this.benders[this.bendElement].holding;
      const next = this.bendElement === 'Water' ? 'bend earth'
        : this.bendElement === 'Earth' ? 'bend fire'
        : this.bendElement === 'Fire' ? 'bend air'
        : 'dig';
      const form = this.bendStyle[this.bendElement];
      return `bend ${this.bendElement.toLowerCase()} · ${form}${n ? `  (holding ${n})` : ''}   [B: ${next}] [Q: form]`;
    }
    return 'dig   [B: bend water]';
  }

  // The active-effect readout, shared by every mode's HUD.
  statusHudLines() {
    const st = this.status;
    const lines = [];
    if (this.player.dead) {
      const left = Math.max(0, (this.player.respawnAt - this.time.now) / 1000);
      lines.push(`DOWN  respawning in ${left.toFixed(1)}s`);
    }
    // Channels first: a held spell has a duration cap, and without seeing it drain
    // the spray just appears to quit on you for no reason.
    for (const line of this.channelStatusLines()) lines.push(line);
    if (this.waterFizzle && this.time.now - this.waterFizzle.at < 1600) {
      lines.push(`No water in reach (needs ${this.waterFizzle.need}) - wade in to refill`);
    }
    for (const e of st.effects) {
      const ramp = e.ramp ? ' (escalating)' : '';
      lines.push(`${e.name}${ramp}  ${e.remaining.toFixed(1)}s`);
    }
    if (st.slowMul < 1) lines.push(`Slowed x${st.slowMul.toFixed(2)}`);
    if (this.time.now < st.empUntil) lines.push('EMP - cannot cast');
    if (st.marks.soulSpike) lines.push('Marked: next spell empowered');
    if (st.marks.storm) lines.push('Marked for Storm');
    if (st.buffs.overcharge) lines.push('Overcharged: next spell empowered');
    if (st.respawnPoint) lines.push('Soul Anchor set');
    if (st.portal) lines.push('Rift Anchor open (cast again to warp)');
    return lines;
  }

  movePlayer(dt) {
    const p = this.player;
    const k = this.keys;

    const waterFrac = this.materialFraction(p.x, p.y, p.w, p.h, WATER);
    const lavaFrac = this.materialFraction(p.x, p.y, p.w, p.h, LAVA);
    const acidFrac = this.materialFraction(p.x, p.y, p.w, p.h, ACID);
    const oilFrac = this.materialFraction(p.x, p.y, p.w, p.h, OIL);
    p.liquid = lavaFrac > 0.2 ? 'lava' : acidFrac > 0.2 ? 'acid' : waterFrac > 0.2 ? 'water' : oilFrac > 0.2 ? 'oil' : null;

    if (p.dead) {
      p.vx = 0;
      if (p.liquid) {
        p.vy += 90 * dt;
        p.vy *= 0.96;
        p.vy = Phaser.Math.Clamp(p.vy, -140, 180);
      } else {
        p.vy = Math.min(420, p.vy + 500 * dt);
      }

      const corpseVx = p.impulseX;
      const nx = p.x + corpseVx * dt;
      if (!this.rectSolid(nx, p.y, p.w, p.h)) p.x = nx;
      else p.impulseX = 0;

      const ny = p.y + p.vy * dt;
      if (!this.rectSolid(p.x, ny, p.w, p.h)) {
        p.y = ny;
        p.grounded = false;
      } else {
        if (p.vy > 0) {
          p.grounded = true;
          p.rotationV *= 0.48;
        }
        p.vy = 0;
      }
      p.impulseX *= Math.exp(-3.2 * dt);
      if (Math.abs(p.impulseX) < 2) p.impulseX = 0;
      p.rotation += p.rotationV * dt;
      p.rotationV *= Math.exp(-2.6 * dt);
      if (p.grounded && Math.abs(p.rotationV) < 0.06) p.rotationV = 0;
      p.rotation = ((p.rotation + Math.PI) % (Math.PI * 2) + Math.PI * 2) % (Math.PI * 2) - Math.PI;
      p.x = Phaser.Math.Clamp(p.x, PIXEL, WORLD_WIDTH - PIXEL - p.w);
      p.y = Phaser.Math.Clamp(p.y, PIXEL, WORLD_HEIGHT - PIXEL - p.h);
      return;
    }

    const speed = p.liquid ? 60 : 90;
    let ax = 0;
    if (k.left.isDown || k.a.isDown) { ax = -1; p.facing = -1; }
    else if (k.right.isDown || k.d.isDown) { ax = 1; p.facing = 1; }
    p.vx = ax * speed;

    const nx = p.x + (p.vx + p.impulseX) * dt;
    if (!this.rectSolid(nx, p.y, p.w, p.h)) {
      p.x = nx;
    } else if (p.vx !== 0 && (p.grounded || p.liquid)) {
      // step up small ledges (roots, rubble, crates, foundations) instead of stopping dead
      for (let s = 1; s <= STEP_UP_CELLS; s++) {
        if (!this.rectSolid(nx, p.y - s * PIXEL, p.w, p.h)) {
          p.x = nx;
          p.y -= s * PIXEL;
          break;
        }
      }
      p.impulseX = 0;
    } else {
      p.impulseX = 0;
    }
    p.impulseX *= Math.exp(-3.2 * dt);
    if (Math.abs(p.impulseX) < 2) p.impulseX = 0;

    const jumpPressed = k.up.isDown || k.w.isDown || k.space.isDown;
    const downPressed = k.down.isDown || k.s.isDown;

    if (p.liquid) {
      p.vy += 90 * dt;
      if (jumpPressed) p.vy -= 420 * dt;
      if (downPressed) p.vy += 260 * dt;
      p.vy *= 0.92;
      p.vy = Phaser.Math.Clamp(p.vy, -140, 140);
    } else {
      p.vy += 500 * dt;
      if (p.vy > 420) p.vy = 420;
    }

    const ny = p.y + p.vy * dt;
    if (!this.rectSolid(p.x, ny, p.w, p.h)) {
      p.y = ny;
      p.grounded = false;
    } else {
      if (p.vy > 0) p.grounded = true;
      p.vy = 0;
    }

    if (jumpPressed && p.grounded && !p.liquid) {
      GameAudio.jump(p.x + p.w / 2, p.y + p.h);
      p.vy = -190;
      p.grounded = false;
    }

    p.x = Phaser.Math.Clamp(p.x, PIXEL, WORLD_WIDTH - PIXEL - p.w);
    p.y = Phaser.Math.Clamp(p.y, PIXEL, WORLD_HEIGHT - PIXEL - p.h);
  }

  // ---------- brushes ----------

  digCircle(gx, gy, r) {
    for (let dy = -r; dy <= r; dy++) {
      for (let dx = -r; dx <= r; dx++) {
        if (dx * dx + dy * dy > r * r) continue;
        const x = gx + dx, y = gy + dy;
        if (x <= 0 || x >= COLS - 1 || y <= 0 || y >= ROWS - 1) continue;
        const id = this.idx(x, y);
        const cur = this.grid[id];
        if (cur === BEDROCK) continue;
        if (IS_RIGID[cur] && Math.random() < 0.3) {
          this.spawnDebris(x, y, cur, gx, gy, false);
        }
        this.setCell(id, EMPTY);
      }
    }
  }

  placeCircle(gx, gy, r, mat, life) {
    for (let dy = -r; dy <= r; dy++) {
      for (let dx = -r; dx <= r; dx++) {
        if (dx * dx + dy * dy > r * r) continue;
        const x = gx + dx, y = gy + dy;
        if (x <= 0 || x >= COLS - 1 || y <= 0 || y >= ROWS - 1) continue;
        const id = this.idx(x, y);
        const cur = this.grid[id];
        if (mat === FIRE) {
          // grass is left for the fire rules to scorch, so fire spells don't pit the ground
          if (cur === EMPTY || (FLAMMABILITY[cur] > 0 && cur !== GRASS)) this.setCell(id, FIRE, life);
        } else if (mat === ICE) {
          // Ice is placed *over* water — freezing a pool into a wall is the point.
          if (cur === EMPTY || cur === WATER) this.setCell(id, ICE, life ?? ICE_LIFE);
        } else if (cur === EMPTY) {
          this.setCell(id, mat, life);
        }
      }
    }
  }

  explode(gx, gy, r) {
    const cx = gx * PIXEL + PIXEL / 2, cy = gy * PIXEL + PIXEL / 2;
    const forceRadius = Math.max(80, (r * PIXEL + 20) * 2);
    const forceStrength = Math.min(420, 210 + r * 5);
    this.applyBlastImpulse(cx, cy, forceRadius, forceStrength, true);
    GameAudio.blast(cx, cy, Math.min(1.5, 0.65 + r / 24));
    const outer = r + Math.round(r * 0.4) + 2;
    for (let dy = -outer; dy <= outer; dy++) {
      for (let dx = -outer; dx <= outer; dx++) {
        const dist = Math.sqrt(dx * dx + dy * dy);
        if (dist > outer) continue;
        const x = gx + dx, y = gy + dy;
        if (x <= 0 || x >= COLS - 1 || y <= 0 || y >= ROWS - 1) continue;
        const id = this.idx(x, y);
        const cur = this.grid[id];
        if (cur === BEDROCK) continue;
        if (dist <= r) {
          const rim = dist / r;
          const fireChance = 0.2 + rim * 0.6;
          if (Math.random() < fireChance) {
            this.setCell(id, FIRE, FIRE_LIFE * 2.2);
          } else {
            if (IS_RIGID[cur] && Math.random() < 0.4) {
              this.spawnDebris(x, y, cur, gx, gy, true);
            }
            this.setCell(id, EMPTY);
          }
        } else {
          const t = (dist - r) / (outer - r);
          if (Math.random() < 0.6 * (1 - t)) this.setCell(id, FIRE, FIRE_LIFE * 1.6);
        }
      }
    }
  }

  // ---------- debris (physics objects) ----------

  // Tears the world down and hands control back to the menu. The socket has to be
  // closed explicitly — otherwise the client keeps a seat on the server and a
  // player would linger in everyone else's world after quitting.
  returnToMenu() {
    if (this.returningToMenu) return;
    this.returningToMenu = true;
    if (this.socket) {
      try { this.socket.close(); } catch (e) { /* already gone */ }
      this.socket = null;
    }
    this.multiplayer = false;
    this.remotePlayers = {};
    this.channels = { primary: null, secondary: null };
    this.fx.clear();
    this.scene.start('menu');
  }

  // ---------- player damage ----------

  // Reports a hit on another player. Their client owns their health, so this does
  // not apply damage here — it asks the server to tell them. `effects` travel with
  // it so a Dark curse keeps working after the blast, on the victim's own machine.
  reportHit(targetId, element, amount, effects) {
    if (!targetId) return;
    this.sendNet({
      t: 'hit',
      target: targetId,
      element,
      amount: Math.round(amount * 10) / 10,
      effects: Array.isArray(effects) ? effects.slice(0, 4) : null,
    });
  }

  // Someone else's spell caught us. Applied exactly as if we had caught ourselves,
  // so being hit by another player feels identical to standing in your own Nova.
  receiveHit(msg) {
    if (this.player.dead) return;
    const amount = Math.min(Math.max(+msg.amount || 0, 0), 120);
    if (amount <= 0 && !msg.effects) return;
    this.damagePlayer(amount, { source: msg.element });
    if (this.player.dead) return;
    if (Array.isArray(msg.effects)) {
      for (const e of msg.effects.slice(0, 4)) {
        if (!e || typeof e.name !== 'string') continue;
        this.applyStatusEffect(e.name.slice(0, 24), {
          element: msg.element,
          dps: +e.dps || 0,
          duration: Math.min(+e.duration || 3, 15),
          ramp: !!e.ramp,
          vision: +e.vision || 0,
          slow: +e.slow || 0,
          emp: Math.min(+e.emp || 0, 4000),
          glitch: Math.min(+e.glitch || 0, 4000),
          maxHealthMul: +e.maxHealthMul || 0,
        });
      }
    }
    // Being hit from off-screen with no feedback would be unreadable, so mark it.
    this.hitFlashUntil = this.time.now + 260;
    this.fx.burst(this.player.x + this.player.w / 2, this.player.y + this.player.h / 2,
      18, msg.element || 'Arcane', { speed: 120, life: 0.5 });
    this.fx.shake(msg.element, 0.008, 160);
  }

  // ---------- remote spell visuals ----------

  // Replays another player's cast as pure visuals, so spells look the same for
  // everyone watching instead of each client only seeing their own magic.
  //
  // Deliberately does NOT re-run the spell through Spells.cast(). Two reasons: it
  // would apply the terrain effects a second time on top of the cells the caster
  // already mirrored, and any time.delayedCall the spell scheduled would fire long
  // after this returned — outside any guard — and mutate the world then. So this
  // draws the shape of the cast, and the world changes arrive as cells instead.
  replayRemoteCast(msg) {
    const { element, form, modifier, ox, oy, tx, ty, r } = msg;
    if (typeof ox !== 'number' || typeof ty !== 'number') return;
    GameAudio.cast(element, ox, oy);
    const angle = Math.atan2(ty - oy, tx - ox);

    switch (form) {
      case 'Bolt':
      case 'Trail':
      case 'Homing': {
        // A real flying projectile, flagged so it deals no damage and touches no
        // terrain — it exists purely to streak across the screen.
        this.projectiles.push({
          x: ox, y: oy,
          vx: Math.cos(angle) * 340, vy: Math.sin(angle) * 340,
          radius: r || 8, visualR: 4 + (r || 8) * 0.2,
          life: 2.2, trailTimer: 0,
          element, modifier, pierce: 0, phase: false, homing: false,
          gravity: 30, age: 0, clearedCaster: true,
          visualOnly: true,
        });
        break;
      }
      case 'Beam': {
        this.fx.beam(ox, oy, tx, ty, element, { life: 0.3, width: 4 });
        this.fx.burst(tx, ty, 16, element, { speed: 90, life: 0.5 });
        GameAudio.impact(element, tx, ty, { strength: 0.72 });
        break;
      }
      case 'Nova': {
        this.fx.ring(ox, oy, element, { r0: 3, r1: (r || 8) * 5, life: 0.45, width: 3 });
        this.fx.burst(ox, oy, 24, element, { speed: 130, life: 0.6 });
        GameAudio.impact(element, ox, oy, { strength: 0.78 });
        break;
      }
      case 'Ground': {
        // A crest travelling away from the caster, matching the real wave's spread.
        this.fx.column(ox, oy, element, { h: 22, w: 14, life: 0.5, upward: false });
        this.fx.burst(ox, oy, 20, element, { speed: 90, life: 0.6, rise: 40 });
        break;
      }
      case 'Orbit': {
        this.fx.ring(ox, oy, element, { r0: 30, r1: 8, life: 0.5, width: 2 });
        this.fx.burst(ox, oy, 14, element, { speed: 60, life: 0.6 });
        break;
      }
      case 'Mine': {
        this.fx.rune(tx, ty, element, { r: 14, life: 1.1, spin: 1.2, glyph: 'mine' });
        break;
      }
      default: {
        this.fx.burst(tx, ty, 18, element, { speed: 100, life: 0.6 });
      }
    }
    // Every remote cast also gets a detonation bloom at the aim point, since that is
    // where the interesting part happens and where the cells will appear.
    this.fx.ring(tx, ty, element, { r0: 2, r1: (r || 8) * 3.2, life: 0.4, width: 2 });
    this.fx.burst(tx, ty, 18, element, { speed: 110 + (r || 8) * 4, life: 0.55 });
  }

  // ---------- spell world-helpers ----------

  // Everything within a radius of a world point. The local player is always a
  // candidate — Dark and Lightning both hit their own caster, which is exactly the
  // danger the lethality decision asks for. Remote players are included so spells
  // visibly reach them, but per the multiplayer scope only the local player takes
  // damage or curses.
  bodiesInRadius(x, y, rPx) {
    const out = [];
    const p = this.player;
    const pcx = p.x + p.w / 2, pcy = p.y + p.h / 2;
    if (Math.hypot(pcx - x, pcy - y) < rPx) out.push({ self: true, x: pcx, y: pcy });
    for (const id in this.remotePlayers) {
      if (id === this.netId) continue;
      const rp = this.remotePlayers[id];
      const rx = rp.x + PLAYER_BOX.w / 2, ry = rp.y + PLAYER_BOX.h / 2;
      if (Math.hypot(rx - x, ry - y) < rPx) out.push({ self: false, x: rx, y: ry, id });
    }
    // Enemies are targets for exactly the same magic the player is.
    for (const e of this.enemies.list) {
      if (e.dead) continue;
      const ex = e.x + e.w / 2, ey = e.y + e.h / 2;
      if (Math.hypot(ex - x, ey - y) < rPx) out.push({ self: false, enemy: e, x: ex, y: ey });
    }
    return out;
  }

  damageEnemy(enemy, amount, element) {
    this.enemies.damage(enemy, amount, element);
  }

  healPlayer(amount) {
    const p = this.player;
    if (p.dead || p.health <= 0) return;
    p.health = Math.min(p.maxHealth, p.health + amount);
  }

  // Writes cells locally and mirrors the same op to the server, so a spell that
  // reshapes terrain reshapes it identically for everyone else in the session.
  netPlace(gx, gy, r, mat, life) {
    this.placeCircle(gx, gy, r, mat, life);
    this.sendNet({ t: 'place', gx, gy, r, mat, life });
  }

  netDig(gx, gy, r) {
    this.digCircle(gx, gy, r);
    this.sendNet({ t: 'dig', gx, gy, r });
  }

  // Water puts things out rather than setting them off: fire is quenched to smoke,
  // lava is chilled to stone, and open space fills with water. Used by every Water
  // spell, which is why flooding a burning room works the way you would expect.
  // Kinetic shove on the local player and on loose debris. Water's whole identity is
  // force rather than damage, and Earth's is weight, so both lean on this heavily.
  knockback(x, y, radiusPx, strength, pushX = 0, pushY = 0) {
    const p = this.player;
    const pcx = p.x + p.w / 2, pcy = p.y + p.h / 2;
    const d = Math.hypot(pcx - x, pcy - y);
    if (d < radiusPx) {
      const falloff = 1 - d / radiusPx;
      const ang = d < 1 ? -Math.PI / 2 : Math.atan2(pcy - y, pcx - x);
      p.impulseX = Phaser.Math.Clamp(p.impulseX + Math.cos(ang) * strength * falloff + pushX * falloff, -600, 600);
      // Biased upward: a shove that only pushes sideways reads as sliding, not force.
      p.vy += Math.sin(ang) * strength * falloff * 0.6 - 55 * falloff + pushY * falloff;
    }
    for (const dbg of this.debris) {
      const dd = Math.hypot(dbg.x - x, dbg.y - y);
      if (dd < radiusPx) {
        const falloff = 1 - dd / radiusPx;
        const ang = Math.atan2(dbg.y - y, dbg.x - x);
        dbg.vx += Math.cos(ang) * strength * falloff * 2 + pushX * falloff;
        dbg.vy += Math.sin(ang) * strength * falloff - 40 * falloff;
      }
    }
    // Enemies get shoved by the same forces, which is what makes Water and Earth
    // read as physical against them.
    for (const e of this.enemies.list) {
      const ed = Math.hypot(e.x + e.w / 2 - x, e.y + e.h / 2 - y);
      if (ed < radiusPx) {
        const falloff = 1 - ed / radiusPx;
        const ang = Math.atan2(e.y + e.h / 2 - y, e.x + e.w / 2 - x);
        e.vx += Math.cos(ang) * strength * falloff * 2 + pushX * falloff;
        e.vy += Math.sin(ang) * strength * falloff - 60 * falloff;
      }
    }
  }

  applyBlastImpulse(x, y, radiusPx, strength, notifyNetwork = false, msgElement = 'Fire') {
    radiusPx = Phaser.Math.Clamp(radiusPx, 1, 600);
    strength = Phaser.Math.Clamp(strength, 0, 420);
    const p = this.player;
    const dx = p.x + p.w / 2 - x, dy = p.y + p.h / 2 - y;
    const distance = Math.hypot(dx, dy);
    if (distance < radiusPx) {
      const falloff = 1 - distance / radiusPx;
      // A blast centered exactly on the body still launches it upward instead of
      // normalizing a zero vector and producing NaN velocities.
      const ux = distance > 0.01 ? dx / distance : 0;
      const uy = distance > 0.01 ? dy / distance : -1;
      const force = strength * falloff;
      p.impulseX = Phaser.Math.Clamp(p.impulseX + ux * force, -600, 600);
      p.vy = Phaser.Math.Clamp(p.vy + uy * force * 0.52 - 105 * falloff, -700, 650);
      p.grounded = false;
      if (p.dead) {
        const spin = (ux || (p.facing || 1) * 0.4) * (1 + force / 220);
        p.rotationV = Phaser.Math.Clamp(p.rotationV + spin, -8, 8);
        if (msgElement === 'Fire') p.burning = true;
      }
    }
    if (notifyNetwork) this.sendNet({ t: 'blastImpulse', x, y, radius: radiusPx, strength, element: msgElement });
  }

  receiveBlastImpulse(msg) {
    const x = +msg.x, y = +msg.y;
    const radius = +msg.radius, strength = +msg.strength;
    if (![x, y, radius, strength].every(Number.isFinite)) return;
    this.applyBlastImpulse(x, y,
      Phaser.Math.Clamp(radius, 1, 600),
      Phaser.Math.Clamp(strength, 0, 420), false, msg.element);
    GameAudio.blast(x, y, Math.min(1.5, 0.65 + strength / 600));
  }

  // Throws the player straight up when they are standing on a spot — Geyser Trap and
  // Spike Trap both use it. Separate from knockback() because the direction is fixed
  // rather than radial, and because a launch should read differently from a shove.
  launchPlayer(x, y, radiusPx, force) {
    const p = this.player;
    const pcx = p.x + p.w / 2, pcy = p.y + p.h / 2;
    const d = Math.hypot(pcx - x, pcy - y);
    if (d < radiusPx) {
      p.vy = Math.min(p.vy, -force);
      p.grounded = false;
    }
    for (const dbg of this.debris) {
      if (Math.hypot(dbg.x - x, dbg.y - y) < radiusPx) dbg.vy = Math.min(dbg.vy, -force * 0.7);
    }
  }

  // Cuts the footings out from under a structure. Rather than erasing a tunnel
  // through it, this targets the narrow band of cells actually carrying the load —
  // find each column's lowest solid cell inside the radius and remove it. The world's
  // own support rules then bring the whole thing down a moment later, which is why
  // Unraveling collapses a building instead of just boring a hole in it.
  severSupports(gx, gy, r) {
    for (let dx = -r; dx <= r; dx++) {
      const x = gx + dx;
      if (x <= 1 || x >= COLS - 2) continue;
      // Walk down to the deepest solid cell in this column within the band.
      let lowest = -1;
      for (let dy = -r; dy <= r; dy++) {
        const y = gy + dy;
        if (y <= 1 || y >= ROWS - 2) continue;
        const m = this.grid[this.idx(x, y)];
        if (IS_SOLID[m] && m !== BEDROCK) lowest = y;
      }
      if (lowest < 0) continue;
      for (let k = 0; k <= 2; k++) {
        const y = lowest - k;
        if (y <= 1) continue;
        const id = this.idx(x, y);
        if (this.grid[id] === BEDROCK) continue;
        if (IS_RIGID[this.grid[id]] && Math.random() < 0.3) {
          this.spawnDebris(x, y, this.grid[id], gx, gy, true);
        }
        this.setCell(id, EMPTY);
      }
      this.sendNet({ t: 'dig', gx: x, gy: lowest - 1, r: 3 });
    }
    this.fx.shake('Arcane', 0.008, 240);
    this.fx.burst(gx * PIXEL, gy * PIXEL, 18, 'Arcane', { speed: 60, life: 0.7, rise: 40 });
    // Nothing is holding the remainder up, so it collapses on the next support pass.
    this.time.delayedCall(140, () => {
      if (!this.multiplayer) this.checkStructuralSupport();
    });
  }

  // Marks terrain in an area as unsupported so the next structural pass drops it.
  // This is what lets Earth abilities cause genuine cascading collapses rather than
  // simply blowing a hole: the world's own support rules do the rest.
  destabilize(gx, gy, r) {
    for (let dy = -r; dy <= r; dy++) {
      for (let dx = -r; dx <= r; dx++) {
        if (dx * dx + dy * dy > r * r) continue;
        const x = gx + dx, y = gy + dy;
        if (x <= 0 || x >= COLS - 1 || y <= 0 || y >= ROWS - 1) continue;
        const id = this.idx(x, y);
        const m = this.grid[id];
        // suppVisited is only maintained locally in single-player; in multiplayer the
        // server owns collapse, so the `shock` op below is what actually does the work.
        if (IS_RIGID[m] && this.suppVisited && !this.suppVisited[id]) {
          this.falling[id] = 1;
        }
      }
    }
    this.sendNet({ t: 'shock', gx, gy, r });
  }

  spawnDebris(x, y, mat, centerX, centerY, explosive) {
    if (this.debris.length > 80) return;
    const dx = x - centerX, dy = y - centerY;
    const dist = Math.max(1, Math.hypot(dx, dy));
    const baseSpeed = explosive ? Phaser.Math.Between(120, 260) : Phaser.Math.Between(30, 90);
    this.debris.push({
      x: x * PIXEL + PIXEL / 2,
      y: y * PIXEL + PIXEL / 2,
      vx: (dx / dist) * baseSpeed + Phaser.Math.Between(-30, 30),
      vy: (dy / dist) * baseSpeed - Phaser.Math.Between(20, 60),
      mat,
      // the palette variant, so a brick or plank lands looking like what it was
      // (spell ice keeps its default life: there `life` is its thaw timer)
      variant: mat === ICE ? undefined : this.life[this.idx(x, y)],
      settleTimer: 6,
      bounces: 2,
      impactArmed: !this.fallingPointOverlapsBody(x * PIXEL + PIXEL / 2, y * PIXEL + PIXEL / 2, PIXEL * 0.8),
      impactContacts: new Set(),
    });
  }

  fallingBodies() {
    const out = [];
    const p = this.player;
    if (!p.dead && p.health > 0) out.push({ key: 'self', target: p, x: p.x, y: p.y, w: p.w, h: p.h, self: true });
    for (const id in this.remotePlayers) {
      if (id === this.netId) continue;
      const rp = this.remotePlayers[id];
      if (rp.dead || rp.health <= 0) continue;
      out.push({ key: `remote:${id}`, target: rp, x: rp.x, y: rp.y, w: PLAYER_BOX.w, h: PLAYER_BOX.h, remoteId: id });
    }
    for (const enemy of this.enemies.list) {
      if (enemy.dead || enemy.health <= 0) continue;
      out.push({ key: enemy, target: enemy, x: enemy.x, y: enemy.y, w: enemy.w, h: enemy.h, enemy: true });
    }
    return out;
  }

  fallingPointOverlapsBody(x, y, pad) {
    return this.fallingBodies().some((b) => x >= b.x - pad && x <= b.x + b.w + pad
      && y >= b.y - pad && y <= b.y + b.h + pad);
  }

  clipFallingSweep(x0, y0, x1, y1) {
    const dx = x1 - x0, dy = y1 - y0;
    const steps = Math.max(1, Math.ceil(Math.hypot(dx, dy) / (PIXEL * 0.5)));
    let lastX = x0, lastY = y0, blocked = false, outOfBounds = false;
    for (let i = 1; i <= steps; i++) {
      const t = i / steps, x = x0 + dx * t, y = y0 + dy * t;
      const gx = Math.floor(x / PIXEL), gy = Math.floor(y / PIXEL);
      if (gx < 0 || gx >= COLS || gy < 0 || gy >= ROWS) {
        blocked = true;
        outOfBounds = true;
        break;
      }
      if (!IS_OPEN[this.grid[this.idx(gx, gy)]]) {
        blocked = true;
        break;
      }
      lastX = x; lastY = y;
    }
    return { x: lastX, y: lastY, blocked, outOfBounds };
  }

  canApplyFallingDamage(target, remoteKey = null) {
    const now = this.time.now;
    if (remoteKey !== null) {
      const until = this.remoteFallImpactAt.get(remoteKey) || 0;
      if (until > now) return false;
      this.remoteFallImpactAt.set(remoteKey, now + 220);
      return true;
    }
    const until = this.fallImpactCooldown.get(target) || 0;
    if (until > now) return false;
    this.fallImpactCooldown.set(target, now + 220);
    return true;
  }

  applyFallingBodyDamage(body, amount, element = 'Impact') {
    if (!this.canApplyFallingDamage(body.target, body.remoteId ? body.key : null)) return false;
    if (body.self) this.damagePlayer(amount, { source: element });
    else if (body.enemy) this.damageEnemy(body.target, amount, element);
    else this.reportHit(body.remoteId, element, amount, null);
    return true;
  }

  handleRigidFallImpact(hit) {
    const amount = PixelWorld.impactDamage(hit.speed, hit.mat);
    if (amount <= 0) return;
    for (const body of this.fallingBodies()) {
      // World only emits this after a rigid cell moved into an open destination,
      // so this short segment is already terrain-clear.
      if (!PixelWorld.segmentEntersRect(hit.fromX, hit.fromY, hit.toX, hit.toY,
        body.x, body.y, body.w, body.h, PIXEL * 0.55)) continue;
      this.applyFallingBodyDamage(body, amount);
    }
  }

  handleDebrisImpact(d, fromX, fromY, speed) {
    const pad = PIXEL * 0.8;
    const bodies = this.fallingBodies();
    let clearOfBodies = true;
    for (const body of bodies) {
      const inside = d.x >= body.x - pad && d.x <= body.x + body.w + pad
        && d.y >= body.y - pad && d.y <= body.y + body.h + pad;
      if (inside) clearOfBodies = false;
    }
    const end = this.clipFallingSweep(fromX, fromY, d.x, d.y);
    const contacts = new Set();
    const intersections = [];
    const baseDamage = PixelWorld.impactDamage(speed, d.mat, 1.35);
    for (const body of bodies) {
      const inside = d.x >= body.x - pad && d.x <= body.x + body.w + pad
        && d.y >= body.y - pad && d.y <= body.y + body.h + pad;
      if (inside) contacts.add(body.key);
      if (!d.impactArmed || d.impactContacts.has(body.key)) continue;
      const entry = PixelWorld.segmentRectEntry(fromX, fromY, end.x, end.y,
        body.x, body.y, body.w, body.h, pad);
      if (entry !== null) intersections.push({ body, entry });
    }
    intersections.sort((a, b) => a.entry - b.entry);
    for (const { body } of intersections) {
      if (body.self && d.tkThrown > 0 && d.tkArm > 0) continue;
      const thrownHit = d.tkThrown > 0 && speed > 160 && IS_SOLID[d.mat];
      const amount = Math.max(baseDamage, thrownHit ? d.tkThrown : 0);
      if (amount <= 0) continue;
      const element = thrownHit ? 'Arcane' : 'Impact';
      if (this.applyFallingBodyDamage(body, amount, element)) {
        if (thrownHit) {
          d.tkThrown = 0;
          d.vx *= 0.2;
          d.vy *= 0.2;
          this.fx.burst(d.x, d.y, 10, 'Arcane', { speed: 110, life: 0.4 });
          this.fx.shake('Arcane', 0.005, 90);
        }
        break;
      }
    }
    d.impactContacts = contacts;
    if (!d.impactArmed && clearOfBodies) d.impactArmed = true;
  }

  settleDebris(d, gx, gy) {
    if (gx <= 0 || gx >= COLS - 1 || gy <= 0 || gy >= ROWS - 1) return;
    const id = this.idx(gx, gy);
    if (this.grid[id] === BEDROCK) return;
    this.setCell(id, d.mat, d.variant);
    this.sendNet({ t: 'settle', gx, gy, mat: d.mat });
  }

  updateDebris(dt) {
    const isOpen = (m) => IS_OPEN[m] === 1;
    for (let i = this.debris.length - 1; i >= 0; i--) {
      const d = this.debris[i];
      if (!(d.impactContacts instanceof Set)) d.impactContacts = new Set();
      if (typeof d.impactArmed !== 'boolean') {
        d.impactArmed = !this.fallingPointOverlapsBody(d.x, d.y, PIXEL * 0.8);
      }

      // Telekinesis holds objects up against gravity and stops them settling. The
      // channel does its own steering, so all this has to do is move it and get out
      // of the way — no gravity, no landing, no embedding in terrain it drifts past.
      if (d.tkHeld) {
        d.x += d.vx * dt;
        d.y += d.vy * dt;
        const hgx = Math.floor(d.x / PIXEL), hgy = Math.floor(d.y / PIXEL);
        if (hgx < 1 || hgx >= COLS - 1 || hgy < 1 || hgy >= ROWS - 1) {
          this.debris.splice(i, 1);
        }
        continue;
      }

      d.vy += 380 * dt;
      if (d.vy > 500) d.vy = 500;
      d.vx *= 0.995;
      const fromX = d.x, fromY = d.y;
      d.x += d.vx * dt;
      d.y += d.vy * dt;
      d.settleTimer -= dt;

      const sweep = this.clipFallingSweep(fromX, fromY, d.x, d.y);
      const movementBlocked = sweep.blocked;
      const leftWorld = sweep.outOfBounds;
      d.x = sweep.x; d.y = sweep.y;
      const gx = Math.floor(d.x / PIXEL), gy = Math.floor(d.y / PIXEL);

      if (d.tkArm > 0) d.tkArm -= dt;
      this.handleDebrisImpact(d, fromX, fromY, Math.hypot(d.vx, d.vy));
      // Process the clipped sweep first so a fast chunk can still hit a body it
      // crossed immediately before reaching a boundary.
      if (leftWorld || gx < 1 || gx >= COLS - 1 || gy < 1 || gy >= ROWS - 1) {
        this.debris.splice(i, 1);
        continue;
      }

      const embedded = !isOpen(this.grid[this.idx(gx, gy)]);
      const below = this.grid[this.idx(gx, Math.min(gy + 1, ROWS - 1))];
      const landing = !isOpen(below) && d.vy >= 0;

      if (movementBlocked && !landing) {
        const horizontal = Math.abs(d.vx) > Math.abs(d.vy);
        const component = horizontal ? d.vx : d.vy;
        if (d.bounces > 0 && Math.abs(component) > 80) {
          if (horizontal) d.vx = -d.vx * 0.35;
          else d.vy = -d.vy * 0.35;
          d.bounces--;
        } else {
          this.settleDebris(d, gx, gy);
          this.debris.splice(i, 1);
          continue;
        }
      }

      if (embedded) {
        this.settleDebris(d, gx, Math.max(gy - 1, 1));
        this.debris.splice(i, 1);
      } else if (landing) {
        if (d.bounces > 0 && Math.abs(d.vy) > 80) {
          d.vy = -d.vy * 0.35;
          d.vx *= 0.5;
          d.bounces--;
        } else {
          this.settleDebris(d, gx, gy);
          this.debris.splice(i, 1);
        }
      } else if (d.settleTimer <= 0) {
        this.settleDebris(d, gx, gy);
        this.debris.splice(i, 1);
      }
    }
  }

  drawDebris() {
    this.debrisGfx.clear();
    const s = PIXEL * 1.6;
    for (const d of this.debris) {
      const pal = PALETTE[d.mat];
      const c = pal[(d.variant || 0) % pal.length];
      // Anything Telekinesis is holding or has just thrown gets an arcane halo, so
      // you can tell at a glance what is under your control and what is only rubble.
      if (d.tkHeld || d.tkThrown) {
        this.debrisGfx.fillStyle(0x66d9ff, d.tkHeld ? 0.35 : 0.22);
        this.debrisGfx.fillCircle(d.x, d.y, s * (d.tkHeld ? 1.5 : 1.2));
      }
      this.debrisGfx.fillStyle(Phaser.Display.Color.GetColor(c[0], c[1], c[2]), 1);
      this.debrisGfx.fillRect(d.x - s / 2, d.y - s / 2, s, s);
    }
  }

  // Homing seeks the nearest player, but with nobody else connected it falls back to
  // loose debris — otherwise the form is dead weight in single-player.
  steerHoming(pr, dt) {
    // A seeker turns at a fixed rate, so its tightest possible arc is speed/turnRate
    // — around 94px here. Anything closer than that cannot be reached at all: the
    // bolt just orbits it forever. Ignoring near targets is what stops that, and it
    // also keeps a bolt from curving straight back into its own caster when the only
    // thing nearby is debris at their feet.
    const MIN_TARGET_DIST = 110;

    let target = null, best = Infinity;
    for (const id in this.remotePlayers) {
      if (id === this.netId) continue;
      const rp = this.remotePlayers[id];
      const d = Phaser.Math.Distance.Between(pr.x, pr.y, rp.x, rp.y);
      if (d < best && d > MIN_TARGET_DIST) { best = d; target = rp; }
    }
    if (!target) {
      for (const d of this.debris) {
        const dist = Phaser.Math.Distance.Between(pr.x, pr.y, d.x, d.y);
        if (dist < best && dist > MIN_TARGET_DIST) { best = dist; target = d; }
      }
    }
    // Also refuse to lock onto anything sitting on top of the caster, so a homing
    // cast always leaves the muzzle rather than circling its owner.
    if (target && Math.hypot(target.x - pr.ctx.originX, target.y - pr.ctx.originY) < MIN_TARGET_DIST) {
      target = null;
    }
    if (!target || best > 260 * PIXEL) return;

    const desiredAngle = Math.atan2(target.y - pr.y, target.x - pr.x);
    const curAngle = Math.atan2(pr.vy, pr.vx);
    const speed = Math.hypot(pr.vx, pr.vy);
    let diff = desiredAngle - curAngle;
    while (diff > Math.PI) diff -= Math.PI * 2;
    while (diff < -Math.PI) diff += Math.PI * 2;
    const turn = Phaser.Math.Clamp(diff, -3.2 * dt, 3.2 * dt);
    const newAngle = curAngle + turn;
    pr.vx = Math.cos(newAngle) * speed;
    pr.vy = Math.sin(newAngle) * speed;
  }

  // Projectiles connect with a body if their centre comes within a reach based on
  // their visual size, not their (much larger) grid blast radius — otherwise a bolt
  // "hits" things nowhere near where it looks like it is.
  entityHit(pr) {
    const p = this.player;
    const cx = p.x + p.w / 2, cy = p.y + p.h / 2;
    const reach = (pr.visualR || 5) * PIXEL * 0.9 + Math.max(p.w, p.h) * 0.45;

    // The caster can be hit by their own projectile, but only once it has genuinely
    // left their body — otherwise every bolt detonates in your face the frame it
    // spawns. Distance-based rather than time-based, so it holds at any launch speed.
    if (pr.clearedCaster && Math.hypot(pr.x - cx, pr.y - cy) < reach) {
      return { self: true, x: cx, y: cy };
    }
    for (const id in this.remotePlayers) {
      if (id === this.netId) continue;
      const rp = this.remotePlayers[id];
      const rx = rp.x + PLAYER_BOX.w / 2, ry = rp.y + PLAYER_BOX.h / 2;
      if (Math.hypot(pr.x - rx, pr.y - ry) < reach) return { self: false, x: rx, y: ry };
    }
    for (const e of this.enemies.list) {
      if (e.dead) continue;
      const ex = e.x + e.w / 2, ey = e.y + e.h / 2;
      if (Math.hypot(pr.x - ex, pr.y - ey) < reach) return { self: false, enemy: e, x: ex, y: ey };
    }
    return null;
  }

  updateProjectiles(dt) {
    for (let i = this.projectiles.length - 1; i >= 0; i--) {
      const pr = this.projectiles[i];
      pr.age = (pr.age || 0) + dt;

      // A short position history, kept as a flat [x,y,x,y,...] list. drawProjectiles
      // strokes it as a tapering ribbon, which is what makes a bolt leave a visible
      // arc through the air instead of the single stub segment it used to draw.
      if (!pr.hist) pr.hist = [];
      pr.hist.push(pr.x, pr.y);
      if (pr.hist.length > 18) pr.hist.splice(0, 2);

      // A projectile belonging to someone else's cast. It only ever draws itself —
      // no collision, no damage, no terrain — and bursts harmlessly when it lands.
      if (pr.visualOnly) {
        pr.vy += pr.gravity * dt;
        pr.x += pr.vx * dt;
        pr.y += pr.vy * dt;
        pr.life -= dt;
        if (Math.random() < 0.5) {
          this.fx.burst(pr.x, pr.y, 1, pr.element, { speed: 20, life: 0.35, size: 1.1, rise: -4 });
        }
        const done = pr.life <= 0 || this.solidAt(pr.x, pr.y)
          || pr.x < 0 || pr.x >= WORLD_WIDTH || pr.y < 0 || pr.y >= WORLD_HEIGHT;
        if (done) {
          this.projectiles.splice(i, 1);
          GameAudio.impact(pr.element, pr.x, pr.y, { strength: 0.72 });
          this.fx.burst(pr.x, pr.y, 18, pr.element, { speed: 110, life: 0.5 });
          this.fx.ring(pr.x, pr.y, pr.element, { r0: 2, r1: pr.radius * 3, life: 0.35, width: 2 });
        }
        continue;
      }

      if (pr.homing) this.steerHoming(pr, dt);

      // Forked Bolt: one bolt that splits in mid-air rather than a fan from the
      // muzzle. Because the spread begins halfway to the target, it reaches around
      // cover that a muzzle fan would sail past.
      if (pr.forkAt && !pr.forked && pr.age > pr.forkAt) {
        pr.forked = true;
        const speed = Math.hypot(pr.vx, pr.vy);
        const base = Math.atan2(pr.vy, pr.vx);
        this.fx.bolt(pr.x - 30, pr.y - 30, pr.x + 30, pr.y + 30, pr.element,
          { life: 0.18, branches: 3, jitter: 16 });
        for (const off of [-0.38, 0.38]) {
          this.projectiles.push({
            ...pr,
            vx: Math.cos(base + off) * speed,
            vy: Math.sin(base + off) * speed,
            forked: true,
            forkAt: 0,
            // Each branch needs its OWN trail history. A spread copy shares the array
            // by reference, so all three forks would append to one list and their
            // ribbons would zigzag between each other.
            hist: [pr.x, pr.y],
          });
        }
      }

      pr.vy += (pr.gravity ?? 90) * dt;
      pr.x += pr.vx * dt;
      pr.y += pr.vy * dt;
      pr.life -= dt;

      const outOfBounds = pr.x < 0 || pr.x >= WORLD_WIDTH || pr.y < 0 || pr.y >= WORLD_HEIGHT;
      if (outOfBounds) {
        this.projectiles.splice(i, 1);
        continue;
      }

      // Arm the projectile against its caster only once it is clear of them. This is
      // what stops a bolt detonating in the caster's own face at spawn, while still
      // letting you shoot yourself if you walk into your own shot.
      if (!pr.clearedCaster) {
        const p = this.player;
        const clearDist = (pr.visualR || 5) * PIXEL * 1.6 + Math.max(p.w, p.h);
        if (Math.hypot(pr.x - (p.x + p.w / 2), pr.y - (p.y + p.h / 2)) > clearDist) {
          pr.clearedCaster = true;
        }
      }

      // Entities are tested before terrain: hitting a player should detonate in the
      // air next to them rather than waiting for the wall behind.
      const hit = this.entityHit(pr);
      if (hit) {
        const gx = Math.floor(hit.x / PIXEL), gy = Math.floor(hit.y / PIXEL);
        this.projectiles.splice(i, 1);
        if (hit.self) {
          this.damagePlayer(pr.radius * 1.6, { source: pr.element });
        } else if (hit.enemy) {
          this.damageEnemy(hit.enemy, pr.radius * 2.2, pr.element);
          this.fx.burst(hit.x, hit.y, 12, pr.element, { speed: 100, life: 0.4 });
        } else {
          // A projectile striking another player reports the hit and lets their
          // client apply it, then detonates normally so the impact looks right.
          this.reportHit(hit.id, pr.element, pr.radius * 1.6, null);
          this.fx.burst(hit.x, hit.y, 14, pr.element, { speed: 90, life: 0.45 });
        }
        this.detonateProjectile(pr, gx, gy);
        continue;
      }

      if (this.solidAt(pr.x, pr.y) && !pr.phase) {
        const gx = Math.floor(pr.x / PIXEL), gy = Math.floor(pr.y / PIXEL);
        if (pr.pierce > 0) {
          pr.pierce--;
          // An element may take over what boring through does (Water keeps the ice and
          // snow it drills through instead of deleting it).
          const PE = Spells.ELEMENTS[pr.element];
          if (PE && PE.pierceStep) PE.pierceStep(this, pr, gx, gy, 3);
          else this.digCircle(gx, gy, 3);
          this.sendNet({ t: 'dig', gx, gy, r: 3 });
        } else {
          this.projectiles.splice(i, 1);
          this.detonateProjectile(pr, gx, gy);
          continue;
        }
      } else if (pr.life <= 0) {
        this.projectiles.splice(i, 1);
        const gx = Math.floor(pr.x / PIXEL), gy = Math.floor(pr.y / PIXEL);
        this.detonateProjectile(pr, gx, gy);
        continue;
      }

      const E = Spells.ELEMENTS[pr.element];

      if (pr.leavesTrail) {
        pr.trailTimer -= dt;
        if (pr.trailTimer <= 0) {
          pr.trailTimer = 0.045;
          const tgx = Math.floor(pr.x / PIXEL), tgy = Math.floor(pr.y / PIXEL);
          this.trailStep(pr, tgx, tgy);
        }
      }

      // Ward: Arcane's orbiting shards erase any projectile that touches them. This
      // is the only defence in the game that destroys an attack outright rather than
      // out-damaging it, so it is checked before anything else can happen.
      let warded = false;
      for (const o of this.orbitSpells) {
        if (!o.ward) continue;
        for (const em of o.embers) {
          if (em.x === undefined) continue;
          if (Math.hypot(pr.x - em.x, pr.y - em.y) < o.emberRadius * PIXEL * 1.8) {
            this.fx.burst(pr.x, pr.y, 12, 'Arcane', { speed: 80, life: 0.4, rise: -20 });
            this.fx.ring(em.x, em.y, 'Arcane', { r0: 1, r1: 14, life: 0.25, width: 2 });
            warded = true;
            break;
          }
        }
        if (warded) break;
      }
      if (warded) { this.projectiles.splice(i, 1); continue; }

      // Element-specific in-flight behaviour (Dark drains, Water soaks) plus the
      // cosmetic wake every projectile leaves.
      if (E && E.projectileTick) E.projectileTick(this, pr, dt);

      // Wildfire extends the chain to every fuel cell it can reach, rather than the
      // usual capped handful — the difference between a spell and a disaster.
      if (pr.wildfire && Math.random() < 0.25) {
        const gx = Math.floor(pr.x / PIXEL), gy = Math.floor(pr.y / PIXEL);
        const near = Spells.ELEMENTS.Fire.chainTargets(this, gx, gy, 10, 1);
        for (let k = 0; k < Math.min(2, near.length); k++) {
          const [tx, ty] = near[k];
          if (Math.random() < 0.5) this.setCell(this.idx(tx, ty), FIRE, FIRE_LIFE);
        }
      }
      if (Math.random() < 0.35) {
        this.fx.burst(pr.x, pr.y, 1, pr.element, { speed: 18, life: 0.3, size: 1, rise: -6 });
      }
    }
  }

  // Trail forms paint matter behind the projectile. Default: lay the element's own
  // signature cell; Arcane overrides to erase instead.
  // `pr` is passed through as well as its ctx: Riverwalk needs to know which way the
  // bolt was actually travelling to lay its current in the right direction, which the
  // cast context alone cannot say once a bolt has curved or forked.
  trailStep(pr, gx, gy) {
    const E = Spells.ELEMENTS[pr.element];
    if (E && E.trailStep) { E.trailStep(this, gx, gy, pr.ctx, pr); return; }
    this.placeCircle(gx, gy, 2, FIRE);
    this.sendNet({ t: 'place', gx, gy, r: 2, mat: FIRE });
  }

  detonateProjectile(pr, gx, gy) {
    Spells.detonate(this, { ...pr.ctx, gx, gy }, pr.radius);
  }

  drawProjectiles() {
    this.projectileGfx.clear();
    for (const pr of this.projectiles) {
      const R = pr.visualR * PIXEL;
      const pal = this.fx.palette(pr.element);

      // A tapering ribbon along the path actually travelled — this is what makes a
      // bolt read as *moving* rather than as a dot that happens to be somewhere, and
      // unlike the old single stub it follows a curve, so homing and forked bolts
      // visibly bend.
      const h = pr.hist;
      if (h && h.length >= 4) {
        const segs = h.length / 2 - 1;
        for (let k = 0; k < segs; k++) {
          // Newer segments are wider and brighter; the tail thins out to nothing.
          const f = (k + 1) / segs;
          this.projectileGfx.lineStyle(R * 0.85 * f, pal.glow, 0.42 * f);
          this.projectileGfx.beginPath();
          this.projectileGfx.moveTo(h[k * 2], h[k * 2 + 1]);
          this.projectileGfx.lineTo(h[k * 2 + 2], h[k * 2 + 3]);
          this.projectileGfx.strokePath();
        }
        // One thin hot line down the middle of the whole ribbon.
        this.projectileGfx.lineStyle(Math.max(1, R * 0.22), pal.core, 0.5);
        this.projectileGfx.beginPath();
        this.projectileGfx.moveTo(h[0], h[1]);
        for (let k = 2; k < h.length; k += 2) this.projectileGfx.lineTo(h[k], h[k + 1]);
        this.projectileGfx.strokePath();
      }

      const flicker = 0.85 + Math.random() * 0.3;
      this.projectileGfx.fillStyle(pal.deep, 0.25);
      this.projectileGfx.fillCircle(pr.x, pr.y, R * 1.8 * flicker);
      this.projectileGfx.fillStyle(pal.glow, 0.55);
      this.projectileGfx.fillCircle(pr.x, pr.y, R * flicker);
      this.projectileGfx.fillStyle(pal.core, 1);
      this.projectileGfx.fillCircle(pr.x, pr.y, R * 0.5);
    }
  }

  // ---------- channelled casts ----------
  // Held spells rather than fired ones: Flamethrower, Frost Spray, Telekinesis and
  // every other Beam. This half owns the lifecycle — which slot is channelling, when
  // it starts and stops — while spells.js owns what a tick actually does.

  isChannelCombo(slot) {
    const combo = this.spellCombos[slot];
    if (!combo) return false;
    return Spells.isChannel(combo.element, combo.form, combo.modifier);
  }

  beginChannel(slot) {
    if (this.player.dead) return;
    // Lightning's EMP blocks starting a channel for the same reason it blocks a cast.
    if (this.time.now < this.status.empUntil) {
      this.fx.burst(this.player.x + this.player.w / 2, this.player.y + this.player.h / 2, 8, 'Lightning', { speed: 40, life: 0.3 });
      return;
    }
    const combo = this.spellCombos[slot];
    if (!combo) return;
    // Pressing again while already channelling this slot does nothing; releasing is
    // the only way to end one, which is what makes the duration cap meaningful.
    if (this.channels[slot]) return;

    // Marks are spent on starting a channel exactly as they are on a one-shot cast,
    // so a Soul Spike or storm mark still pays off into a flamethrower.
    const mark = this.status.marks.soulSpike || this.status.marks.storm;
    let radiusBoost = 1;
    if (mark && this.time.now < mark) {
      radiusBoost = 1.35;
      delete this.status.marks.soulSpike;
      delete this.status.marks.storm;
    }
    const overcharge = this.status.buffs.overcharge || 0;
    if (overcharge > 0) {
      radiusBoost *= 1.6;
      delete this.status.buffs.overcharge;
    }

    this.channels[slot] = Spells.startChannel(
      this, combo.element, combo.form, combo.modifier, slot, radiusBoost,
    );
    if (this.channels[slot]) GameAudio.cast(combo.element, this.player.x + this.player.w / 2, this.player.y + this.player.h / 2);
  }

  stopChannel(slot) {
    const ch = this.channels[slot];
    if (!ch) return;
    this.channels[slot] = null;
    Spells.endChannel(this, ch);
  }

  updateChannels(dt) {
    for (const slot of ['primary', 'secondary']) {
      const ch = this.channels[slot];
      if (!ch) continue;
      // tickChannel returns false when the channel has run out its duration cap or
      // been cut off (an EMP landed mid-spray).
      if (!Spells.tickChannel(this, ch, dt)) this.stopChannel(slot);
    }
  }

  // How much of each active channel is left, for the HUD. Without a readout the
  // duration cap just feels like the spell randomly quitting on you.
  channelStatusLines() {
    const out = [];
    for (const slot of ['primary', 'secondary']) {
      const ch = this.channels[slot];
      if (!ch) continue;
      const left = Math.max(0, Spells.CHANNEL_MAX - ch.elapsed);
      const bars = Math.round((left / Spells.CHANNEL_MAX) * 10);
      const name = Spells.abilityName(ch.element, ch.form, ch.modifier)
        || `${ch.element} ${ch.form}`;
      const carrying = ch.held && ch.held.length ? `  carrying ${ch.held.length}` : '';
      out.push(`${name} ${'|'.repeat(bars)}${'.'.repeat(10 - bars)}${carrying}`);
    }
    return out;
  }

  castWheelSpell(slot) {
    if (this.player.dead) return;
    // Lightning's EMP locks casting outright — the entire point of Static Snap.
    if (this.time.now < this.status.empUntil) {
      this.fx.burst(this.player.x + this.player.w / 2, this.player.y + this.player.h / 2, 8, 'Lightning', { speed: 40, life: 0.3 });
      return;
    }
    const combo = this.spellCombos[slot];
    if (!combo) return;

    // Throw the cast pose for a beat, lit by the element actually being thrown.
    this.castAnimUntil = this.time.now + 240;
    this.castGlowElement = combo.element;

    // A mark placed by an earlier cast is spent by the next one, and amplifies it.
    const mark = this.status.marks.soulSpike || this.status.marks.storm;
    let radiusBoost = 1;
    if (mark && this.time.now < mark) {
      radiusBoost = 1.35;
      delete this.status.marks.soulSpike;
      delete this.status.marks.storm;
    }
    const overcharge = this.status.buffs.overcharge || 0;
    if (overcharge > 0) {
      radiusBoost *= 1.6;
      delete this.status.buffs.overcharge;
    }

    // Tell everyone else what was cast, so the magic is visible to them too rather
    // than only the crater it leaves behind. Coordinates only — the receiving client
    // draws the shape and gets the terrain changes as cells.
    const pointer = this.input.activePointer;
    this.sendNet({
      t: 'cast',
      element: combo.element,
      form: combo.form,
      modifier: combo.modifier,
      ox: this.player.x + this.player.w / 2,
      oy: this.player.y + this.player.h / 2,
      tx: pointer.worldX,
      ty: pointer.worldY,
      r: Spells.ELEMENTS[combo.element] ? Spells.ELEMENTS[combo.element].radius : 8,
    });

    Spells.cast(this, combo.element, combo.form, combo.modifier, radiusBoost);
  }

  // ---------- advancing ground waves ----------
  // A wave is one object that walks along the terrain surface, so it can be cancelled
  // and drawn as a crest. Previously this was 16 detached timers per cast.
  updateWaves(dt) {
    for (let i = this.waves.length - 1; i >= 0; i--) {
      const w = this.waves[i];
      w.timer -= dt;
      while (w.timer <= 0 && w.step < w.length) {
        w.step++;
        w.timer += w.interval;
        const x = w.gx + w.dir * w.step;
        if (x <= 1 || x >= COLS - 2) { w.step = w.length + 1; break; }
        // Ride the terrain surface rather than the caster's row. Casting while
        // standing on the ground would otherwise bury the whole wave inside the
        // hillside, which is invisible and useless. Search down from a little above
        // the previous step so the wave climbs slopes and drops into valleys.
        let sy = Math.max(1, (w.surfY ?? w.gy) - 6);
        let guard = 0;
        while (sy < ROWS - 2 && !this.solidAtCell(x, sy + 1) && guard++ < 80) sy++;
        w.surfY = sy;
        const E = Spells.ELEMENTS[w.element];
        if (E && E.groundStep) E.groundStep(this, x, sy, w.ctx, w);
      }
      if (w.step >= w.length) {
        this.waves.splice(i, 1);
        if (w.finalDetonate) {
          const endX = Math.max(2, Math.min(COLS - 3, w.gx + w.dir * w.length));
          Spells.detonate(this, {
            ...w.ctx, gx: endX, gy: w.gy, modifier: w.modifier,
          }, Math.round(w.ctx.radius * 0.85));
        }
      }
    }
  }

  updateOrbitSpells(dt) {
    const p = this.player;
    const cx = p.x + p.w / 2, cy = p.y + p.h / 2;

    for (let i = this.orbitSpells.length - 1; i >= 0; i--) {
      const o = this.orbitSpells[i];
      o.time += dt;
      const E = Spells.ELEMENTS[o.element];
      if (o.time >= o.duration) {
        this.orbitSpells.splice(i, 1);
        // Anything the ring was still carrying (Water's droplets) is let go here.
        if (E && E.orbitEnd) E.orbitEnd(this, o);
        continue;
      }
      for (const e of o.embers) {
        e.tickTimer -= dt;
        const angle = e.phase + o.time * o.spinSpeed;
        e.x = cx + Math.cos(angle) * o.orbitRadius;
        e.y = cy + Math.sin(angle) * o.orbitRadius;
        if (Math.random() < 0.5) {
          this.fx.burst(e.x, e.y, 1, o.element, { speed: 10, life: 0.3, size: 1, rise: 5 });
        }
        if (e.tickTimer <= 0) {
          e.tickTimer = o.tickInterval;
          const gx = Math.floor(e.x / PIXEL), gy = Math.floor(e.y / PIXEL);
          if (E && E.orbitTick) E.orbitTick(this, gx, gy, o.emberRadius, o.ctx, o);
        }
      }
    }
  }

  drawOrbitSpells() {
    this.orbitGfx.clear();
    for (const o of this.orbitSpells) {
      const pal = this.fx.palette(o.element);
      for (const e of o.embers) {
        if (e.x === undefined) continue;
        this.orbitGfx.fillStyle(pal.glow, 0.9);
        this.orbitGfx.fillCircle(e.x, e.y, 1.6 * PIXEL);
        this.orbitGfx.fillStyle(pal.core, 1);
        this.orbitGfx.fillCircle(e.x, e.y, 0.7 * PIXEL);
      }
    }
  }

  // ---------- mines ----------
  // Mines are real per-frame objects rather than delayedCall handles, so they can be
  // disarmed, re-armed, made permanent (a turret), or turned into beacons and portals.
  updateMines(dt) {
    for (let i = this.mines.length - 1; i >= 0; i--) {
      const m = this.mines[i];
      m.age += dt;
      if (m.fuse !== null) {
        m.fuse -= dt;
        if (m.fuse <= 0) {
          this.mines.splice(i, 1);
          Spells.detonate(this, { ...m.ctx, gx: m.gx, gy: m.gy, modifier: m.detonateModifier }, m.radius);
          continue;
        }
      }
      if (m.repeat !== null && m.age > m.armTimer) {
        m.pulseTimer -= dt;
        if (m.pulseTimer <= 0) {
          m.pulseTimer = m.repeat;
          // The element's whole impact stack, not just its world effect — and flagged
          // `minor`, because a turret that fires forever must not hitstop or wash the
          // screen on every single discharge.
          Spells.elementImpact(this, { ...m.ctx, gx: m.gx, gy: m.gy },
            Math.max(3, Math.round(m.radius * 0.6)), { minor: true });
        }
      }
    }
  }

  drawMines() {
    this.minesGfx.clear();
    const t = this.time.now;
    for (const m of this.mines) {
      const pal = this.fx.palette(m.element);
      const cx = m.gx * PIXEL + PIXEL / 2, cy = m.gy * PIXEL + PIXEL / 2;
      const pulse = 0.5 + 0.5 * Math.sin(t / 120);
      this.minesGfx.fillStyle(pal.deep, 0.5 + pulse * 0.4);
      this.minesGfx.fillCircle(cx, cy, 3 * PIXEL);
      this.minesGfx.fillStyle(pal.core, 0.9);
      this.minesGfx.fillCircle(cx, cy, 1.2 * PIXEL);
      // Fuse ring: drains as the timer runs out so a trap visibly counts down.
      if (m.fuse !== null && m.fuseTotal) {
        const frac = Math.max(0, m.fuse / m.fuseTotal);
        this.minesGfx.lineStyle(1, pal.core, 0.9);
        this.minesGfx.beginPath();
        this.minesGfx.arc(cx, cy, 5 * PIXEL, -Math.PI / 2, -Math.PI / 2 + frac * Math.PI * 2, false);
        this.minesGfx.strokePath();
      }
      // A permanent installation (Tesla Coil) has no fuse ring to count down, so it
      // gets a charging arc instead — an idle turret should still look armed rather
      // than looking like a mine that forgot to go off.
      if (m.turret) {
        this.minesGfx.lineStyle(1, pal.glow, 0.35 + pulse * 0.45);
        this.minesGfx.strokeCircle(cx, cy, (5 + pulse * 2) * PIXEL);
        if (Math.random() < 0.08) {
          const a = Math.random() * Math.PI * 2;
          const d = m.radius * PIXEL;
          this.fx.bolt(cx, cy, cx + Math.cos(a) * d, cy + Math.sin(a) * d, m.element,
            { life: 0.12, branches: 1, jitter: 10, width: 1 });
        }
      }
      if (Math.random() < 0.15) {
        this.fx.burst(cx, cy, 1, m.element, { speed: 20, life: 0.4, size: 1, rise: 30 });
      }
    }
  }

  // ---------- lingering ground fields ----------
  updateFields(dt) {
    const p = this.player;
    const pcx = p.x + p.w / 2, pcy = p.y + p.h / 2;
    for (let i = this.fields.length - 1; i >= 0; i--) {
      const f = this.fields[i];
      f.remaining -= dt;
      if (f.remaining <= 0) { this.fields.splice(i, 1); continue; }
      const fx = f.x * PIXEL, fy = f.y * PIXEL;
      const rPx = f.r * PIXEL;
      const d = Math.hypot(pcx - fx, pcy - fy);
      if (d < rPx) {
        if (f.dps) this.damagePlayer(f.dps * dt, { source: f.element });
        if (f.slow && !this.status.slowUntil) {
          this.status.slowMul = f.slow;
          this.status.slowUntil = this.time.now + 200;
        }
        // Riverwalk: a current that carries you faster when you travel with it.
        if (f.pushX) {
          p.impulseX = Phaser.Math.Clamp(p.impulseX + f.pushX * dt * 60, -600, 600);
          p.vy += (f.pushY || 0) * dt * 60;
        }
      }
      if (Math.random() < 0.25) {
        this.fx.burst(
          fx + (Math.random() - 0.5) * rPx * 2,
          fy + (Math.random() - 0.5) * rPx * 2,
          1, f.element, { speed: 12, life: 0.5, size: 1, rise: 8 },
        );
      }
    }
  }

  drawFields() {
    const g = this.groundFxGfx;
    g.clear();
    for (const f of this.fields) {
      const pal = this.fx.palette(f.element);
      const cx = f.x * PIXEL, cy = f.y * PIXEL;
      const pulse = 0.5 + 0.5 * Math.sin(this.time.now / 200 + f.x);
      g.fillStyle(pal.deep, 0.22 + pulse * 0.14);
      g.fillCircle(cx, cy, f.r * PIXEL);
      g.lineStyle(1, pal.glow, 0.5);
      g.strokeCircle(cx, cy, f.r * PIXEL);
    }
  }

  // ---------- player status ----------
  updateStatus(dt) {
    if (this.player.dead) return;
    const st = this.status;

    for (let i = st.effects.length - 1; i >= 0; i--) {
      const e = st.effects[i];
      e.remaining -= dt;
      if (e.remaining <= 0) { st.effects.splice(i, 1); continue; }
      // Slow Death ramps: the longer a curse is left uncleansed, the harder it bites.
      const ramp = e.ramp ? 1 + (e.duration - e.remaining) / 3 : 1;
      if (e.dps) {
        this.damagePlayer(e.dps * ramp * dt, { source: e.element });
        if (this.player.dead) return;
      }
    }

    if (st.slowUntil && this.time.now > st.slowUntil) {
      st.slowUntil = 0;
      st.slowMul = 1;
    }
    if (st.vision < 1 && !st.effects.some((e) => e.vision)) st.vision = Math.min(1, st.vision + dt * 0.7);
    // Push the current vision level into the FX layer, which is what actually closes
    // the world in around you. Without this the vision debuff was tracked, decayed and
    // never seen — Wail's darkening existed only as a number.
    this.fx.visionDim = 1 - st.vision;
    const visionCurse = st.effects.find((e) => e.vision);
    this.fx.visionElement = visionCurse ? (visionCurse.element || 'Dark') : 'Dark';

    for (const k in st.marks) {
      if (this.time.now > st.marks[k]) delete st.marks[k];
    }

    // maxHealth is always derived, never mutated directly, so a Despair expiring
    // restores the ceiling without leaving the player permanently weakened.
    const targetMax = this.baseMaxHealth * st.maxHealthMul;
    if (this.player.maxHealth !== targetMax) {
      this.player.maxHealth = targetMax;
      this.player.health = Math.min(this.player.health, targetMax);
    }
  }

  applyStatusEffect(name, opts) {
    if (this.player.dead) return;
    const st = this.status;
    const existing = st.effects.find((e) => e.name === name);
    if (existing) {
      existing.remaining = Math.max(existing.remaining, opts.duration);
      existing.dps = Math.max(existing.dps || 0, opts.dps || 0);
      return;
    }
    st.effects.push({
      name,
      element: opts.element,
      dps: opts.dps || 0,
      remaining: opts.duration,
      duration: opts.duration,
      ramp: !!opts.ramp,
      vision: !!opts.vision,
    });
    if (opts.vision) st.vision = opts.vision;
    if (opts.slow) { st.slowMul = opts.slow; st.slowUntil = this.time.now + opts.duration * 1000; }
    if (opts.emp) st.empUntil = this.time.now + opts.emp;
    if (opts.glitch) st.glitchUntil = this.time.now + opts.glitch;
    if (opts.maxHealthMul) st.maxHealthMul = Math.min(st.maxHealthMul, opts.maxHealthMul);
  }

  // -- terminal detonation + modifier wrappers --

  // Clean disintegration: clears cells to EMPTY (no fire), with a chance of a
  // forcefully-launched rock/wood chunk to sell the "kinetic force" feel.
  arcaneErase(gx, gy, radius) {
    for (let dy = -radius; dy <= radius; dy++) {
      for (let dx = -radius; dx <= radius; dx++) {
        if (dx * dx + dy * dy > radius * radius) continue;
        const x = gx + dx, y = gy + dy;
        if (x <= 0 || x >= COLS - 1 || y <= 0 || y >= ROWS - 1) continue;
        const id = this.idx(x, y);
        const cur = this.grid[id];
        if (cur === BEDROCK) continue;
        if ((cur === STONE || cur === WOOD) && Math.random() < 0.35) {
          this.spawnDebris(x, y, cur, gx, gy, true);
        }
        this.setCell(id, EMPTY);
      }
    }
    this.sendNet({ t: 'dig', gx, gy, r: radius });
  }

  // Kinetic shockwave: positive ruptures use the shared bounded network impulse;
  // negative Absorb pulls retain their separate local direction and behavior.
  applyArcaneForce(gx, gy, radius, strength) {
    const cx = gx * PIXEL, cy = gy * PIXEL;
    const rangePx = radius * PIXEL * 2.2;

    if (strength > 0) {
      this.applyBlastImpulse(cx, cy, rangePx, strength, true, 'Arcane');
    } else {
      const p = this.player;
      const pdx = (p.x + p.w / 2) - cx, pdy = (p.y + p.h / 2) - cy;
      const pdist = Math.max(1, Math.hypot(pdx, pdy));
      if (pdist < rangePx) {
        const mag = strength * (1 - pdist / rangePx);
        p.impulseX = Phaser.Math.Clamp(p.impulseX + (pdx / pdist) * mag, -600, 600);
        p.vy += (pdy / pdist) * mag;
        p.grounded = false;
      }
    }

    for (const d of this.debris) {
      const ddx = d.x - cx, ddy = d.y - cy;
      const ddist = Math.max(1, Math.hypot(ddx, ddy));
      if (ddist < rangePx) {
        const mag = strength * (1 - ddist / rangePx);
        d.vx += (ddx / ddist) * mag;
        d.vy += (ddy / ddist) * mag;
      }
    }
  }

  handlePointer() {
    const p = this.input.activePointer;

    if (this.player.dead) {
      this.brushGfx.clear();
      this.prevLeftDown = p.leftButtonDown();
      this.prevRightDown = p.rightButtonDown();
      return;
    }

    if (this.wheelOpen) {
      this.brushGfx.clear();
      // Opening the wheel mid-spray cuts the spray off; you cannot re-assemble a
      // spell while still casting the old one.
      this.stopChannel('primary');
      this.stopChannel('secondary');
      this.prevLeftDown = p.leftButtonDown();
      this.prevRightDown = p.rightButtonDown();
      return;
    }

    const gx = Math.floor(p.worldX / PIXEL);
    const gy = Math.floor(p.worldY / PIXEL);
    const material = MATERIALS[this.materialIndex];

    const leftJustDown = p.leftButtonDown() && !this.prevLeftDown;
    const rightJustDown = p.rightButtonDown() && !this.prevRightDown;
    this.prevLeftDown = p.leftButtonDown();
    this.prevRightDown = p.rightButtonDown();

    this.brushGfx.clear();

    // left mouse button: bending, an assembled primary spell, or digging
    if (this.leftClickMode === 'bend') {
      // Hold to lift water or earth near the cursor and carry it; release to let go.
      const bender = this.benders[this.bendElement];
      if (leftJustDown) bender.begin();
      else if (!p.leftButtonDown()) bender.release();
      const ring = this.bendElement === 'Earth' ? 0xc8a064
        : this.bendElement === 'Fire' ? 0xff6600
        : this.bendElement === 'Air' ? 0xdff5fa
        : 0x66b8ff;
      this.brushGfx.lineStyle(1, ring, p.leftButtonDown() ? 0.8 : 0.45)
        .strokeCircle(p.worldX, p.worldY, bender.grabRadius * PIXEL);
    } else if (this.leftClickMode === 'primary') {
      // A channelled spell (Flamethrower, Frost Spray, Telekinesis, any Beam) is held
      // rather than fired: start it on press, let updateChannels drive it while the
      // button is down, and end it on release. Everything else still resolves on the
      // press alone, exactly as before.
      if (this.isChannelCombo('primary')) {
        if (leftJustDown) this.beginChannel('primary');
        else if (!p.leftButtonDown()) this.stopChannel('primary');
      } else if (leftJustDown) {
        this.castWheelSpell('primary');
      }
      this.brushGfx.lineStyle(1, 0x66ccff, 0.7).strokeCircle(p.worldX, p.worldY, 6 * PIXEL);
    } else if (p.leftButtonDown()) {
      this.digCircle(gx, gy, DIG_RADIUS);
      this.sendNet({ t: 'dig', gx, gy, r: DIG_RADIUS });
      this.brushGfx.lineStyle(1, 0xffffff, 0.6).strokeCircle(p.worldX, p.worldY, DIG_RADIUS * PIXEL);
    } else {
      this.brushGfx.lineStyle(1, 0x888888, 0.35).strokeCircle(p.worldX, p.worldY, DIG_RADIUS * PIXEL);
    }

    // right mouse button: an assembled secondary spell takes priority over placing the selected material
    if (this.rightClickMode === 'secondary') {
      if (this.isChannelCombo('secondary')) {
        if (rightJustDown) this.beginChannel('secondary');
        else if (!p.rightButtonDown()) this.stopChannel('secondary');
      } else if (rightJustDown) {
        this.castWheelSpell('secondary');
      }
      this.brushGfx.lineStyle(1, 0xcc66ff, 0.7).strokeCircle(p.worldX, p.worldY, 6 * PIXEL);
    } else if (p.rightButtonDown()) {
      this.placeCircle(gx, gy, material.radius, material.mat);
      this.sendNet({ t: 'place', gx, gy, r: material.radius, mat: material.mat });
      this.brushGfx.lineStyle(1, 0xffcc66, 0.8).strokeCircle(p.worldX, p.worldY, material.radius * PIXEL);
    } else {
      this.brushGfx.lineStyle(1, 0x888888, 0.5).strokeCircle(p.worldX, p.worldY, material.radius * PIXEL);
    }
  }

  handleSpellKeys() {
    const k = this.keys;
    // Esc remains available to leave; all other controls are inert while the body
    // waits to respawn, including the random-world reset key.
    if (this.player.dead) {
      if (Phaser.Input.Keyboard.JustDown(k.esc)) this.returnToMenu();
      for (const key of [k.one, k.two, k.three, k.four, k.five, k.six, k.seven, k.eight, k.nine, k.r, k.q, k.e, k.b]) {
        Phaser.Input.Keyboard.JustDown(key);
      }
      return;
    }
    const digitKeys = [k.one, k.two, k.three, k.four, k.five, k.six, k.seven, k.eight, k.nine];
    let picked = false;
    for (let i = 0; i < digitKeys.length; i++) {
      if (Phaser.Input.Keyboard.JustDown(digitKeys[i])) {
        this.materialIndex = i;
        picked = true;
      }
    }
    if (picked) {
      // picking a material explicitly hands control of the mouse back to digging/placing
      this.leftClickMode = 'dig';
      this.rightClickMode = 'legacy';
      // ...which also ends any spray in progress, since the button that was driving
      // it now means "dig" again.
      this.stopChannel('primary');
      this.stopChannel('secondary');
    }

    // B cycles the left mouse button through dig -> bend water -> bend earth ->
    // bend fire -> bend air -> dig. A bender lets go of whatever it holds on its
    // own when it loses the button (bending.js).
    if (Phaser.Input.Keyboard.JustDown(k.b)) {
      this.stopChannel('primary');
      if (this.leftClickMode !== 'bend') {
        this.leftClickMode = 'bend';
        this.bendElement = 'Water';
      } else if (this.bendElement === 'Water') {
        this.bendElement = 'Earth';
      } else if (this.bendElement === 'Earth') {
        this.bendElement = 'Fire';
      } else if (this.bendElement === 'Fire') {
        this.bendElement = 'Air';
      } else {
        this.leftClickMode = 'dig';
      }
    }

    // Esc leaves the world and goes back to the menu.
    if (Phaser.Input.Keyboard.JustDown(k.esc)) { this.returnToMenu(); return; }

    if (Phaser.Input.Keyboard.JustDown(k.r) && !this.multiplayer) {
      this.generateWorld(); // fresh random seed
      this.player.x = (COLS / 2) * PIXEL;
      this.player.y = 2 * PIXEL;
      this.player.vx = 0;
      this.player.vy = 0;
    }
  }

  // ---------- concentric spell wheel ----------

  updateSpellWheel() {
    if (this.player.dead) return;
    const k = this.keys;

    // Q always opens "the wheel for whatever you're about to do": the primary
    // spell wheel normally, or the bend-form picker while a bend is selected.
    // E stays spell-only — bending has no secondary slot to configure.
    if (Phaser.Input.Keyboard.JustDown(k.q)) {
      if (this.leftClickMode === 'bend') this.openBendWheel(); else this.openWheel('primary');
    }
    if (Phaser.Input.Keyboard.JustDown(k.e)) this.openWheel('secondary');

    if (this.wheelOpen) {
      const selection = this.wheelSelections[this.wheelSlot];
      const p = this.input.activePointer;
      const cx = SCREEN_WIDTH / 2, cy = SCREEN_HEIGHT / 2;
      const dx = p.x - cx, dy = p.y - cy;
      const dist = Math.hypot(dx, dy);

      let ringDef = null;
      for (const r of WHEEL_RINGS) {
        if (dist >= r.rMin && dist <= r.rMax) { ringDef = r; break; }
      }
      const ring = ringDef ? ringDef.key : null;
      this.wheelHoverRing = ring;

      if (ringDef) {
        let a = Math.atan2(dy, dx);
        if (a < 0) a += Math.PI * 2;
        const idx = Math.min(ringDef.segments - 1, Math.floor(a / ringDef.segAngle));
        selection[ring] = idx;
      }

      const selElement = WHEEL_ELEMENTS[selection.element];
      const selForm = WHEEL_FORMS[selection.form];
      const selMod = WHEEL_MODIFIERS[selection.modifier];
      // Naming the signature here is what makes 384 combinations legible — you can
      // see that you have landed on "Wildfire" rather than just "Fire + Bolt + Chain".
      const ability = Spells.abilityName(selElement, selForm, selMod);
      this.wheelPreviewText.setText(
        `${this.wheelSlot.toUpperCase()}: ${selElement} + ${selForm} + ${selMod}`
        + (ability ? `  [${ability}]` : '')
      );
      this.drawSpellWheel();

      const releaseKey = this.wheelSlot === 'primary' ? k.q : k.e;
      if (Phaser.Input.Keyboard.JustUp(releaseKey)) this.closeWheel();
    }
  }

  openWheel(slot) {
    if (this.wheelOpen) return; // one wheel at a time — ignore the other key while assembling
    this.wheelOpen = true;
    this.wheelSlot = slot;
    this.wheelPreviewText.setVisible(true);
  }

  closeWheel() {
    const slot = this.wheelSlot;
    const selection = this.wheelSelections[slot];
    this.wheelOpen = false;
    this.wheelSlot = null;
    this.wheelHoverRing = null;
    this.wheelGfx.clear();
    this.wheelPreviewText.setVisible(false);

    const combo = {
      element: WHEEL_ELEMENTS[selection.element],
      form: WHEEL_FORMS[selection.form],
      modifier: WHEEL_MODIFIERS[selection.modifier],
    };
    this.spellCombos[slot] = combo;
    if (slot === 'primary') this.leftClickMode = 'primary';
    else this.rightClickMode = 'secondary';
    console.log(`${slot} spell assembled: ${combo.element} + ${combo.form} + ${combo.modifier}`);
  }

  // ---------- bending's Form picker ----------
  //
  // A single-ring version of the spell wheel above: hold Q, drag to browse,
  // release Q to lock in. It picks a Form for whichever element is currently
  // bending (this.bendElement) rather than a combo for a primary/secondary
  // slot, so it deliberately doesn't reuse WHEEL_RINGS/drawSpellWheel's data
  // shape — that shape assumes three rings and two slots, neither of which
  // apply here. Revisit once bending grows Modifiers too.

  openBendWheel() {
    if (this.bendWheelOpen) return;
    this.bendWheelOpen = true;
    this.bendFormSel = Math.max(0, BEND_FORMS.indexOf(this.bendStyle[this.bendElement]));
  }

  closeBendWheel() {
    this.bendWheelOpen = false;
    this.wheelGfx.clear();
    this.wheelPreviewText.setVisible(false);
    const form = BEND_FORMS[this.bendFormSel];
    this.bendStyle[this.bendElement] = form;
    this.benders[this.bendElement].form = form;
  }

  updateBendWheel() {
    if (!this.bendWheelOpen) return;
    const k = this.keys;
    const p = this.input.activePointer;
    const cx = SCREEN_WIDTH / 2, cy = SCREEN_HEIGHT / 2;
    const dx = p.x - cx, dy = p.y - cy;
    const dist = Math.hypot(dx, dy);
    if (dist >= BEND_FORM_RING.rMin && dist <= BEND_FORM_RING.rMax) {
      let a = Math.atan2(dy, dx);
      if (a < 0) a += Math.PI * 2;
      const segAngle = (Math.PI * 2) / BEND_FORMS.length;
      this.bendFormSel = Math.min(BEND_FORMS.length - 1, Math.floor(a / segAngle));
    }
    this.drawBendWheel();
    if (Phaser.Input.Keyboard.JustUp(k.q)) this.closeBendWheel();
  }

  drawBendWheel() {
    const gfx = this.wheelGfx;
    gfx.clear();
    const cx = SCREEN_WIDTH / 2, cy = SCREEN_HEIGHT / 2;
    const segAngle = (Math.PI * 2) / BEND_FORMS.length;
    const rMid = (BEND_FORM_RING.rMin + BEND_FORM_RING.rMax) / 2;
    for (let i = 0; i < BEND_FORMS.length; i++) {
      const start = i * segAngle, end = start + segAngle;
      const isSelected = i === this.bendFormSel;
      gfx.fillStyle(BEND_FORM_RING.baseColor, isSelected ? 0.95 : 0.4);
      gfx.beginPath();
      gfx.arc(cx, cy, BEND_FORM_RING.rMax, start, end, false);
      gfx.arc(cx, cy, BEND_FORM_RING.rMin, end, start, true);
      gfx.closePath();
      gfx.fillPath();
      gfx.lineStyle(1, 0x000000, 0.35);
      gfx.strokePath();

      const mid = start + segAngle / 2;
      const ix = cx + Math.cos(mid) * rMid, iy = cy + Math.sin(mid) * rMid;
      this.drawWheelIcon(gfx, BEND_FORMS[i], ix, iy, isSelected ? 12 : 9, 0xffffff, isSelected ? 1 : 0.7);
    }
    gfx.fillStyle(0xffffff, 0.85);
    gfx.fillCircle(cx, cy, 4);
    this.wheelPreviewText.setVisible(true);
    this.wheelPreviewText.setText(`BEND FORM (${this.bendElement}): ${BEND_FORMS[this.bendFormSel]}`);
  }

  drawSpellWheel() {
    const gfx = this.wheelGfx;
    gfx.clear();
    const cx = SCREEN_WIDTH / 2, cy = SCREEN_HEIGHT / 2;
    const selection = this.wheelSelections[this.wheelSlot];

    for (const ring of WHEEL_RINGS) {
      const selectedIdx = selection[ring.key];
      const isActiveRing = this.wheelHoverRing === ring.key;
      const rMid = (ring.rMin + ring.rMax) / 2;
      for (let i = 0; i < ring.segments; i++) {
        const start = i * ring.segAngle;
        const end = start + ring.segAngle;
        const isSelected = i === selectedIdx;
        const color = ring.key === 'element' ? WHEEL_ELEMENT_COLORS[i] : ring.baseColor;
        let alpha = 0.25;
        if (isSelected && isActiveRing) alpha = 0.95;
        else if (isSelected) alpha = 0.65;

        gfx.fillStyle(color, alpha);
        gfx.beginPath();
        gfx.arc(cx, cy, ring.rMax, start, end, false);
        gfx.arc(cx, cy, ring.rMin, end, start, true);
        gfx.closePath();
        gfx.fillPath();
        gfx.lineStyle(1, 0x000000, 0.35);
        gfx.strokePath();

        const mid = start + ring.segAngle / 2;
        const ix = cx + Math.cos(mid) * rMid;
        const iy = cy + Math.sin(mid) * rMid;
        const iconSize = isSelected ? 10 : 8;
        const iconAlpha = isSelected ? 1 : 0.7;
        this.drawWheelIcon(gfx, ring.names[i], ix, iy, iconSize, 0xffffff, iconAlpha);
      }
    }

    gfx.fillStyle(0xffffff, 0.85);
    gfx.fillCircle(cx, cy, 4);
  }

  // Vector glyphs for the wheel wedges — rune-like symbols instead of text names,
  // so casting reads by shape/muscle-memory rather than by reading labels.
  // Vector glyphs for the wheel wedges — rune-like symbols instead of text names, so
  // casting reads by shape rather than by reading labels.
  //
  // The first version of this drew almost everything as a stroked outline of similar
  // size, which made elements genuinely hard to tell apart: Water and Earth were the
  // SAME triangle (Earth just added a midline) and Fire was that triangle mirrored.
  // The fix is to give each element a distinct FILL STATE, not merely a distinct
  // outline, so it stays legible at the 8px size used by unselected wedges.
  drawWheelIcon(gfx, name, cx, cy, s, color, alpha) {
    gfx.lineStyle(2, color, alpha);
    gfx.fillStyle(color, alpha);

    switch (name) {
      // -- elements: one solid silhouette each, no two sharing a shape --
      case 'Fire':
        // Solid upright flame.
        gfx.fillTriangle(cx, cy - s, cx - s * 0.8, cy + s * 0.75, cx + s * 0.8, cy + s * 0.75);
        break;
      case 'Water':
        // Tall narrow droplet with a wide notch — deliberately elongated so it does
        // not read as the same blob as Fire's broad triangle.
        gfx.fillTriangle(cx - s * 0.62, cy - s * 0.85, cx + s * 0.62, cy - s * 0.85, cx, cy + s);
        gfx.fillStyle(0x000000, alpha * 0.9);
        gfx.fillRect(cx - s, cy - s * 0.1, s * 2, s * 0.42);
        break;
      case 'Earth':
        // Solid block with a wide horizon gap: unambiguously not a triangle, and the
        // gap keeps it from reading as Dark's disc.
        gfx.fillRect(cx - s * 0.85, cy - s * 0.8, s * 1.7, s * 1.6);
        gfx.fillStyle(0x000000, alpha * 0.9);
        gfx.fillRect(cx - s, cy + s * 0.05, s * 2, s * 0.4);
        break;
      case 'Air':
        // Three stacked wind lines, the shortest on top — a breeze, not a solid
        // shape, which is the one thing every other element icon here is.
        gfx.lineStyle(2.5, color, alpha);
        for (let i = 0; i < 3; i++) {
          const yy = cy - s * 0.55 + i * s * 0.55;
          const len = s * (0.5 + i * 0.28);
          gfx.beginPath();
          gfx.moveTo(cx - len, yy);
          gfx.lineTo(cx + len * 0.5, yy);
          gfx.arc(cx + len * 0.5, yy + s * 0.14, s * 0.14, -Math.PI / 2, Math.PI / 2, false);
          gfx.strokePath();
        }
        break;
      case 'Lightning':
        // The only variable-width glyph: a bolt that tapers as it falls.
        gfx.lineStyle(3.5, color, alpha);
        gfx.beginPath();
        gfx.moveTo(cx - s * 0.15, cy - s);
        gfx.lineTo(cx + s * 0.35, cy - s * 0.1);
        gfx.lineTo(cx - s * 0.1, cy + s * 0.1);
        gfx.strokePath();
        gfx.lineStyle(1.5, color, alpha);
        gfx.beginPath();
        gfx.moveTo(cx - s * 0.1, cy + s * 0.1);
        gfx.lineTo(cx + s * 0.15, cy + s);
        gfx.strokePath();
        break;
      case 'Dark':
        // A small dense core inside a wide thin aura — the halo is what separates it
        // from Earth's block at a glance.
        gfx.fillCircle(cx, cy, s * 0.5);
        gfx.lineStyle(2, color, alpha * 0.75);
        gfx.strokeCircle(cx, cy, s * 0.98);
        break;
      case 'Arcane':
        // Hollow diamond with a centre point — the one pure-line element glyph.
        gfx.beginPath();
        gfx.moveTo(cx, cy - s);
        gfx.lineTo(cx + s, cy);
        gfx.lineTo(cx, cy + s);
        gfx.lineTo(cx - s, cy);
        gfx.closePath();
        gfx.strokePath();
        gfx.fillCircle(cx, cy, s * 0.18);
        break;

      // -- forms --
      case 'Bolt':
        gfx.beginPath();
        gfx.moveTo(cx, cy + s);
        gfx.lineTo(cx, cy - s * 0.6);
        gfx.strokePath();
        gfx.fillTriangle(cx, cy - s, cx - s * 0.4, cy - s * 0.3, cx + s * 0.4, cy - s * 0.3);
        break;
      case 'Nova':
        for (let a = 0; a < Math.PI; a += Math.PI / 3) {
          gfx.beginPath();
          gfx.moveTo(cx - Math.cos(a) * s, cy - Math.sin(a) * s);
          gfx.lineTo(cx + Math.cos(a) * s, cy + Math.sin(a) * s);
          gfx.strokePath();
        }
        break;
      case 'Beam':
        gfx.lineStyle(3, color, alpha);
        gfx.beginPath();
        gfx.moveTo(cx - s, cy);
        gfx.lineTo(cx + s, cy);
        gfx.strokePath();
        break;
      case 'Ground':
        gfx.beginPath();
        gfx.moveTo(cx - s, cy + s * 0.3);
        gfx.lineTo(cx - s * 0.3, cy - s * 0.4);
        gfx.lineTo(cx + s * 0.3, cy + s * 0.3);
        gfx.lineTo(cx + s, cy - s * 0.4);
        gfx.strokePath();
        break;
      case 'Orbit':
        gfx.strokeCircle(cx, cy, s * 0.75);
        gfx.fillCircle(cx + s * 0.75, cy, s * 0.22);
        break;
      case 'Trail':
        for (let i = -1; i <= 1; i++) {
          gfx.fillCircle(cx + s * 0.6 * i, cy - s * 0.3 * i, s * 0.16);
        }
        break;
      case 'Mine':
        // A spiked ball, not a diamond — "trap", and no longer a recoloured Arcane.
        gfx.fillCircle(cx, cy, s * 0.42);
        for (let i = 0; i < 8; i++) {
          const a = (i / 8) * Math.PI * 2;
          gfx.beginPath();
          gfx.moveTo(cx + Math.cos(a) * s * 0.5, cy + Math.sin(a) * s * 0.5);
          gfx.lineTo(cx + Math.cos(a) * s * 0.98, cy + Math.sin(a) * s * 0.98);
          gfx.strokePath();
        }
        break;
      case 'Homing':
        // A dot held in curved brackets — the only glyph with arcs.
        gfx.fillCircle(cx, cy, s * 0.28);
        gfx.beginPath();
        gfx.arc(cx, cy, s * 0.85, Math.PI * 0.65, Math.PI * 1.35, false);
        gfx.strokePath();
        gfx.beginPath();
        gfx.arc(cx, cy, s * 0.85, Math.PI * 1.65, Math.PI * 0.35, false);
        gfx.strokePath();
        break;

      // -- modifiers --
      case 'Chain':
        gfx.strokeCircle(cx - s * 0.4, cy, s * 0.5);
        gfx.strokeCircle(cx + s * 0.4, cy, s * 0.5);
        break;
      case 'Split':
        gfx.beginPath();
        gfx.moveTo(cx, cy + s);
        gfx.lineTo(cx, cy);
        gfx.lineTo(cx - s * 0.8, cy - s);
        gfx.moveTo(cx, cy);
        gfx.lineTo(cx + s * 0.8, cy - s);
        gfx.strokePath();
        break;
      case 'Pierce':
        // A bolt punched through a slab. Deliberately has no long horizontal shaft,
        // which was what made it read as a near-copy of Beam.
        gfx.fillRect(cx - s * 0.22, cy - s * 0.85, s * 0.44, s * 1.7);
        gfx.lineStyle(2.5, color, alpha);
        gfx.beginPath();
        gfx.moveTo(cx - s * 0.95, cy - s * 0.55);
        gfx.lineTo(cx + s * 0.3, cy - s * 0.1);
        gfx.strokePath();
        gfx.fillTriangle(
          cx + s * 0.8, cy,
          cx + s * 0.2, cy - s * 0.42,
          cx + s * 0.36, cy + s * 0.28,
        );
        break;
      case 'Delay':
        // An hourglass, which is both unmistakable and semantically exact. It used to
        // share a radius with Dark's circle, making the two read as near-duplicates.
        gfx.fillTriangle(cx - s * 0.65, cy - s * 0.85, cx + s * 0.65, cy - s * 0.85, cx, cy);
        gfx.beginPath();
        gfx.moveTo(cx - s * 0.65, cy + s * 0.85);
        gfx.lineTo(cx + s * 0.65, cy + s * 0.85);
        gfx.lineTo(cx, cy);
        gfx.closePath();
        gfx.strokePath();
        break;
      case 'Volatile': {
        // A core with scattered fragments around it, not a symmetric star — a star is
        // what Nova already is, and the two were reading as the same glyph. This also
        // says "unpredictable secondary bursts" rather better than a tidy polygon.
        gfx.fillCircle(cx, cy, s * 0.3);
        const frag = [
          [-0.85, -0.7, 0.2], [0.8, -0.85, 0.16], [0.95, 0.35, 0.22],
          [-0.7, 0.75, 0.17], [0.15, 0.95, 0.14], [-0.95, 0.05, 0.13],
        ];
        for (const [fx, fy, fr] of frag) {
          gfx.fillCircle(cx + fx * s, cy + fy * s, fr * s);
        }
        break;
      }
      case 'Absorb':
        // Four arrows converging inward — makes Drought and Implosion self-describing,
        // and no longer collides with the circle-family glyphs.
        for (let i = 0; i < 4; i++) {
          const a = (i / 4) * Math.PI * 2 + Math.PI / 4;
          const ux = Math.cos(a), uy = Math.sin(a);
          gfx.beginPath();
          gfx.moveTo(cx + ux * s, cy + uy * s);
          gfx.lineTo(cx + ux * s * 0.3, cy + uy * s * 0.3);
          gfx.strokePath();
          gfx.fillTriangle(
            cx + ux * s * 0.15, cy + uy * s * 0.15,
            cx + ux * s * 0.62 - uy * s * 0.26, cy + uy * s * 0.62 + ux * s * 0.26,
            cx + ux * s * 0.62 + uy * s * 0.26, cy + uy * s * 0.62 - ux * s * 0.26,
          );
        }
        break;
      case 'Amplify':
        gfx.beginPath();
        gfx.moveTo(cx - s * 0.7, cy + s * 0.15);
        gfx.lineTo(cx, cy - s * 0.55);
        gfx.lineTo(cx + s * 0.7, cy + s * 0.15);
        gfx.moveTo(cx - s * 0.7, cy + s);
        gfx.lineTo(cx, cy + s * 0.3);
        gfx.lineTo(cx + s * 0.7, cy + s);
        gfx.strokePath();
        break;
      case 'Anchor':
        // Simplified from seven sub-paths, which turned to mush at this size.
        gfx.lineStyle(2.5, color, alpha);
        gfx.beginPath();
        gfx.moveTo(cx - s * 0.6, cy - s * 0.7);
        gfx.lineTo(cx + s * 0.6, cy - s * 0.7);
        gfx.moveTo(cx, cy - s * 0.7);
        gfx.lineTo(cx, cy + s * 0.55);
        gfx.strokePath();
        gfx.beginPath();
        gfx.arc(cx, cy + s * 0.2, s * 0.62, 0, Math.PI, false);
        gfx.strokePath();
        break;

      default:
        // Loud rather than invisible: before this existed, any name missing from the
        // switch silently drew an empty wedge with no hint as to why.
        gfx.strokeRect(cx - s * 0.8, cy - s * 0.8, s * 1.6, s * 1.6);
        gfx.beginPath();
        gfx.moveTo(cx - s * 0.8, cy - s * 0.8);
        gfx.lineTo(cx + s * 0.8, cy + s * 0.8);
        gfx.strokePath();
        break;
    }
  }

  // ---------- rendering ----------

  updateCamera() {
    const cam = this.cameras.main;
    const p = this.player;
    const targetX = p.x + p.w / 2 - cam.width / 2;
    const targetY = p.y + p.h / 2 - cam.height / 2;
    cam.scrollX = Phaser.Math.Clamp(targetX, 0, Math.max(0, WORLD_WIDTH - cam.width));
    cam.scrollY = Phaser.Math.Clamp(targetY, 0, Math.max(0, WORLD_HEIGHT - cam.height));
  }

  renderGrid() {
    const cam = this.cameras.main;
    const vw = this.viewCols, vh = this.viewRows;
    const viewGX = Math.max(0, Math.min(Math.floor(cam.scrollX / PIXEL), COLS - vw));
    const viewGY = Math.max(0, Math.min(Math.floor(cam.scrollY / PIXEL), ROWS - vh));

    const data = this.imageData.data;
    const g = this.grid, l = this.life, bgc = this.backdrop;
    const now = this.time.now;
    const sparkleTick = Math.floor(now / 140);
    for (let vy = 0; vy < vh; vy++) {
      const gy = viewGY + vy;
      for (let vx = 0; vx < vw; vx++) {
        const gx = viewGX + vx;
        const i = this.idx(gx, gy);
        const m = g[i];
        let r, gg, b;
        if (m === EMPTY) {
          r = bgc[i * 3];
          gg = bgc[i * 3 + 1];
          b = bgc[i * 3 + 2];
        } else if (m === FIRE) {
          const t = l[i] / FIRE_LIFE;
          r = 255;
          gg = 60 + 180 * t;
          b = 20 * t;
        } else if (m === LAVA) {
          const flick = 0.75 + 0.25 * Math.sin(now / 180 + (i % 17));
          r = 255;
          gg = 40 + 70 * flick;
          b = 10 * flick;
        } else {
          // `life` picks the palette variant for generated materials (planks, brick
          // courses, leaf shades); single-colour materials ignore it
          const pal = PALETTE[m];
          const c = pal.length > 1 ? pal[l[i] % pal.length] : pal[0];
          const shade = ((i * 2654435761) >>> 24) % 3;
          const off = (shade - 1) * 9;
          r = c[0] + off;
          gg = c[1] + off;
          b = c[2] + off;
          if (m === GLASS) {
            // see-through: mix with whatever's behind
            r = r * 0.55 + bgc[i * 3] * 0.45;
            gg = gg * 0.55 + bgc[i * 3 + 1] * 0.45;
            b = b * 0.55 + bgc[i * 3 + 2] * 0.45;
          } else if (m === GOLD && ((((i + sparkleTick * 7919) * 2654435761) >>> 0) % 97) === 0) {
            r = 255; gg = 250; b = 220;
          }

          // Scorched ground stays visibly changed — a persistent map rather than a
          // material, so it costs one array lookup and no simulation rules. This is
          // the only evidence Inferno Core leaves, so it has to be readable.
          const sc = this.scorch[i];
          if (sc > 0) {
            const t = Math.min(sc / 255, 1);
            r = (r + 90 * t) | 0;
            gg = (gg * (1 - t * 0.55)) | 0;
            b = (b * (1 - t * 0.75)) | 0;
          }
        }
        const o = (vy * vw + vx) * 4;
        data[o] = r;
        data[o + 1] = gg;
        data[o + 2] = b;
        data[o + 3] = 255;
      }
    }
    this.worldTexture.context.putImageData(this.imageData, 0, 0);
    this.worldTexture.refresh();
    this.worldImage.setPosition(viewGX * PIXEL, viewGY * PIXEL);
  }

  liquidTint(liquid) {
    if (liquid === 'lava') return [0xff6600, 0.75];
    if (liquid === 'acid') return [0x99ff33, 0.75];
    if (liquid === 'water') return [0xbfe4ff, 0.7];
    if (liquid === 'oil') return [0x6b5540, 0.8];
    return null;
  }

  // The colour the caster's robe is dyed. In multiplayer that is the identity the
  // server handed out; solo it is the old neutral white, so the character you have
  // been playing does not change colour just because it grew a body.
  playerTint() {
    return this.multiplayer ? this.netColor : 0xf0f0f0;
  }

  // What the casting hand glows with: whatever spell is actually about to come out
  // of it. Falls back to the primary combo so the hand is lit even between casts.
  castGlow() {
    const ch = this.channels.primary || this.channels.secondary;
    const element = ch ? ch.element
      : (this.castGlowElement || (this.spellCombos.primary && this.spellCombos.primary.element));
    const pal = element && FX_PALETTE[element];
    return pal ? pal.core : 0xffe9a8;
  }

  // Builds the palette for one body: base colours, then the liquid it is standing in,
  // then the white flash of being hit. Order matters — a burning player submerged in
  // water should still flash white when struck.
  bodyPalette(base, liquid, flashing) {
    let pal = base;
    const tint = this.liquidTint(liquid);
    if (tint) pal = Sprites.tintPalette(pal, tint[0], 0.5);
    if (flashing) pal = Sprites.tintPalette(pal, 0xff5a5a, 0.72);
    return pal;
  }

  drawCorpseFlames(g, x, y, w, h, rotation) {
    const t = this.time.now * 0.012;
    const cx = x + w / 2, cy = y + h / 2;
    const cs = Math.cos(rotation || 0), sn = Math.sin(rotation || 0);
    for (let i = 0; i < 3; i++) {
      const lx = (i - 1) * 5;
      const flicker = (Math.sin(t + i * 2.1) + 1) * 1.8;
      const ly = -h * 0.35 - flicker;
      const fx = cx + lx * cs - ly * sn;
      const fy = cy + lx * sn + ly * cs;
      g.fillStyle(i === 1 ? 0xffdd66 : 0xff7626, 0.95);
      g.fillRect(Math.round(fx - 1), Math.round(fy - 4 - flicker), 3, 5 + flicker);
      g.fillStyle(0xffefad, 0.9);
      g.fillRect(Math.round(fx), Math.round(fy - 2 - flicker), 1, 3 + flicker);
    }
  }

  drawPlayer(dt) {
    const p = this.player;
    const g = this.playerGfx;
    g.clear();

    const flashing = !!(this.hitFlashUntil && this.time.now < this.hitFlashUntil);
    const casting = !p.dead && (!!(this.channels.primary || this.channels.secondary)
      || this.time.now < (this.castAnimUntil || 0));
    const clip = Sprites.playerClip({
      dead: p.dead, hurt: flashing, casting, liquid: p.liquid,
      grounded: p.grounded, vx: p.vx, vy: p.vy,
    });
    // The run cycle is driven by how fast the legs are actually moving, so wading
    // through water does not look like sprinting on dry ground.
    const speedMul = clip === 'run' ? Math.abs(p.vx) / 90 : 1;
    const frame = Sprites.advanceAnim(this.playerAnim, clip, dt, speedMul);

    const tint = this.liquidTint(p.liquid);
    let pal = this.bodyPalette(
      Sprites.robePalette(this.playerTint(), this.castGlow()),
      p.liquid, flashing,
    );
    if (p.dead) pal = Sprites.tintPalette(pal, p.burning ? 0x6a3826 : 0x40383a, 0.7);
    Sprites.drawSprite(g, frame, p.x, p.y, pal, {
      facing: p.facing,
      alpha: tint ? tint[1] : 1,
      rotation: p.dead ? p.rotation : 0,
    });
    if (p.dead && p.burning) this.drawCorpseFlames(g, p.x, p.y, p.w, p.h, p.rotation);
    if (p.burning && Math.random() < dt * 18) {
      const fxX = p.x + Math.random() * p.w;
      this.fx.burst(fxX, p.y + 5, 2, 'Fire', { speed: 28, life: 0.35, rise: 62, size: 1.6 });
    }
  }

  drawRemotePlayers(dt) {
    this.remoteGfx.clear();
    for (const id in this.remotePlayers) {
      if (id === this.netId) continue;
      const rp = this.remotePlayers[id];
      if (!this.remoteRender[id]) this.remoteRender[id] = {
        x: rp.x, y: rp.y, vx: 0, vy: 0, rotation: rp.rotation || 0, anim: {},
      };
      const rr = this.remoteRender[id];
      const px = rr.x, py = rr.y;
      rr.x += (rp.x - rr.x) * 0.35;
      rr.y += (rp.y - rr.y) * 0.35;
      if (Number.isFinite(rp.rotation)) {
        const deltaRotation = ((rp.rotation - rr.rotation + Math.PI) % (Math.PI * 2) + Math.PI * 2) % (Math.PI * 2) - Math.PI;
        rr.rotation += deltaRotation * Math.min(1, dt * 10);
      }

      // Remote bodies animate off their interpolated motion. The network carries no
      // velocity or grounded flag, and adding them would cost bandwidth to tell us
      // something the positions already say: if it is moving sideways it is running,
      // if it is moving vertically at speed it is in the air.
      if (dt > 0) {
        rr.vx = (rr.x - px) / dt;
        rr.vy = (rr.y - py) / dt;
      }
      const airborne = Math.abs(rr.vy) > 45;
      const clip = Sprites.playerClip({
        dead: !!rp.dead, liquid: rp.liquid, grounded: !airborne, vx: rr.vx, vy: rr.vy,
      });
      const frame = Sprites.advanceAnim(rr.anim, clip, dt,
        clip === 'run' ? Math.abs(rr.vx) / 90 : 1);

      const tint = this.liquidTint(rp.liquid);
      let pal = this.bodyPalette(Sprites.robePalette(rp.color), rp.liquid, false);
      if (rp.dead) pal = Sprites.tintPalette(pal, rp.burning ? 0x6a3826 : 0x40383a, 0.7);
      Sprites.drawSprite(this.remoteGfx, frame, rr.x, rr.y, pal, {
        facing: rp.facing || 1,
        alpha: tint ? tint[1] : 1,
        rotation: rp.dead ? rr.rotation : 0,
      });
      if (rp.dead && rp.burning) this.drawCorpseFlames(this.remoteGfx, rr.x, rr.y, PLAYER_BOX.w, PLAYER_BOX.h, rr.rotation);
      if (rp.burning && Math.random() < dt * 18) {
        const fxX = rr.x + Math.random() * PLAYER_BOX.w;
        this.fx.burst(fxX, rr.y + 5, 2, 'Fire', { speed: 28, life: 0.35, rise: 62, size: 1.6 });
      }

      // A health pip above each other player, as wide as they are. Without it,
      // hitting someone gives no feedback at all and PvP is guesswork.
      if (typeof rp.health === 'number' && rp.health < 100) {
        const frac = Math.max(0, Math.min(1, rp.health / 100));
        const bw = PLAYER_BOX.w + 2;
        const by = Math.round(rr.y) - 4 - CHAR_SCALE;
        this.remoteGfx.fillStyle(0x330000, 0.85);
        this.remoteGfx.fillRect(Math.round(rr.x) - 1, by, bw, 3);
        this.remoteGfx.fillStyle(frac > 0.5 ? 0x4ad84a : frac > 0.25 ? 0xdcc832 : 0xdc3232, 1);
        this.remoteGfx.fillRect(Math.round(rr.x) - 1, by, bw * frac, 3);
      }
    }
    for (const id in this.remoteRender) {
      if (!(id in this.remotePlayers)) delete this.remoteRender[id];
    }
  }

  // ---------- networking ----------

  connectMultiplayer() {
    if (this.initSocket) {
      // Already in a room: the server's `joined` payload came with the handoff, so
      // apply it directly instead of waiting for a round trip.
      this.adoptSocket(this.initSocket);
      this.initSocket = null;
      if (this.prejoined) {
        this.handleNetMessage(this.prejoined);
        this.prejoined = null;
      }
      return;
    }

    let socket;
    try {
      const proto = location.protocol === 'https:' ? 'wss' : 'ws';
      socket = new WebSocket(`${proto}://${location.hostname}:8080`);
    } catch (e) {
      return;
    }
    this.adoptSocket(socket);
    // A fresh connection starts in the lobby, so it has to ask to be put in a room.
    socket.onopen = () => {
      if (this.roomId) socket.send(JSON.stringify({ t: 'join', roomId: this.roomId }));
    };
  }

  adoptSocket(socket) {
    this.socket = socket;
    socket.onmessage = (ev) => {
      let msg;
      try { msg = JSON.parse(ev.data); } catch (e) { return; }
      this.handleNetMessage(msg);
    };
    socket.onclose = () => {
      if (this.multiplayer) this.remotePlayers = {};
      this.multiplayer = false;
      // A server that never answered (or went away) should not leave the player
      // staring at a frozen world — fall back to simulating locally.
      this.awaitingServer = false;
    };
    socket.onerror = () => { this.awaitingServer = false; };
  }

  handleNetMessage(msg) {
    if (msg.t === 'joined') {
      this.netId = msg.id;
      this.netColor = msg.color;
      if (msg.roomId) this.roomId = msg.roomId;
      if (msg.roomName) this.roomName = msg.roomName;
      this.grid.set(base64ToBytes(msg.grid));
      this.life.set(base64ToBytes(msg.life));
      if (msg.bg) this.world.bg.set(base64ToBytes(msg.bg));
      this.buildBackdrop();
      this.remotePlayers = msg.players || {};
      this.multiplayer = true;
      this.awaitingServer = false;
    } else if (msg.t === 'error') {
      // Most likely the room filled or was reaped between listing and joining.
      this.netError = String(msg.message || 'Server refused the request.');
      this.awaitingServer = false;
    } else if (msg.t === 'rooms') {
      // Lobby chatter that arrived after we joined; ignore it.
    } else if (msg.t === 'delta') {
      for (const [id, mat, life] of msg.cells) {
        this.grid[id] = mat;
        this.life[id] = life;
      }
    } else if (msg.t === 'players') {
      this.remotePlayers = msg.players;
    } else if (msg.t === 'cast') {
      // Never replay our own cast. We already rendered it locally, so this would
      // draw a second copy of the spell next to the real one — and because replay
      // projectiles are visuals only, that copy would fly along and then fizzle
      // without ever detonating.
      if (msg.id === this.netId) return;
      this.replayRemoteCast(msg);
    } else if (msg.t === 'hit') {
      // Sent to us specifically: another player's spell caught us.
      this.receiveHit(msg);
    } else if (msg.t === 'blastImpulse') {
      this.receiveBlastImpulse(msg);
    } else if (msg.t === 'leave') {
      delete this.remotePlayers[msg.id];
      if (this.remoteFallImpactAt) this.remoteFallImpactAt.delete(`remote:${msg.id}`);
    }
  }

  sendNet(obj) {
    if (!this.multiplayer || !this.socket || this.socket.readyState !== WebSocket.OPEN) return;

    // Terrain operations are no longer sent in multiplayer. Every one of them ended
    // in setCell() anyway, and setCell now forwards the exact resulting cells, so an
    // op would only make the server recompute — with different randomness — the very
    // thing the caster already decided. Dropping them here keeps a single source of
    // truth for what the world looks like.
    if (obj.t === 'dig' || obj.t === 'place' || obj.t === 'explode'
      || obj.t === 'douse' || obj.t === 'shock' || obj.t === 'settle') {
      return;
    }
    this.socket.send(JSON.stringify(obj));
  }

  sendPositionUpdate(delta) {
    this.netSendTimer -= delta;
    if (this.netSendTimer > 0) return;
    this.netSendTimer = 50;
    const p = this.player;
    this.sendNet({
      t: 'input', x: p.x, y: p.y, facing: p.facing, liquid: p.liquid,
      health: Math.round(p.health), dead: p.dead, burning: p.burning, rotation: p.rotation,
    });
  }

  update(time, delta) {
    if (this.player.dead && time >= this.player.respawnAt) this.respawnPlayer();
    // Hitstop. When something big lands, fx.hitstop() sets this and the whole world
    // hesitates for a beat — simulation, player, projectiles and particles together.
    // Phaser's own clock is deliberately NOT scaled, so every delayedCall a spell
    // scheduled still fires on schedule and a freeze can never strand a pending
    // detonation. Network sends stay on real time for the same reason.
    let scale = 1;
    if (this.hitstopUntil) {
      if (time < this.hitstopUntil) scale = 0.12;
      else this.hitstopUntil = 0;
    }
    const scaled = Math.min(delta, 33) * scale;
    const dt = scaled / 1000;

    this.handleSpellKeys();
    // Status ticks before movement so a slow applied this frame is felt this frame,
    // and so a curse can kill you before you get to act.
    this.updateStatus(dt);
    this.movePlayer(dt);
    this.applyEnvironmentDamage(dt);
    Spells.wade(this, dt);
    this.updateCamera();

    if (!this.multiplayer && !this.awaitingServer) {
      this.accumulator += scaled;
      while (this.accumulator >= this.SIM_STEP) {
        this.simulate();
        this.accumulator -= this.SIM_STEP;
      }
      this.collapseTimer -= scaled;
      if (this.collapseTimer <= 0) {
        this.collapseTimer = 120;
        this.checkStructuralSupport();
      }
    }

    this.updateSpellWheel();
    this.updateBendWheel();
    this.handlePointer();
    // Every bender updates, not just the selected one: water, rock and embers
    // already let go are still in the air and have to land.
    for (const k in this.benders) this.benders[k].update(dt);
    // Channels tick after handlePointer, so a spray started this frame sprays this
    // frame rather than waiting one.
    this.updateChannels(dt);
    this.updateProjectiles(dt);
    this.updateDebris(dt);
    this.updateOrbitSpells(dt);
    this.updateWaves(dt);
    this.updateMines(dt);
    this.updateFields(dt);
    this.enemies.update(dt);
    this.fx.update(dt);
    this.flushCellChanges();
    this.sendPositionUpdate(delta);

    this.renderGrid();
    this.drawFields();
    this.drawPlayer(dt);
    this.drawRemotePlayers(dt);
    this.drawProjectiles();
    this.drawDebris();
    for (const k in this.benders) this.benders[k].draw();
    this.drawOrbitSpells();
    this.drawMines();
    this.enemies.draw(dt);
    this.fx.draw();
    this.drawHealthBar();
    this.drawStatusHud();
  }
}

function base64ToBytes(b64) {
  const bin = atob(b64);
  const arr = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) arr[i] = bin.charCodeAt(i);
  return arr;
}

const config = {
  type: Phaser.AUTO,
  parent: 'game-container',
  width: SCREEN_WIDTH,
  height: SCREEN_HEIGHT,
  backgroundColor: '#0a0a0f',
  pixelArt: true,
  scale: {
    mode: Phaser.Scale.FIT,
    autoCenter: Phaser.Scale.CENTER_BOTH,
    width: SCREEN_WIDTH,
    height: SCREEN_HEIGHT,
  },
  // Menu first: the game boots into the front-end, which decides how to start play.
  scene: [MenuScene, SandScene],
};

window.game = new Phaser.Game(config);
