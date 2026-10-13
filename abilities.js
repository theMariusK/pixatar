// Element-specific RMB abilities. Water and earth spend actual gathered matter;
// their airborne particles and raised terrain keep the normal element collisions.
const BENDING_ABILITY_RULES = {
  Flamethrower: { element: 'Fire', cooldown: 0.65, duration: 2.5 },
  Whip: { element: 'Water', minimum: 6, capacity: 48, cooldown: 0.7 },
  Shield: { element: 'Water', minimum: 8, capacity: 64, cooldown: 0.35, duration: 5 },
  Wall: { element: 'Earth', minimum: 9, capacity: 84, cooldown: 1.1 },
  Spikes: { element: 'Earth', minimum: 12, capacity: 144, cooldown: 1.4 },
  Dash: { element: 'Air', minimum: 8, capacity: 24, cooldown: 1.2 },
  Vortex: { element: 'Air', minimum: 12, capacity: 60, cooldown: 2.5 },
};

class BendingAbilities {
  constructor(scene) {
    this.scene = scene;
    this.gfx = scene.add.graphics().setDepth(8.8);
    this.clear();
  }

  clear() {
    const water = this.scene.benders?.Water;
    if (water) water.free = water.free.filter((drop) => !drop.bendAbility);
    this.cooldowns = new Map();
    this.channel = null;
    this.whip = null;
    this.shield = null;
    this.vortex = null;
    this.dash = null;
    this.structures = [];
    this.hint = '';
    this.hintUntil = 0;
    this.jetAcc = 0;
    if (this.scene.player) this.scene.player.bendDashUntil = 0;
  }

  remaining(name) {
    return Math.max(0, ((this.cooldowns.get(name) || 0) - this.scene.time.now) / 1000);
  }

  feedback(text) {
    this.hint = text;
    this.hintUntil = this.scene.time.now + 1600;
    return false;
  }

  origin() {
    const p = this.scene.player;
    return { x: p.x + p.w / 2 + (p.facing || 1) * p.w * 0.3, y: p.y + p.h * 0.4 };
  }

  cast(name) {
    const s = this.scene, rule = BENDING_ABILITY_RULES[name];
    if (!rule || !bendSelected(s, rule.element) || s.bendAction[rule.element] !== name) return false;
    if (this.remaining(name)) return this.feedback(`${name} is recharging`);
    const bender = s.benders[rule.element];
    if (rule.minimum && bender.holding < rule.minimum) {
      return this.feedback(`Gather ${rule.minimum} ${rule.element.toLowerCase()} first with LMB`);
    }
    this.stopChannel();
    let success;
    switch (name) {
      case 'Flamethrower':
        this.channel = { name, age: 0 };
        this.jetAcc = 1;
        s.emitFireCasterParticles(8);
        success = true;
        break;
      case 'Whip': success = this.startWhip(); break;
      case 'Shield': success = this.startShield(); break;
      case 'Wall': case 'Spikes': success = this.startStructure(name); break;
      case 'Dash': success = this.startDash(); break;
      case 'Vortex': success = this.startVortex(); break;
    }
    if (success && !rule.duration) this.cooldowns.set(name, s.time.now + rule.cooldown * 1000);
    if (success) { this.hint = ''; this.hintUntil = 0; }
    return !!success;
  }

  releaseWater(state) {
    if (!state) return;
    for (const drop of state.drops) {
      if (drop.bendAbility !== state) continue;
      delete drop.bendAbility;
      drop.age = 0;
      drop.vx *= 0.25;
      drop.vy *= 0.25;
    }
  }

  stopChannel() {
    if (!this.channel) return;
    const name = this.channel.name;
    this.cooldowns.set(name, this.scene.time.now + BENDING_ABILITY_RULES[name].cooldown * 1000);
    if (name === 'Shield') { this.releaseWater(this.shield); this.shield = null; }
    this.channel = null;
    this.jetAcc = 0;
  }

  startWhip() {
    const water = this.scene.benders.Water;
    this.releaseWater(this.whip);
    this.whip = { age: 0, duration: 0.6, hits: new Set(),
      drops: water.held.splice(0, BENDING_ABILITY_RULES.Whip.capacity) };
    for (const drop of this.whip.drops) { drop.bendAbility = this.whip; drop.age = 0; water.free.push(drop); }
    this.scene.fx.streaks(this.origin().x, this.origin().y, 8, 'Water',
      { speed: 160, angle: Math.atan2(bendAim(this.scene).y, bendAim(this.scene).x), spread: 0.4, life: 0.3 });
    return true;
  }

  startShield() {
    const water = this.scene.benders.Water;
    this.shield = { drops: water.held.splice(0, BENDING_ABILITY_RULES.Shield.capacity) };
    for (const drop of this.shield.drops) { drop.bendAbility = this.shield; drop.age = 0; water.free.push(drop); }
    this.channel = { name: 'Shield', age: 0 };
    this.scene.fx.ring(this.scene.player.x + this.scene.player.w / 2,
      this.scene.player.y + this.scene.player.h / 2, 'Water', { r0: 18, r1: 36, life: 0.25 });
    return true;
  }

  liveWater(state) {
    const live = new Set(this.scene.benders.Water.free);
    state.drops = state.drops.filter((drop) => live.has(drop) && drop.bendAbility === state);
    return state.drops;
  }

  steerWater(drop, x, y, dt) {
    const water = this.scene.benders.Water;
    const dx = x - drop.x, dy = y - drop.y;
    const speed = Math.hypot(dx, dy) / Math.max(0.001, dt);
    const factor = Math.min(1, 720 / Math.max(1, speed));
    drop.vx = dx / Math.max(0.001, dt) * factor;
    drop.vy = dy / Math.max(0.001, dt) * factor;
    if (water.moveDrop(drop, dt) !== 'consumed') return;
    const index = water.free.indexOf(drop);
    if (index >= 0) water.free.splice(index, 1);
  }

  updateWhip(dt) {
    const whip = this.whip;
    if (!whip) return;
    whip.age += dt;
    const drops = this.liveWater(whip);
    if (whip.age >= whip.duration || !drops.length || this.scene.player.dead) {
      this.releaseWater(whip); this.whip = null; return;
    }
    const origin = this.origin(), aim = bendAim(this.scene);
    const progress = whip.age / whip.duration;
    const reach = Math.min(190, 85 + Math.sqrt(drops.length) * 13) * Math.sin(progress * Math.PI);
    for (let i = 0; i < drops.length; i++) {
      const t = (i + 1) / drops.length;
      const curve = Math.sin(t * Math.PI) * Math.sin(progress * Math.PI * 2) * 40;
      this.steerWater(drops[i], origin.x + aim.x * reach * t - aim.y * curve,
        origin.y + aim.y * reach * t + aim.x * curve, dt);
    }
    const s = this.scene;
    for (const target of bendContacts(s, this.liveWater(whip), PIXEL * 1.5)) {
      const key = target.id || target.enemy;
      const x = target.body.x + target.body.w / 2, y = target.body.y + target.body.h / 2;
      if (whip.hits.has(key) || !bendClearPath(s, origin.x, origin.y, x, y, true)) continue;
      whip.hits.add(key);
      const dir = bendOutward(origin.x, origin.y, x, y, 0, 1);
      const amount = Math.min(8, 2 + Math.sqrt(drops.length) * 0.7);
      if (target.enemy) {
        s.damageEnemy(target.enemy, amount, 'Water');
        target.enemy.wetUntil = s.time.now + 900;
        target.enemy.burnUntil = 0;
        target.enemy.impulseX = (target.enemy.impulseX || 0) + dir.x * 170;
        target.enemy.vy += dir.y * 120 - 70;
      } else s.reportHit(target.id, 'Water', amount, null,
        { wetMs: 900, ix: dir.x * 170, iy: dir.y * 120 - 70 });
      s.fx.burst(x, y, 10, 'Water', { speed: 90, life: 0.35, size: 1.2 });
    }
  }

  updateShield(dt) {
    const state = this.shield;
    if (!state) return;
    const s = this.scene, water = s.benders.Water;
    const drops = this.liveWater(state);
    const refill = water.held.splice(0, Math.min(8, BENDING_ABILITY_RULES.Shield.capacity - drops.length));
    for (const drop of refill) { drop.bendAbility = state; drop.age = 0; drops.push(drop); water.free.push(drop); }
    if (!drops.length) { this.stopChannel(); return; }
    const p = s.player, aim = bendAim(s), angle = Math.atan2(aim.y, aim.x);
    for (let i = 0; i < drops.length; i++) {
      const layerCount = Math.min(24, drops.length), slot = i % layerCount;
      const a = angle - 1.1 + 2.2 * (slot + 0.5) / layerCount;
      const radius = 34 + Math.floor(i / 24) * PIXEL;
      this.steerWater(drops[i], p.x + p.w / 2 + Math.cos(a) * radius,
        p.y + p.h / 2 + Math.sin(a) * radius, dt);
    }
    for (const pr of [...s.projectiles]) this.interceptProjectile(pr);
  }

  // Swept tests catch bolts that cross the shield within a single frame. Remote
  // visual bolts retain collision authority on the casting client.
  interceptProjectile(pr, fromX = pr.x, fromY = pr.y) {
    if (!this.shield || pr.visualOnly) return false;
    const s = this.scene, water = s.benders.Water, p = s.player;
    if (s.time.now < (pr.shieldDeflectedUntil || 0)) return false;
    const dx = pr.x - fromX, dy = pr.y - fromY, length2 = dx * dx + dy * dy;
    let nearest = null;
    for (const drop of this.liveWater(this.shield)) {
      const t = length2 > 0 ? Math.max(0, Math.min(1, ((drop.x - fromX) * dx + (drop.y - fromY) * dy) / length2)) : 0;
      const x = fromX + dx * t, y = fromY + dy * t;
      if (!bendNear(drop.x, drop.y, x, y, PIXEL * 2)
        || !bendClearPath(s, fromX, fromY, x, y, true)) continue;
      if (!nearest || t < nearest.t) nearest = { drop, x, y, t };
    }
    if (!nearest) return false;
    const { drop, x, y } = nearest;
    const index = water.free.indexOf(drop);
    if (index >= 0) water.free.splice(index, 1);
    pr.x = x; pr.y = y;
    if (pr.element === 'Fire') {
      const projectileIndex = s.projectiles.indexOf(pr);
      if (projectileIndex >= 0) s.projectiles.splice(projectileIndex, 1);
      bendSteam(s, x, y, 4);
    } else {
      const nx = x - (p.x + p.w / 2), ny = y - (p.y + p.h / 2);
      const len = Math.max(1, Math.hypot(nx, ny));
      const inward = pr.vx * nx / len + pr.vy * ny / len;
      if (inward < 0) { pr.vx -= inward * nx / len * 1.5; pr.vy -= inward * ny / len * 1.5; }
      pr.shieldDeflectedUntil = s.time.now + 200;
      water.settle(drop);
      s.fx.burst(x, y, 6, 'Water', { speed: 70, life: 0.3 });
    }
    return true;
  }

  groundAt(gx, gy) {
    const s = this.scene;
    if (gx < 2 || gx >= COLS - 2) return null;
    gy = Math.max(2, Math.min(ROWS - 2, gy));
    if (IS_SOLID[s.grid[s.idx(gx, gy)]]) {
      let steps = 42;
      while (gy > 2 && IS_SOLID[s.grid[s.idx(gx, gy - 1)]] && steps-- > 0) gy--;
      return !IS_SOLID[s.grid[s.idx(gx, gy - 1)]] ? gy : null;
    }
    for (let y = gy; y < Math.min(ROWS - 1, gy + 49); y++) {
      if (IS_SOLID[s.grid[s.idx(gx, y)]]) return y;
    }
    return null;
  }

  bodyOccupies(gx, gy, selfOnly = false) {
    const s = this.scene, x = gx * PIXEL, y = gy * PIXEL;
    const bodies = [s.player];
    if (!selfOnly) {
      bodies.push(...Object.values(s.remotePlayers).filter((p) => !p.dead)
        .map((p) => ({ ...p, w: PLAYER_BOX.w, h: PLAYER_BOX.h })),
      ...s.enemies.list.filter((e) => !e.dead));
    }
    return bodies.some((p) => x < p.x + p.w && x + PIXEL > p.x && y < p.y + p.h && y + PIXEL > p.y);
  }

  takeEarth(count) {
    const earth = this.scene.benders.Earth, cells = [];
    while (cells.length < count && earth.rock?.cells.length) cells.push(earth.rock.cells.pop());
    while (cells.length < count && earth.pieces.length) {
      const piece = earth.pieces.pop();
      cells.push({ shade: piece.variant || 0 });
    }
    if (earth.rock) {
      // Reuse freed gathering slots while LMB remains down across several casts.
      earth.rock.nextSlot = earth.rock.cells.length + earth.pieces.length;
      earth.pieces.forEach((piece, i) => { piece.slot = earth.rock.cells.length + i; });
    }
    return cells;
  }

  startStructure(name) {
    const s = this.scene, earth = s.benders.Earth, rule = BENDING_ABILITY_RULES[name];
    const target = bendTarget(s, 70), p = s.player;
    let gx = Math.floor(target.x / PIXEL);
    if (Math.abs(target.x - (p.x + p.w / 2)) < p.w / 2 + 12) {
      gx = Math.floor((p.x + p.w / 2) / PIXEL) + (p.facing || 1) * 11;
    }
    const available = Math.min(rule.capacity, earth.holding), queue = [];
    const count = name === 'Wall' ? 1 : Math.min(3, Math.max(1, Math.floor(available / 30)));
    const height = name === 'Wall' ? Math.min(28, Math.floor(available / 3))
      : Math.min(18, Math.floor((available / count + 2) / 3));
    const columns = Array.from({ length: count }, (_, i) => {
      const x = gx + Math.round((i - (count - 1) / 2) * 10);
      return { x, floor: this.groundAt(x, Math.floor(target.y / PIXEL)) };
    });
    for (let h = 1; h <= height; h++) {
      for (const column of columns) {
        if (column.floor === null) continue;
        for (let dx = -1; dx <= 1; dx++) {
          if (name === 'Spikes' && h === height && dx !== 0) continue;
          const x = column.x + dx, y = column.floor - h;
          if (x <= 0 || x >= COLS - 1 || y <= 0 || y >= ROWS - 1 || this.bodyOccupies(x, y, true)) continue;
          const mat = s.grid[s.idx(x, y)];
          if (!earth.open.has(mat)) continue;
          queue.push({ x, y });
        }
      }
    }
    queue.length = Math.min(queue.length, available);
    if (queue.length < (name === 'Wall' ? rule.minimum : 8)) return this.feedback('Aim at open ground within reach');
    const cells = this.takeEarth(queue.length);
    for (let i = 0; i < cells.length; i++) queue[i].shade = cells[i].shade || 0;
    this.structures.push({ name, queue, acc: 1, hits: new Set(), mass: cells.length });
    s.fx.shards(target.x, target.y, 14, 'Earth', { speed: 90, rise: 65, life: 0.45 });
    return true;
  }

  updateStructures(dt) {
    const s = this.scene, earth = s.benders.Earth;
    for (const structure of this.structures) {
      structure.acc += dt * (structure.name === 'Spikes' ? 150 : 110);
      while (structure.acc >= 1 && structure.queue.length) {
        structure.acc--;
        const cell = structure.queue.shift(), x = cell.x * PIXEL + PIXEL / 2, y = cell.y * PIXEL + PIXEL / 2;
        if (structure.name === 'Spikes') {
          for (const target of bendContacts(s, [{ x, y }], PIXEL * 2)) {
            const key = target.id || target.enemy;
            if (structure.hits.has(key)) continue;
            structure.hits.add(key);
            const amount = Math.min(24, 8 + structure.mass * 0.1);
            if (target.enemy) {
              s.damageEnemy(target.enemy, amount, 'Earth');
              target.enemy.vy -= 210;
            } else s.reportHit(target.id, 'Earth', amount, null, { ix: 0, iy: -210 });
          }
        }
        if (earth.open.has(s.grid[s.idx(cell.x, cell.y)]) && !this.bodyOccupies(cell.x, cell.y)) {
          s.setCell(s.idx(cell.x, cell.y), PixelWorld.MAT.STONE, cell.shade);
        } else {
          const source = this.origin();
          earth.loosePieces.push({ x: source.x, y: source.y, vx: 0, vy: 0,
            mat: PixelWorld.MAT.STONE, variant: cell.shade, age: 0 });
        }
      }
    }
    this.structures = this.structures.filter((structure) => structure.queue.length);
    if (this.structures.length && !s.multiplayer) s.collapseTimer = Math.min(s.collapseTimer ?? 120, 30);
  }

  startDash() {
    const s = this.scene, air = s.benders.Air, aim = bendAim(s), p = s.player;
    air.held.splice(0, BENDING_ABILITY_RULES.Dash.capacity);
    this.dash = { aim, age: 0, duration: 0.18 };
    p.bendDashUntil = s.time.now + this.dash.duration * 1000;
    air.gust(p.x + p.w / 2 - aim.x * 24, p.y + p.h / 2 - aim.y * 24,
      42, 130, { x: -aim.x, y: -aim.y });
    this.applyDash();
    s.fx.streaks(p.x + p.w / 2, p.y + p.h / 2, 18, 'Air',
      { speed: 260, angle: Math.atan2(-aim.y, -aim.x), spread: 0.4, life: 0.3 });
    return true;
  }

  applyDash() {
    const p = this.scene.player;
    p.impulseX = this.dash.aim.x * 560;
    p.vy = this.dash.aim.y * 420 - 25;
    p.grounded = false;
  }

  startVortex() {
    const s = this.scene, air = s.benders.Air;
    const count = air.held.splice(0, BENDING_ABILITY_RULES.Vortex.capacity).length;
    const target = bendTarget(s, 70);
    const source = this.origin();
    const steps = Math.max(1, Math.ceil(Math.hypot(target.x - source.x, target.y - source.y) / PIXEL));
    const dx = target.x - source.x, dy = target.y - source.y;
    let last = source;
    for (let i = 1; i <= steps; i++) {
      const x = source.x + dx * i / steps, y = source.y + dy * i / steps;
      const gx = Math.floor(x / PIXEL), gy = Math.floor(y / PIXEL);
      if (gx <= 0 || gx >= COLS - 1 || gy <= 0 || gy >= ROWS - 1
        || IS_SOLID[s.grid[s.idx(gx, gy)]] || bendEarthContact(s, x, y)) break;
      last = { x, y };
    }
    this.vortex = { ...last, age: 0, duration: 2.4, radius: Math.min(82, 40 + Math.sqrt(count) * 5), phase: 0 };
    s.fx.shockwave(last.x, last.y, 'Air', { r0: 3, r1: this.vortex.radius, life: 0.35, width: 2 });
    return true;
  }

  updateVortex(dt) {
    const vortex = this.vortex;
    if (!vortex) return;
    const s = this.scene;
    vortex.age += dt;
    if (vortex.age >= vortex.duration || s.player.dead) { this.vortex = null; return; }
    if (bendSelected(s, 'Air') && s.bendAction.Air === 'Vortex' && s.input.activePointer.rightButtonDown()) {
      const target = bendTarget(s, 70), dx = target.x - vortex.x, dy = target.y - vortex.y;
      const factor = Math.min(1, 220 * dt / Math.max(1, Math.hypot(dx, dy)));
      const x = vortex.x + dx * factor, y = vortex.y + dy * factor;
      if (bendClearPath(s, vortex.x, vortex.y, x, y, true)
        && !IS_SOLID[s.grid[s.idx(Math.floor(x / PIXEL), Math.floor(y / PIXEL))]]
        && !bendEarthContact(s, x, y)) { vortex.x = x; vortex.y = y; }
    }
    vortex.phase += dt * 9;
    const fade = Math.min(1, (vortex.duration - vortex.age) / 0.4);
    s.benders.Air.gust(vortex.x, vortex.y, vortex.radius, -1300 * dt * fade, null, 0, 0.65);
  }

  updateFlamethrower(dt) {
    const s = this.scene, fire = s.benders.Fire, source = this.origin(), aim = bendAim(s);
    this.jetAcc = Math.min(8, this.jetAcc + dt * 95);
    while (this.jetAcc >= 1 && fire.free.length < 180) {
      this.jetAcc--;
      const angle = Math.atan2(aim.y, aim.x) + (Math.random() - 0.5) * 0.25;
      fire.free.push({ x: source.x, y: source.y, vx: Math.cos(angle) * 820,
        vy: Math.sin(angle) * 820, age: 0, flameJet: true, maxAge: 0.28 });
    }
    if (this.jetAcc >= 1) this.jetAcc = 0;
    s.emitFireCasterParticles(2);
  }

  update(dt) {
    const s = this.scene;
    if (this.channel) {
      const rule = BENDING_ABILITY_RULES[this.channel.name];
      this.channel.age += dt;
      const expired = this.channel.age >= rule.duration;
      if (!bendSelected(s, rule.element) || s.bendAction[rule.element] !== this.channel.name
        || !s.input.activePointer.rightButtonDown() || expired) {
        this.stopChannel();
        if (expired) this.feedback('Release RMB to cast again');
      }
      else if (this.channel.name === 'Flamethrower') this.updateFlamethrower(dt);
      else this.updateShield(dt);
    }
    this.updateWhip(dt);
    this.updateStructures(dt);
    if (this.dash) {
      this.dash.age += dt;
      if (this.dash.age >= this.dash.duration || s.player.dead) this.dash = null;
      else this.applyDash();
    }
    this.updateVortex(dt);
  }

  draw() {
    const g = this.gfx;
    g.clear();
    for (const state of [this.whip, this.shield]) {
      if (!state) continue;
      const drops = this.liveWater(state);
      g.lineStyle(state === this.whip ? 3 : 2, 0x8fd4ff, 0.55);
      g.beginPath();
      for (let i = 0; i < drops.length; i++) {
        if (i === 0 || !bendClearPath(this.scene, drops[i - 1].x, drops[i - 1].y, drops[i].x, drops[i].y, true)) {
          g.moveTo(drops[i].x, drops[i].y);
        } else g.lineTo(drops[i].x, drops[i].y);
      }
      g.strokePath();
    }
    if (this.vortex) {
      const v = this.vortex;
      for (let i = 0; i < 36; i++) {
        const r = v.radius * Math.sqrt((i + 1) / 36);
        const angle = v.phase + i * BEND_GOLDEN - r * 0.035;
        g.fillStyle(0xdff5fa, 0.35 + 0.5 * (1 - r / v.radius));
        g.fillRect(v.x + Math.cos(angle) * r - 1.5, v.y + Math.sin(angle) * r - 1.5, 3, 3);
      }
    }
  }
}
