const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');
const PixelWorld = require('../world');

const source = fs.readFileSync(path.join(__dirname, '..', 'game.js'), 'utf8');
const Phaser = {
  Scene: class {},
  AUTO: 0,
  Scale: { FIT: 0, CENTER_BOTH: 0 },
  Math: { Clamp: (n, lo, hi) => Math.max(lo, Math.min(hi, n)) },
  Input: { Keyboard: {
    JustUp: () => false,
    JustDown(key) {
      const pressed = !!key?.justDown;
      if (key) key.justDown = false;
      return pressed;
    },
  } },
  Game: class {},
};
const casts = [];
const Spells = {
  ELEMENTS: { Fire: { radius: 9 } },
  cast(...args) { casts.push(args); },
  startChannel: () => ({ element: 'Fire' }),
  tickChannel: () => true,
};
const { SandScene } = vm.runInNewContext(source + '\n({ SandScene })', {
  PixelWorld, Phaser, MenuScene: class {}, window: {},
  CHAR_SCALE: 2, PLAYER_BOX: { w: 20, h: 32 },
  GameAudio: { hurt() {}, death() {}, cast() {} }, Spells,
});

function scene() {
  const s = new SandScene();
  s.time = { now: 1000 };
  s.player = {
    x: 50, y: 50, w: 20, h: 32, health: 100, maxHealth: 100,
    dead: false, vy: 0, vx: 0, impulseX: 0, wetUntil: 0, burnUntil: 0,
    grounded: false, facing: 1,
  };
  s.fx = { burst() {}, shake() {} };
  s.materialFraction = () => 0;
  s.rectSolid = () => false;
  const key = { isDown: false };
  s.keys = { left: key, right: key, up: key, down: key,
    a: key, d: key, w: key, s: key, space: key };
  return s;
}

test('water hit changes movement to swimming and quenches fire', () => {
  const s = scene();
  s.player.burnUntil = 2000;
  s.receiveHit({ element: 'Water', amount: 0, bend: { wetMs: 450 } });
  s.movePlayer(0.016);
  assert.equal(s.player.liquid, 'water');
  assert.equal(s.player.burnUntil, 0);
  assert.equal(s.player.health, 100);
  assert.equal(s.hitFlashUntil, undefined);
});

test('fire hit damages and keeps emitting burn after contact', () => {
  const s = scene();
  s.receiveHit({ element: 'Fire', amount: 3, bend: { burnMs: 1200 } });
  assert.equal(s.player.health, 97);
  assert.equal(s.player.burnUntil, 2200);
  s.time.now = 1100;
  s.applyEnvironmentDamage(1);
  assert.equal(s.player.health, 92);
});

test('air hit changes player impulse without damage', () => {
  const s = scene();
  s.receiveHit({ element: 'Air', amount: 0, bend: { ix: 40, iy: -25 } });
  assert.equal(s.player.impulseX, 40);
  assert.equal(s.player.vy, -25);
  assert.equal(s.player.health, 100);
});

test('orbit knockback can spare the caster', () => {
  const s = scene();
  s.debris = [];
  s.enemies = { list: [] };
  s.knockback(60, 66, 40, 120, 0, 0, true);
  assert.equal(s.player.impulseX, 0);
  assert.equal(s.player.vy, 0);
});

test('rubble from Earth bending spares its caster while hitting other bodies', () => {
  const s = scene();
  const damaged = [];
  const enemy = { x: 90, y: 50, w: 20, h: 32 };
  s.fallingBodies = () => [
    { key: 'self', target: s.player, self: true, x: 50, y: 50, w: 20, h: 32 },
    { key: 'enemy', target: enemy, enemy: true, ...enemy },
  ];
  s.clipFallingSweep = (_fromX, _fromY, x, y) => ({ x, y });
  s.applyFallingBodyDamage = (body) => { damaged.push(body.key); return true; };
  s.handleDebrisImpact({ x: 120, y: 60, mat: PixelWorld.MAT.STONE,
    vx: 600, vy: 0, impactArmed: true, impactContacts: new Set(),
    earthImpactSource: {} }, 40, 60, 600);
  assert.deepEqual(damaged, ['enemy']);
});

test('fire spells emit particles from the caster on cast and while channeling', () => {
  const s = scene();
  const bursts = [];
  s.fx.burst = (...args) => bursts.push(args);
  s.spellCombos = { primary: { element: 'Fire', form: 'Bolt', modifier: 'Chain' } };
  s.status = { empUntil: 0, marks: {}, buffs: {} };
  s.channels = { primary: null, secondary: null };
  s.fireCastFxAcc = 0;
  s.input = { activePointer: { worldX: 100, worldY: 100 } };
  s.sendNet = () => {};
  s.castWheelSpell('primary');
  assert.equal(bursts[0][3], 'Fire');
  assert.equal(bursts[0][0], s.player.x + s.player.w / 2);
  assert.equal(casts.at(-1)[1], 'Fire');

  s.beginChannel('primary');
  const before = bursts.length;
  s.updateChannels(0.1);
  assert.ok(bursts.length > before);
});

test('Q equips an element, shape, and action from digging mode', () => {
  const s = scene();
  let releases = 0;
  s.leftClickMode = 'dig';
  s.bendElement = 'Water';
  s.bendStyle = { Water: 'Bolt', Fire: 'Bolt' };
  s.bendAction = { Water: 'Normal', Fire: 'Normal' };
  s.benders = { Water: { release() { releases++; } }, Fire: { form: 'Bolt' } };
  s.wheelGfx = { clear() {} };
  s.wheelPreviewText = { setVisible() {} };
  s.keys.q = { justDown: true };
  s.keys.e = {};
  s.drawBendWheel = () => {};
  s.input = { activePointer: { x: 454, y: 274 } };
  s.updateSpellWheel();
  assert.equal(s.bendWheelOpen, true);
  assert.equal(s.wheelOpen, undefined);
  s.updateBendWheel(); // inner lower right quarter: Fire
  s.input.activePointer = { x: 330, y: 240 };
  s.updateBendWheel(); // middle left half: Orbit
  s.input.activePointer.x = 550;
  s.updateBendWheel(); // outer right half: Punch
  s.closeBendWheel();
  assert.equal(s.bendElement, 'Fire');
  assert.equal(s.leftClickMode, 'bend');
  assert.equal(releases, 1);
  assert.equal(s.bendStyle.Fire, 'Orbit');
  assert.equal(s.bendAction.Fire, 'Punch');
  assert.equal(s.benders.Fire.form, 'Orbit');

  s.input.activePointer.x = 290;
  s.openBendWheel();
  s.updateBendWheel(); // outer left half: Normal
  s.closeBendWheel();
  assert.equal(s.bendAction.Fire, 'Normal');
});

test('Q wheel remembers Punch separately for every element', () => {
  const s = scene();
  s.bendStyle = { Water: 'Bolt', Earth: 'Bolt', Fire: 'Bolt', Air: 'Bolt' };
  s.bendAction = { Water: 'Normal', Earth: 'Normal', Fire: 'Normal', Air: 'Normal' };
  s.benders = Object.fromEntries(Object.keys(s.bendStyle).map((key) => [key,
    { form: 'Bolt', release() {} }]));
  s.wheelGfx = { clear() {} };
  s.wheelPreviewText = { setVisible() {} };
  s.keys.q = {};
  s.drawBendWheel = () => {};
  s.bendElement = 'Fire';
  const positions = { Water: [386, 274], Earth: [386, 206], Air: [454, 206] };
  s.input = { activePointer: {} };
  for (const element of ['Water', 'Earth', 'Air']) {
    s.openBendWheel();
    const [x, y] = positions[element];
    s.input.activePointer = { x, y };
    s.updateBendWheel();
    s.input.activePointer = { x: 550, y: 240 };
    s.updateBendWheel();
    s.closeBendWheel();
    assert.equal(s.bendAction[element], 'Punch');
  }
  assert.equal(s.bendAction.Fire, 'Normal');
  s.openBendWheel();
  s.input.activePointer = { x: 386, y: 274 };
  s.updateBendWheel();
  assert.equal(s.bendActionSel, 0);
});

test('right-click uses Fire Punch while fire bending', () => {
  const s = scene();
  let punches = 0, spellCasts = 0;
  s.leftClickMode = 'bend';
  s.bendElement = 'Fire';
  s.bendAction = { Fire: 'Punch' };
  s.benders = { Fire: { grabRadius: 6, punch() { punches++; }, begin() {}, release() {} } };
  s.rightClickMode = 'secondary';
  s.castWheelSpell = () => { spellCasts++; };
  s.stopChannel = () => {};
  s.prevLeftDown = true;
  s.prevRightDown = false;
  s.brushGfx = {
    clear() { return this; },
    lineStyle() { return this; },
    strokeCircle() { return this; },
  };
  s.input = { activePointer: {
    worldX: 100, worldY: 100,
    leftButtonDown: () => true, rightButtonDown: () => true,
  } };
  s.handlePointer();
  assert.equal(punches, 1);
  assert.equal(spellCasts, 0);
});

test('right-click dispatches Punch for Water, Earth, and Air', () => {
  for (const element of ['Water', 'Earth', 'Air']) {
    const s = scene();
    let punches = 0, spellCasts = 0;
    s.leftClickMode = 'bend';
    s.bendElement = element;
    s.bendAction = { [element]: 'Punch' };
    s.benders = { [element]: { grabRadius: 6,
      punch() { punches++; }, begin() {}, release() {} } };
    s.rightClickMode = 'secondary';
    s.castWheelSpell = () => { spellCasts++; };
    s.stopChannel = () => {};
    s.prevLeftDown = true;
    s.prevRightDown = false;
    s.brushGfx = { clear() { return this; }, lineStyle() { return this; },
      strokeCircle() { return this; } };
    s.input = { activePointer: { worldX: 100, worldY: 100,
      leftButtonDown: () => true, rightButtonDown: () => true } };
    s.handlePointer();
    assert.equal(punches, 1, element);
    assert.equal(spellCasts, 0, element);
  }
});

test('Punch uses held material before a simultaneous LMB release', () => {
  const s = scene(), order = [];
  let held = 12;
  s.leftClickMode = 'bend'; s.bendElement = 'Fire';
  s.bendAction = { Fire: 'Punch' };
  s.benders = { Fire: { grabRadius: 6, active: true,
    punch() { assert.equal(held, 12); order.push('punch'); held = 0; },
    release() { order.push('release'); held = 0; } } };
  s.attackControl = { prepareRelease() { assert.fail('Punch must own the charged attack'); } };
  s.stopChannel = () => {};
  s.castWheelSpell = () => assert.fail('Punch owns RMB');
  s.prevLeftDown = true; s.prevRightDown = false;
  s.brushGfx = { clear() { return this; }, lineStyle() { return this; }, strokeCircle() { return this; } };
  s.input = { activePointer: { worldX: 100, worldY: 100,
    leftButtonDown: () => false, rightButtonDown: () => true } };
  s.handlePointer();
  assert.deepEqual(order, ['punch', 'release']);
});

test('LMB release snapshots charge before releasing held material', () => {
  const s = scene(), order = [];
  s.leftClickMode = 'bend'; s.bendElement = 'Water';
  s.bendAction = { Water: 'Normal' };
  s.benders = { Water: { grabRadius: 6, active: true, release() { order.push('release'); } } };
  s.attackControl = { prepareRelease(element) { assert.equal(element, 'Water'); order.push('charge'); } };
  s.prevLeftDown = true; s.prevRightDown = false;
  s.brushGfx = { clear() { return this; }, lineStyle() { return this; }, strokeCircle() { return this; } };
  s.input = { activePointer: { worldX: 100, worldY: 100,
    leftButtonDown: () => false, rightButtonDown: () => false } };
  s.handlePointer();
  assert.deepEqual(order, ['charge', 'release']);
});

test('Q wheel renders only the four elements and implemented shape/action choices', () => {
  const s = scene();
  const icons = [];
  let preview;
  s.bendElementSel = 0;
  s.bendFormSel = 1;
  s.bendActionSel = 0;
  const gfx = {};
  for (const method of ['clear', 'fillStyle', 'beginPath', 'arc', 'closePath',
    'fillPath', 'lineStyle', 'strokePath', 'fillCircle']) gfx[method] = () => gfx;
  s.wheelGfx = gfx;
  s.drawWheelIcon = (_gfx, name) => icons.push(name);
  s.wheelPreviewText = { setVisible() {}, setText(text) { preview = text; } };
  s.drawBendWheel();
  assert.deepEqual(icons, ['Fire', 'Water', 'Earth', 'Air', 'Bolt', 'Orbit', 'Punch', 'Normal', 'Flamethrower']);
  assert.match(preview, /Fire \+ Orbit \+ Punch/);
  assert.match(preview, /Radial fire burst/);
});

test('Q offers distinct actions for each element and remembers their selection', () => {
  const s = scene();
  s.bendStyle = { Fire: 'Bolt', Water: 'Bolt', Earth: 'Orbit', Air: 'Bolt' };
  s.bendAction = { Fire: 'Flamethrower', Water: 'Shield', Earth: 'Spikes', Air: 'Vortex' };
  s.benders = Object.fromEntries(Object.keys(s.bendStyle).map((name) => [name, { release() {} }]));
  s.wheelGfx = { clear() {} };
  s.wheelPreviewText = { setVisible() {} };
  s.bendElement = 'Fire';
  for (const [index, actionIndex, name] of [[0, 2, 'Fire'], [1, 3, 'Water'], [2, 3, 'Earth'], [3, 3, 'Air']]) {
    const before = s.bendAction[name];
    s.selectBendWheelElement(index);
    assert.equal(s.bendActionSel, actionIndex);
    s.closeBendWheel();
    assert.equal(s.bendAction[name], before);
  }
});

test('Q outer ring adapts its choices to the highlighted element', () => {
  const s = scene();
  const choices = { Fire: ['Flamethrower'], Water: ['Whip', 'Shield'], Earth: ['Wall', 'Spikes', 'Catch'], Air: ['Dash', 'Vortex', 'Deflect'] };
  const gfx = {};
  for (const method of ['clear', 'fillStyle', 'beginPath', 'arc', 'closePath', 'fillPath', 'lineStyle', 'strokePath', 'fillCircle']) {
    gfx[method] = () => gfx;
  }
  s.wheelGfx = gfx;
  s.wheelPreviewText = { setVisible() {}, setText() {} };
  s.bendFormSel = 0; s.bendActionSel = 2;
  for (const [index, [element, abilities]] of Object.entries(choices).entries()) {
    const icons = [];
    s.bendElementSel = index;
    s.drawWheelIcon = (_gfx, name) => icons.push(name);
    s.drawBendWheel();
    assert.deepEqual(icons.slice(6), ['Punch', 'Normal', ...abilities], element);
  }
});

test('RMB dispatches each distinct ability once and suppresses secondary spells', () => {
  for (const [element, actions] of Object.entries({ Fire: ['Flamethrower'], Water: ['Whip', 'Shield'],
    Earth: ['Wall', 'Spikes', 'Catch'], Air: ['Dash', 'Vortex', 'Deflect'] })) {
    for (const action of actions) {
      const s = scene(), invoked = [];
      s.leftClickMode = 'bend'; s.bendElement = element; s.bendAction = { [element]: action };
      s.benders = { [element]: { grabRadius: 6, begin() {}, release() {} } };
      s.bendAbilities = { cast(name) { invoked.push(name); } };
      s.rightClickMode = 'secondary';
      s.stopChannel = () => {};
      s.castWheelSpell = () => assert.fail('selected ability owns RMB');
      s.prevLeftDown = true; s.prevRightDown = false;
      s.brushGfx = { clear() { return this; }, lineStyle() { return this; }, strokeCircle() { return this; } };
      s.input = { activePointer: { worldX: 100, worldY: 100,
        leftButtonDown: () => true, rightButtonDown: () => true } };
      s.handlePointer(); s.handlePointer();
      assert.deepEqual(invoked, [action]);
    }
  }
});

test('ability HUD reports controls, cooldown and resource hints', () => {
  const s = scene();
  s.leftClickMode = 'bend'; s.bendElement = 'Earth'; s.bendAction = { Earth: 'Wall' };
  s.bendAbilities = { remaining: () => 0.8, hintUntil: 1500, hint: 'Gather 9 earth first with LMB' };
  const label = s.rightButtonLabel(() => 'spell');
  assert.match(label, /RMB: earth wall/);
  assert.match(label, /0.8s cooldown/);
  assert.match(label, /Gather 9 earth/);
});

test('Air Dash cannot tunnel through a thin wall at high combined movement speed', () => {
  const s = scene();
  s.player.impulseX = 560; s.player.bendDashUntil = 2000;
  s.keys.right = { isDown: true };
  s.rectSolid = (x, _y, w) => x < 75 && x + w > 72;
  s.movePlayer(0.05);
  assert.ok(s.player.x + s.player.w <= 72);
  assert.equal(s.player.impulseX, 0);
});

test('a defensive debris interception happens before body damage or settling', () => {
  for (const response of ['caught', 'deflected']) {
    const s = scene();
    const obj = { x: 180, y: 66, vx: -1000, vy: 0, mat: PixelWorld.MAT.STONE,
      settleTimer: 6, bounces: 2, impactContacts: new Set(), impactArmed: true };
    s.debris = [obj];
    s.clipFallingSweep = (_x0, _y0, x, y) => ({ x, y, blocked: false, outOfBounds: false });
    s.bendAbilities = { interceptDebris(chunk, fromX) {
      assert.equal(chunk, obj); assert.equal(fromX, 180); return response;
    } };
    s.handleDebrisImpact = () => assert.fail('intercepted debris cannot deal body damage');
    s.settleDebris = () => assert.fail('intercepted debris cannot settle this frame');
    s.updateDebris(0.15);
    assert.equal(s.debris.length, response === 'caught' ? 0 : 1);
  }
});

test('a defensive terrain interception happens before falling-world body damage', () => {
  const s = scene();
  let calls = 0;
  s.bendAbilities = { interceptRigid() { calls++; return true; } };
  s.fallingBodies = () => assert.fail('caught terrain cannot reach the body damage pass');
  s.handleRigidFallImpact({ mat: PixelWorld.MAT.STONE, speed: 300, fromX: 60, fromY: 45, toX: 60, toY: 48 });
  assert.equal(calls, 1);
});

test('defensive actions retain their selection when switching Q elements', () => {
  const s = scene();
  s.bendStyle = { Earth: 'Bolt', Air: 'Bolt' };
  s.bendAction = { Earth: 'Catch', Air: 'Deflect' };
  s.bendElement = 'Earth';
  s.benders = { Earth: { release() {} }, Air: { release() {} } };
  s.wheelGfx = { clear() {} }; s.wheelPreviewText = { setVisible() {} };
  s.selectBendWheelElement(3); s.closeBendWheel();
  assert.equal(s.bendAction.Air, 'Deflect');
  s.selectBendWheelElement(2); s.closeBendWheel();
  assert.equal(s.bendAction.Earth, 'Catch');
});

test('right-click does not create material in dig or Normal bending mode', () => {
  for (const mode of ['dig', 'bend']) {
    const s = scene();
    s.leftClickMode = mode;
    s.rightClickMode = 'none';
    s.bendElement = 'Water';
    s.bendAction = { Water: 'Normal' };
    s.benders = { Water: { grabRadius: 6, release() {} } };
    s.prevLeftDown = false;
    s.prevRightDown = false;
    s.placeCircle = () => assert.fail('manual placement must be disabled');
    s.sendNet = () => assert.fail('right-click must not send a placement');
    s.brushGfx = { clear() { return this; }, lineStyle() { return this; },
      strokeCircle() { return this; } };
    s.input = { activePointer: { worldX: 100, worldY: 100,
      leftButtonDown: () => false, rightButtonDown: () => true } };
    s.handlePointer();
  }
});

test('Q wheel pauses mouse actions while choosing an element', () => {
  const s = scene();
  const stopped = [];
  s.bendWheelOpen = true;
  s.brushGfx = { clear() {} };
  s.stopChannel = (slot) => stopped.push(slot);
  s.input = { activePointer: {
    leftButtonDown: () => true, rightButtonDown: () => true,
  } };
  s.handlePointer();
  assert.deepEqual(stopped, ['primary', 'secondary']);
  assert.equal(s.prevLeftDown, true);
  assert.equal(s.prevRightDown, true);
});

test('B toggles digging without cycling the selected element', () => {
  const s = scene();
  s.leftClickMode = 'bend';
  s.bendElement = 'Fire';
  s.stopChannel = () => {};
  s.keys.b = { justDown: true };
  s.keys.esc = {};
  s.keys.r = {};
  s.handleSpellKeys();
  assert.equal(s.leftClickMode, 'dig');
  assert.equal(s.bendElement, 'Fire');
  s.keys.b.justDown = true;
  s.handleSpellKeys();
  assert.equal(s.leftClickMode, 'bend');
  assert.equal(s.bendElement, 'Fire');
});
