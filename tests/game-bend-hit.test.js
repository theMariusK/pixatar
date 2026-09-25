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
