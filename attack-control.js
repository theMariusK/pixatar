// Charge and recall operate on existing bent matter. Size limits gathering;
// reducing it releases the excess instead of deleting water or earth.
const BEND_CONTROL_LIMITS = { Water: 200, Earth: 160, Fire: 120, Air: 90 };
const BEND_CHARGE_ACTIONS = new Set(['Normal', 'Punch', 'Whip', 'Wall', 'Spikes', 'Dash', 'Vortex', 'Catch']);

class BendingAttackControl {
  constructor(scene) {
    this.scene = scene;
    this.sizes = { ...BEND_CONTROL_LIMITS };
    this.gfx = scene.add.graphics().setDepth(8.9);
    this.clear();
  }

  clear() {
    for (const record of this.returning || []) delete record.obj.bendRecalling;
    this.returning = [];
    this.latched = false;
    this.handElement = null;
    this.element = null;
    this.charge = 0;
    this.pendingRelease = null;
    this.prevC = false;
    this.prevV = false;
    this.hint = '';
    this.hintUntil = 0;
  }

  available() { return bendSelected(this.scene, this.scene.bendElement); }
  capacity(element) { return this.sizes[element] ?? BEND_CONTROL_LIMITS[element]; }
  gatherCapacity(element) {
    const reserved = this.element === element ? this.returning.reduce((sum, item) =>
      sum + (item.kind === 'rock' ? item.obj.cells.length : 1), 0) : 0;
    return Math.max(0, this.capacity(element) - reserved);
  }
  keeps(element) {
    return this.latched && this.element === element && this.scene.bendElement === element
      && this.scene.leftClickMode === 'bend' && !this.scene.player.dead;
  }
  hand() {
    const p = this.scene.player;
    return { x: p.x + p.w / 2 + (p.facing || 1) * p.w * 0.35,
      y: p.y + p.h * (this.scene.bendElement === 'Earth' ? 0.25 : 0.4) };
  }
  holdingTarget(element) { return this.handElement === element && this.available() ? this.hand() : null; }
  onBegin() { this.handElement = null; }
  feedback(text) { this.hint = text; this.hintUntil = this.scene.time.now + 1400; return false; }

  power() { return { charge: this.charge, speed: 1 + this.charge * 0.4, power: 1 + this.charge * 0.65 }; }
  shot(element) {
    if (!this.available() || element !== this.scene.bendElement) return { charge: 0, speed: 1, power: 1 };
    const shot = this.power();
    this.charge = 0;
    return shot;
  }
  prepareRelease(element) {
    if (!this.keeps(element)) this.pendingRelease = { element, ...this.shot(element) };
  }
  releasePower(element) {
    if (this.pendingRelease?.element !== element) return { charge: 0, speed: 1, power: 1 };
    const shot = this.pendingRelease;
    this.pendingRelease = null;
    return shot;
  }

  compactEarth(earth) {
    if (!earth.rock) return;
    earth.rock.nextSlot = earth.holding;
    earth.pieces.forEach((piece, i) => { piece.slot = earth.rock.cells.length + i; });
  }

  trim(element) {
    const bender = this.scene.benders[element], limit = this.gatherCapacity(element);
    if (element === 'Earth') {
      while (bender.holding > limit && bender.pieces.length) {
        const piece = bender.pieces.pop();
        bender.loosePieces.push({ ...piece, vx: 0, vy: 0, age: 0 });
      }
      while (bender.holding > limit && bender.rock?.cells.length) {
        const cell = bender.rock.cells.pop();
        bender.loosePieces.push({ x: bender.rock.x + cell.ox * PIXEL, y: bender.rock.y + cell.oy * PIXEL,
          vx: 0, vy: 0, age: 0, mat: PixelWorld.MAT.STONE, variant: cell.shade });
      }
      this.compactEarth(bender);
    } else {
      for (const drop of bender.held.splice(limit)) {
        drop.age = 0; drop.vx *= 0.2; drop.vy *= 0.2;
        delete drop.attackPower;
        bender.free.push(drop);
      }
    }
  }

  adjustSize(direction) {
    if (!this.available() || !direction) return false;
    const element = this.scene.bendElement;
    for (const record of this.returning) delete record.obj.bendRecalling;
    this.returning = [];
    const step = element === 'Water' || element === 'Earth' ? 8 : element === 'Fire' ? 6 : 5;
    this.sizes[element] = Math.max(4, Math.min(BEND_CONTROL_LIMITS[element], this.capacity(element) + Math.sign(direction) * step));
    this.trim(element);
    this.charge = 0;
    return true;
  }

  recall() {
    if (!this.available() || this.scene.bendAbilities?.channel) return false;
    const element = this.scene.bendElement, bender = this.scene.benders[element], hand = this.hand();
    const room = this.capacity(element) - bender.holding;
    const canReturn = (obj) => !obj.bendAbility && !obj.bendRecalling && !obj.flameJet
      && (obj.age || 0) < (obj.maxAge ?? (element === 'Fire' ? FIRE_BEND.FREE_LIFE : element === 'Air' ? AIR_BEND.FREE_LIFE
        : element === 'Earth' ? EARTH_BEND.FREE_LIFE : BEND.FREE_LIFE))
      && Math.hypot(obj.x - hand.x, obj.y - hand.y) <= 285
      && bendClearPath(this.scene, obj.x, obj.y, hand.x, hand.y);
    const candidates = [];
    if (element === 'Earth') {
      for (const rock of bender.thrown) if (canReturn(rock)) candidates.push({ obj: rock, source: bender.thrown, kind: 'rock' });
      for (const drop of bender.loosePieces) if (canReturn(drop)) candidates.push({ obj: drop, source: bender.loosePieces, kind: 'stone' });
    } else {
      for (const drop of bender.free) if (canReturn(drop)) candidates.push({ obj: drop, source: bender.free, kind: 'drop' });
      if (element === 'Fire') for (const ball of bender.fireballs) {
        if (!ball.doused && ball.life > 0 && canReturn(ball)) candidates.push({ obj: ball, source: bender.fireballs, kind: 'ball' });
      }
    }
    candidates.sort((a, b) => Math.hypot(a.obj.x - hand.x, a.obj.y - hand.y) - Math.hypot(b.obj.x - hand.x, b.obj.y - hand.y));
    let remaining = Math.max(0, room - this.returning.reduce((sum, item) => sum + (item.kind === 'rock' ? item.obj.cells.length : 1), 0));
    for (const record of candidates) {
      if (!remaining) break;
      if (record.kind === 'ball') {
        const ball = record.obj, count = Math.min(remaining, Math.floor(ball.mass));
        if (!count) continue;
        const before = ball.mass;
        ball.mass -= count;
        const ratio = Math.sqrt(ball.mass / Math.max(1, before));
        ball.size *= ratio;
        for (const ember of ball.embers || []) {
          if (ember.ox !== undefined) { ember.ox *= ratio; ember.oy *= ratio; } else ember.radius *= ratio;
        }
        if (ball.mass < 1) record.source.splice(record.source.indexOf(ball), 1);
        for (let i = 0; i < count; i++) {
          const drop = { x: ball.x, y: ball.y, vx: 0, vy: 0, age: 0,
            life: Math.max(0.05, Math.min(FIRE_BEND.HOLD_LIFE, ball.life)), maxAge: Math.max(0.05, ball.life) };
          bender.free.push(drop);
          this.addReturn({ obj: drop, source: bender.free, kind: 'drop' });
        }
        remaining -= count;
      } else if (record.kind === 'rock' && record.obj.cells.length > remaining) {
        const original = record.obj;
        const part = { ...original, cells: original.cells.splice(original.cells.length - remaining), bendBounds: null };
        record.source.push(part);
        this.addReturn({ ...record, obj: part });
        remaining = 0;
      } else {
        this.addReturn(record);
        remaining -= record.kind === 'rock' ? record.obj.cells.length : 1;
      }
    }
    if (!this.returning.length && !bender.holding) return this.feedback('Nothing airborne within reach and a clear path');
    this.latched = true;
    this.element = element;
    this.handElement = element;
    this.charge = 0;
    return true;
  }

  addReturn(record) {
    record.age = 0;
    record.remainingLife = this.scene.bendElement === 'Fire' || this.scene.bendElement === 'Air'
      ? Math.min(record.obj.life ?? 5,
        (record.obj.maxAge ?? (this.scene.bendElement === 'Fire' ? FIRE_BEND.FREE_LIFE : AIR_BEND.FREE_LIFE)) - (record.obj.age || 0))
      : Infinity;
    record.obj.bendRecalling = true;
    record.obj.vx = 0; record.obj.vy = 0;
    this.returning.push(record);
  }

  claim(record) {
    const bender = this.scene.benders[this.element], obj = record.obj;
    const index = record.source.indexOf(obj);
    if (index < 0) return;
    if (this.element === 'Earth') {
      const count = record.kind === 'rock' ? obj.cells.length : 1;
      if (bender.holding + count > this.capacity(this.element)) return;
      if (!bender.rock) bender.rock = { ...this.hand(), vx: 0, vy: 0, cells: [], nextSlot: 0 };
      const cells = record.kind === 'rock' ? obj.cells : [{ shade: obj.variant }];
      for (const cell of cells) {
        const [ox, oy] = bender.slots[bender.holding];
        bender.rock.cells.push({ ox, oy, shade: cell.shade || 0 });
      }
      this.compactEarth(bender);
    } else {
      if (bender.holding >= this.capacity(this.element)) return;
      if (this.element === 'Fire' || this.element === 'Air') {
        obj.life = Math.min(obj.life ?? 5, Math.max(0.05,
          (this.element === 'Fire' ? FIRE_BEND.FREE_LIFE : AIR_BEND.FREE_LIFE) - (obj.age || 0)));
      }
      delete obj.punched; delete obj.punchMass; delete obj.jetId; delete obj.attackPower; delete obj.maxAge;
      obj.vx = 0; obj.vy = 0;
      bender.held.push(obj);
    }
    record.source.splice(index, 1);
    delete obj.bendRecalling;
  }

  updateRecall(dt) {
    const hand = this.hand(), bender = this.scene.benders[this.element];
    for (const record of this.returning) {
      const obj = record.obj;
      record.age += dt;
      if (!record.source.includes(obj) || record.age > 2.5) { delete obj.bendRecalling; continue; }
      record.remainingLife -= dt;
      if (record.remainingLife <= 0) {
        record.source.splice(record.source.indexOf(obj), 1);
        delete obj.bendRecalling;
        continue;
      }
      if (Number.isFinite(record.remainingLife)) obj.life = record.remainingLife;
      const dx = hand.x - obj.x, dy = hand.y - obj.y, distance = Math.hypot(dx, dy);
      const travel = Math.min(distance, 520 * dt), steps = Math.max(1, Math.ceil(travel / PIXEL));
      for (let i = 0; i < steps; i++) {
        const x = obj.x + dx / Math.max(1, distance) * travel / steps;
        const y = obj.y + dy / Math.max(1, distance) * travel / steps;
        const gx = Math.floor(x / PIXEL), gy = Math.floor(y / PIXEL);
        if (gx <= 0 || gx >= COLS - 1 || gy <= 0 || gy >= ROWS - 1) break;
        const clear = record.kind === 'rock'
          ? obj.cells.every((cell) => !bender.solidAt(x + cell.ox * PIXEL, y + cell.oy * PIXEL))
          : !IS_SOLID[this.scene.grid[this.scene.idx(gx, gy)]] && !bendEarthContact(this.scene, x, y);
        if (!clear) break;
        obj.x = x; obj.y = y;
      }
      if (Math.hypot(hand.x - obj.x, hand.y - obj.y) <= PIXEL * 2) this.claim(record);
    }
    this.returning = this.returning.filter((record) => record.obj.bendRecalling && record.source.includes(record.obj));
  }

  cancel() {
    const old = this.element;
    for (const record of this.returning) delete record.obj.bendRecalling;
    this.returning = [];
    this.latched = false; this.handElement = null; this.charge = 0; this.pendingRelease = null;
    this.element = null;
    if (old) this.scene.benders[old].release(true);
  }

  update(dt) {
    const s = this.scene, c = !!s.keys?.c?.isDown, v = !!s.keys?.v?.isDown;
    const latchPressed = c && !this.prevC, recallPressed = v && !this.prevV;
    this.prevC = c; this.prevV = v;
    if (s.player.dead || s.leftClickMode !== 'bend' || (this.element && this.element !== s.bendElement)) this.cancel();
    if (s.player.dead || s.leftClickMode !== 'bend') return;
    this.element = s.bendElement;
    if (s.wheelOpen || s.bendWheelOpen) {
      for (const record of this.returning) delete record.obj.bendRecalling;
      this.returning = [];
      this.charge = 0; this.pendingRelease = null;
      if (!this.latched) s.benders[this.element].release(true);
      return;
    }
    if (latchPressed) {
      this.latched = !this.latched;
      if (!this.latched) {
        this.handElement = null;
        if (!s.input.activePointer.leftButtonDown?.()) this.prepareRelease(this.element);
      }
    }
    if (recallPressed) this.recall();
    if (this.returning.length) this.updateRecall(dt);
    const bender = s.benders[this.element], reserved = this.returning.reduce((sum, item) =>
      sum + (item.kind === 'rock' ? item.obj.cells.length : 1), 0);
    if (bender.holding + reserved > this.capacity(this.element)) this.trim(this.element);
    if (!bender.holding) this.charge = 0;
    else if (s.keys?.shift?.isDown && BEND_CHARGE_ACTIONS.has(s.bendAction[this.element]) && !s.bendAbilities?.channel) {
      this.charge = Math.min(1, this.charge + dt / 1.25);
    }
  }

  readout() {
    const parts = [`size ${this.capacity(this.scene.bendElement)}`];
    if (this.charge) parts.push(`charge ${Math.round(this.charge * 100)}%`);
    if (this.latched) parts.push('held');
    if (this.returning.length) parts.push(`recalling ${this.returning.length}`);
    if (this.hintUntil > this.scene.time.now) parts.push(this.hint);
    return parts.join(' · ');
  }

  draw() {
    const g = this.gfx;
    g.clear();
    if (!this.charge || !this.available()) return;
    const bender = this.scene.benders[this.scene.bendElement];
    let x = bender.rock?.x, y = bender.rock?.y;
    if (x === undefined && bender.held?.length) {
      x = bender.held.reduce((sum, drop) => sum + drop.x, 0) / bender.held.length;
      y = bender.held.reduce((sum, drop) => sum + drop.y, 0) / bender.held.length;
    }
    if (x === undefined) return;
    const color = { Fire: 0xffaa33, Water: 0x8fd4ff, Earth: 0xe0c898, Air: 0xdff5fa }[this.scene.bendElement];
    g.fillStyle(0x000000, 0.6).fillRect(x - 16, y - 25, 32, 4);
    g.fillStyle(color, 0.9).fillRect(x - 16, y - 25, 32 * this.charge, 4);
    for (let i = 0; i < Math.ceil(this.charge * 18); i++) {
      const angle = i * Math.PI * 2 / 18 + this.scene.time.now / 600;
      g.fillRect(x + Math.cos(angle) * 21 - 1, y + Math.sin(angle) * 21 - 1, 2, 2);
    }
  }
}
