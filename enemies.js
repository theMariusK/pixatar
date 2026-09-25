// AI enemies for campaign mode.
//
// Enemies are bodies in the same world as the player: they fall, they are blocked by
// terrain, and they cast spells. They use the SAME spell pipeline the player does —
// Spells.cast() with themselves as the caster — which means every element and form
// works for them for free, and an enemy's magic is subject to the same rules,
// including catching itself in its own blast.
//
// They do not, however, get the spell wheel. Each archetype has one element and a
// small set of forms, which is what gives enemies a readable identity: the moment a
// fireball comes at you, you know which one threw it.

// One entry per enemy kind. Health, reach and cadence are what make them play
// differently; the element is what makes them LOOK different.
const ENEMY_ARCHETYPES = [
  {
    name: 'Emberling', element: 'Fire', color: 0xff7a45,
    health: 55, speed: 62, aggro: 360, castRange: 240, cooldown: 2.1, spellSpeed: 1.0,
    forms: ['Bolt', 'Bolt', 'Nova'], modifiers: [null, null, 'Chain', 'Split'],
  },
  {
    name: 'Pebbleback', element: 'Earth', color: 0xa8845a,
    health: 110, speed: 38, aggro: 300, castRange: 170, cooldown: 2.8, spellSpeed: 0.8,
    forms: ['Bolt', 'Ground'], modifiers: [null, 'Amplify', 'Split'],
  },
  {
    name: 'Sparkling', element: 'Lightning', color: 0xc9a6ff,
    health: 45, speed: 88, aggro: 400, castRange: 260, cooldown: 1.5, spellSpeed: 0.9,
    forms: ['Bolt', 'Homing'], modifiers: [null, 'Split', 'Pierce'],
  },
  {
    name: 'Tidewisp', element: 'Water', color: 0x63b8ff,
    health: 70, speed: 54, aggro: 320, castRange: 200, cooldown: 2.4, spellSpeed: 0.85,
    forms: ['Bolt', 'Trail'], modifiers: [null, 'Split'],
  },
  {
    name: 'Shade', element: 'Dark', color: 0x9a5ae0,
    health: 65, speed: 70, aggro: 380, castRange: 230, cooldown: 2.6, spellSpeed: 0.95,
    forms: ['Bolt', 'Nova'], modifiers: [null, 'Chain', 'Delay'],
  },
  {
    name: 'Riftling', element: 'Arcane', color: 0x8fe8ff,
    health: 50, speed: 66, aggro: 340, castRange: 250, cooldown: 2.0, spellSpeed: 1.0,
    forms: ['Bolt', 'Beam'], modifiers: [null, 'Pierce', 'Split'],
  },
];

class EnemySystem {
  constructor(scene) {
    this.scene = scene;
    this.list = [];
    // Sits between debris (8) and the player (10): enemies are world objects, but the
    // player should never be hidden behind one.
    this.gfx = scene.add.graphics().setDepth(9);
    this.killCount = 0;
    this.spawnedTotal = 0;
  }

  // ---------- spawning ----------

  // Places an enemy standing on the ground near a column, so they never start buried
  // in terrain or floating in the air.
  spawnNear(column, archetypeIndex) {
    const s = this.scene;
    const arch = ENEMY_ARCHETYPES[archetypeIndex % ENEMY_ARCHETYPES.length];
    const gx = Math.max(4, Math.min(COLS - 5, column));
    const w = ENEMY_BOX.w, h = ENEMY_BOX.h;
    for (let gy = 2; gy < ROWS - 3; gy++) {
      // The first cell with solid ground under it is the surface.
      if (!s.solidAtCell(gx, gy) && s.solidAtCell(gx, gy + 1)) {
        // Stand the body ON the surface and check the whole box is clear. The old
        // placement was a fixed two cells above the surface cell, which buried the
        // bottom third of the creature in the ground and left it unable to step out
        // of terrain it was already inside.
        const ex = gx * PIXEL - w / 2;
        const ey = (gy + 1) * PIXEL - h;
        if (s.rectSolid(ex, ey, w, h)) continue;
        const e = {
          x: ex, y: ey,
          w, h,
          vx: 0, vy: 0,
          grounded: false,
          facing: Math.random() < 0.5 ? -1 : 1,
          health: arch.health, maxHealth: arch.health,
          arch,
          cooldown: arch.cooldown * (0.4 + Math.random() * 0.8),
          state: 'idle',
          wanderTimer: 0,
          hitFlash: 0,
          castFlash: 0,
          spawnGrace: 1.2,
          stuck: 0,
        };
        this.list.push(e);
        this.spawnedTotal++;
        return e;
      }
    }
    return null;
  }

  // Populates a level: enemies scattered across the map at a distance from the
  // player, so nothing is standing on top of you the moment you load in.
  populate(count, level = 1) {
    const s = this.scene;
    const playerCol = Math.floor(s.player.x / PIXEL);
    let placed = 0;
    let guard = 0;
    while (placed < count && guard++ < count * 40) {
      const column = 20 + ((Math.random() * (COLS - 40)) | 0);
      // Keep a wide berth around the spawn point.
      if (Math.abs(column - playerCol) < 55) continue;
      const pick = (level + placed) % ENEMY_ARCHETYPES.length;
      if (this.spawnNear(column, pick)) placed++;
    }
    return placed;
  }

  clear() {
    this.list.length = 0;
    this.killCount = 0;
    this.spawnedTotal = 0;
    if (this.gfx) this.gfx.clear();
  }

  // ---------- damage ----------

  damage(enemy, amount, element) {
    if (!enemy || enemy.dead) return;
    enemy.health -= amount;
    enemy.hitFlash = 0.18;
    // Being hit pulls aggro even from across the map — otherwise you can plink an
    // enemy to death from out of its notice range and it never reacts.
    enemy.state = 'chase';
    enemy.aggroBoost = 6;

    const s = this.scene;
    GameAudio.hurt(element || enemy.arch.element, enemy.x + enemy.w / 2, enemy.y + enemy.h / 2);
    s.fx.burst(enemy.x + enemy.w / 2, enemy.y + enemy.h / 2, 6, element || enemy.arch.element,
      { speed: 70, life: 0.35, size: 1.2 });

    if (enemy.health <= 0) this.kill(enemy);
  }

  kill(enemy) {
    if (enemy.dead) return;
    enemy.dead = true;
    this.killCount++;
    const s = this.scene;
    const cx = enemy.x + enemy.w / 2, cy = enemy.y + enemy.h / 2;
    GameAudio.death(cx, cy);
    s.fx.burst(cx, cy, 26, enemy.arch.element, { speed: 130, life: 0.8, rise: 40, size: 1.6 });
    s.fx.ring(cx, cy, enemy.arch.element, { r0: 2, r1: 34, life: 0.4, width: 2 });
    s.fx.shake(enemy.arch.element, 0.006, 140);
    const at = this.list.indexOf(enemy);
    if (at !== -1) this.list.splice(at, 1);
  }

  // ---------- movement ----------

  // Same collision model the player uses, minus the input handling: gravity, a
  // horizontal step that is cancelled if it would enter terrain, then a vertical one.
  moveBody(e, dt) {
    const s = this.scene;
    const wet = s.time.now < (e.wetUntil || 0);
    e.vy += (wet ? 90 : 500) * dt;
    if (wet) e.vy *= Math.exp(-3 * dt);
    if (e.vy > 420) e.vy = 420;

    const nx = e.x + (e.vx * (wet ? 0.65 : 1) + (e.impulseX || 0)) * dt;
    if (!s.rectSolid(nx, e.y, e.w, e.h)) {
      e.x = nx;
      e.blocked = false;
    } else {
      e.blocked = true;
      e.vx = 0;
      e.impulseX = 0;
    }
    e.impulseX = (e.impulseX || 0) * Math.exp(-3.2 * dt);

    const ny = e.y + e.vy * dt;
    if (!s.rectSolid(e.x, ny, e.w, e.h)) {
      e.y = ny;
      e.grounded = false;
    } else {
      if (e.vy > 0) e.grounded = true;
      e.vy = 0;
    }

    e.x = Phaser.Math.Clamp(e.x, PIXEL, WORLD_WIDTH - PIXEL - e.w);
    e.y = Phaser.Math.Clamp(e.y, PIXEL, WORLD_HEIGHT - PIXEL - e.h);
  }

  // Cheap Bresenham-ish walk of the cells between two world points. Without this,
  // enemies happily cast through solid rock and the fight makes no sense.
  hasLineOfSight(x1, y1, x2, y2) {
    const s = this.scene;
    const steps = Math.ceil(Math.hypot(x2 - x1, y2 - y1) / (PIXEL * 2));
    for (let i = 1; i < steps; i++) {
      const t = i / steps;
      const gx = Math.floor((x1 + (x2 - x1) * t) / PIXEL);
      const gy = Math.floor((y1 + (y2 - y1) * t) / PIXEL);
      if (s.solidAtCell(gx, gy)) return false;
    }
    return true;
  }

  // ---------- AI ----------

  update(dt) {
    const s = this.scene;
    const p = s.player;
    const pcx = p.x + p.w / 2, pcy = p.y + p.h / 2;

    for (let i = this.list.length - 1; i >= 0; i--) {
      const e = this.list[i];
      if (e.dead) { this.list.splice(i, 1); continue; }

      e.hitFlash = Math.max(0, e.hitFlash - dt);
      e.castFlash = Math.max(0, e.castFlash - dt);
      e.spawnGrace = Math.max(0, e.spawnGrace - dt);
      e.aggroBoost = Math.max(0, (e.aggroBoost || 0) - dt);
      if (s.time.now < (e.wetUntil || 0)) e.burnUntil = 0;
      if (s.time.now < (e.burnUntil || 0)) {
        e.health -= 5 * dt;
        if (Math.random() < dt * 15) s.fx.burst(e.x + Math.random() * e.w, e.y + 4,
          2, 'Fire', { speed: 28, life: 0.35, rise: 62, size: 1.3 });
        if (e.health <= 0) { this.kill(e); continue; }
      }
      if (e.cooldown > 0) e.cooldown -= dt;

      const dx = pcx - (e.x + e.w / 2);
      const dy = pcy - (e.y + e.h / 2);
      const dist = Math.hypot(dx, dy);
      const aware = dist < e.arch.aggro || e.aggroBoost > 0;

      if (aware) {
        e.state = 'chase';
        e.facing = dx > 0 ? 1 : -1;

        // Close to about two thirds of casting range, then hold and shoot. Standing
        // still to cast is what makes them readable rather than a swarm.
        const standoff = e.arch.castRange * 0.65;
        if (dist > standoff) {
          e.vx = e.facing * e.arch.speed;
        } else {
          e.vx = 0;
        }

        // Hop when a step is blocked or the target is clearly above — without this
        // they get stuck on every ledge and look broken.
        const wantsUp = dy < -20;
        if (e.grounded && (e.blocked || wantsUp) && Math.random() < 0.12) {
          e.vy = -200;
          e.grounded = false;
        }

        // Line of sight is traced from head height, not body centre. Traced from the
        // centre, a single lump of ground between two entities on uneven terrain
        // blocks the shot, and the fight goes silent for no visible reason — they are
        // standing in the open, after all. Close range overrides the check entirely,
        // because at that distance you can hardly miss.
        const canSee = this.hasLineOfSight(
          e.x + e.w / 2, e.y + 2,
          pcx, p.y + 2,
        ) || dist < 70;
        if (e.cooldown <= 0 && e.spawnGrace <= 0 && dist < e.arch.castRange && canSee) {
          this.castAt(e, pcx, pcy);
        }
      } else {
        // Idle drift, so the world does not look frozen before you are noticed.
        e.state = 'idle';
        e.wanderTimer -= dt;
        if (e.wanderTimer <= 0) {
          e.wanderTimer = 1.5 + Math.random() * 3;
          const roll = Math.random();
          e.vx = roll < 0.35 ? 0 : (roll < 0.67 ? -1 : 1) * e.arch.speed * 0.45;
          if (e.vx !== 0) e.facing = Math.sign(e.vx);
        }
        if (e.grounded && e.blocked && Math.random() < 0.15) e.vy = -190;
      }

      this.moveBody(e, dt);

      // Anything that somehow ends up outside the world is removed rather than left
      // to accumulate as a ghost.
      if (e.y > WORLD_HEIGHT + 40) {
        this.list.splice(i, 1);
      }
    }
  }

  castAt(e, targetX, targetY) {
    const s = this.scene;
    const arch = e.arch;
    const form = arch.forms[(Math.random() * arch.forms.length) | 0];
    const modifier = arch.modifiers[(Math.random() * arch.modifiers.length) | 0];

    // Enemies cast through the same pipeline the player does, with themselves as the
    // caster and an explicit aim point instead of the mouse pointer.
    Spells.cast(s, arch.element, form, modifier, arch.spellSpeed, e, { x: targetX, y: targetY });

    e.cooldown = arch.cooldown * (0.75 + Math.random() * 0.5);
    e.castFlash = 0.25;
    s.fx.burst(e.x + e.w / 2, e.y + e.h / 2, 6, arch.element, { speed: 60, life: 0.35, size: 1.2 });
  }

  // ---------- rendering ----------

  draw(dt = 0) {
    const g = this.gfx;
    g.clear();
    for (const e of this.list) {
      const arch = e.arch;
      const flash = e.hitFlash > 0;

      // Two frames per archetype, cycled faster the faster it moves, so a charging
      // Pebbleback visibly lumbers and an idle one just breathes. Winding up a spell
      // holds the second frame: the creature tenses, then throws.
      const pace = 0.26 / (1 + Math.abs(e.vx) / 44);
      e.animT = ((e.animT || 0) + dt) % pace;
      const frames = Sprites.ENEMY_FRAMES[arch.name] || Sprites.ENEMY_FRAMES.Emberling;
      const frame = e.castFlash > 0 ? frames[1] : frames[(e.animT / pace) < 0.5 ? 0 : 1];

      // The eyes are lit by the element the creature casts, which is the only tell
      // you get at a distance before the first spell leaves its hands.
      const eyePal = FX_PALETTE[arch.element];
      let pal = Sprites.creaturePalette(arch.color, eyePal ? eyePal.core : 0xf6faff);
      if (e.castFlash > 0) pal = Sprites.tintPalette(pal, 0xffffff, Math.min(0.75, e.castFlash * 2.4));
      if (flash) pal = Sprites.tintPalette(pal, 0xffffff, 0.8);

      Sprites.drawSprite(g, frame, e.x, e.y, pal, { facing: e.facing });

      // Charging tell: a bright rim the moment before it casts, so the player has
      // something to react to.
      if (e.castFlash > 0) {
        g.lineStyle(2, 0xffffff, Math.min(1, e.castFlash * 4));
        g.strokeRect(e.x - 2, e.y - 2, e.w + 4, e.h + 4);
      }

      if (e.health < e.maxHealth) {
        const frac = Math.max(0, e.health / e.maxHealth);
        g.fillStyle(0x220008, 0.9);
        g.fillRect(e.x - 2, e.y - 7, e.w + 4, 3);
        g.fillStyle(frac > 0.5 ? 0x5ce65c : frac > 0.25 ? 0xe0c832 : 0xe04040, 1);
        g.fillRect(e.x - 2, e.y - 7, (e.w + 4) * frac, 3);
      }
    }
  }
}
