const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const sounds = [];
const FXSystem = vm.runInNewContext(
  fs.readFileSync(path.join(__dirname, '..', 'fx.js'), 'utf8') + '\nFXSystem', {
    GameAudio: { impact(...args) { sounds.push(args); } },
  });

function scene() {
  const calls = [], shakes = [];
  const g = new Proxy({}, { get: (_obj, method) => (...args) => { calls.push([method, ...args]); return g; } });
  const s = { time: { now: 1000 }, calls, shakes, add: { graphics: () => g },
    cameras: { main: { width: 800, height: 480,
      worldView: { x: 0, y: 0, width: 800, height: 480 },
      shake(...args) { shakes.push(args); } } } };
  s.fx = new FXSystem(s);
  sounds.length = 0;
  return s;
}

test('element contacts have different matter and terrain spray points back from the hit', () => {
  for (const [element, shape] of [['Water', 'circle'], ['Earth', 'shard'], ['Fire', 'square'], ['Air', 'streak']]) {
    const s = scene();
    assert.equal(s.fx.impact(100, 100, element, { vx: 700, vy: 0, strength: 0.6 }), true);
    const particles = s.fx.particles.filter((p) => p.shape !== 'puff');
    assert.ok(particles.length > 0);
    assert.ok(particles.every((p) => p.shape === shape && p.vx < 0), element);
    assert.equal(sounds[0][0], element);
    s.fx.draw();
    assert.ok(s.calls.some(([method]) => method === 'strokePath'));
    assert.equal(s.fx.screenEffects.length, 0);
    assert.equal(s.hitstopUntil, undefined);
    assert.equal(s.shakes.length, 0);
  }
});

test('stronger hits show larger cues with more particles and a bounded pause', () => {
  const small = scene(), large = scene();
  small.fx.impact(100, 100, 'Earth', { kind: 'body', strength: 0.4 });
  large.fx.impact(100, 100, 'Earth', { kind: 'body', strength: 9 });
  assert.ok(large.fx.effects[0].size > small.fx.effects[0].size);
  assert.ok(large.fx.particles.length > small.fx.particles.length);
  assert.equal(small.hitstopUntil, undefined);
  assert.ok(large.hitstopUntil > large.time.now && large.hitstopUntil <= large.time.now + 44);
  assert.equal(large.shakes.length, 1);
});

test('continuous contacts throttle on real time and cannot repeatedly freeze the world', () => {
  const s = scene();
  for (let i = 0; i < 100; i++) {
    s.fx.impact(100 + i % 3, 100, 'Fire', { kind: 'body', strength: 0.5, minor: true });
    s.fx.update(0.001);
  }
  assert.equal(s.fx.effects.length, 1);
  assert.equal(sounds.length, 1);
  assert.equal(s.hitstopUntil, undefined);
  assert.equal(s.shakes.length, 0);
  s.time.now += 180;
  assert.equal(s.fx.impact(100, 100, 'Fire', { kind: 'body', minor: true }), true);
  assert.equal(sounds.length, 2);
});

test('simultaneous blasts share a camera cooldown, leaving local cues visible', () => {
  const s = scene();
  s.fx.impact(100, 100, 'Fire', { kind: 'blast', strength: 1.5 });
  const pause = s.hitstopUntil;
  s.time.now += 50;
  s.fx.impact(180, 100, 'Earth', { kind: 'body', strength: 1.8 });
  assert.equal(s.fx.effects.filter((e) => e.kind === 'contact').length, 2);
  assert.equal(s.hitstopUntil, pause);
  assert.equal(s.shakes.length, 1);
  s.time.now += 240;
  s.fx.impact(100, 100, 'Earth', { kind: 'body', strength: 1.8 });
  assert.equal(s.shakes.length, 2);
});

test('a terrain barrage reserves feedback for hits on bodies and keeps all effect pools bounded', () => {
  const s = scene();
  for (let i = 0; i < 1000; i++) s.fx.impact((i % 20) * 36, Math.floor(i / 20) * 36, 'Water');
  assert.ok(s.fx.impactContacts.length <= 16);
  assert.equal(s.fx.impact(100, 100, 'Fire', { kind: 'body', strength: 1.2 }), true);
  assert.ok(s.fx.effects.length < 340);
  s.fx.burst(100, 100, 10000, 'Fire');
  assert.equal(s.fx.particles.length, 2400);
  s.fx.update(5);
  assert.equal(s.fx.particles.length, 0);
  assert.equal(s.fx.effects.length, 0);
  s.time.now += 5000;
  s.fx.impact(100, 100, 'Water');
  assert.equal(s.fx.impactContacts.length, 1);
});

test('blocks have a different mark and sound from body hits, and timed blocks have an extra arc', () => {
  const regular = scene();
  regular.fx.impact(100, 100, 'Air', { kind: 'block', vx: -500, strength: 0.8 });
  regular.fx.draw();
  const arcs = regular.calls.filter(([method]) => method === 'arc').length;
  assert.ok(arcs > 0);
  const timed = scene();
  timed.fx.impact(100, 100, 'Air', { kind: 'block', vx: -500, strength: 1.2, parry: true });
  timed.fx.draw();
  assert.ok(timed.calls.filter(([method]) => method === 'arc').length > arcs);
  assert.equal(sounds[0][3].contact, 'block');
  assert.equal(sounds[0][3].parry, true);
  const body = scene();
  body.fx.impact(100, 100, 'Air', { kind: 'body' });
  body.fx.draw();
  assert.equal(body.calls.filter(([method]) => method === 'arc').length, 0);
});

test('steam and minor impacts never add screen force even at high strength', () => {
  const s = scene();
  s.fx.impact(100, 100, 'Water', { kind: 'steam', strength: 2 });
  s.fx.impact(200, 100, 'Fire', { kind: 'body', strength: 2, minor: true });
  assert.equal(s.hitstopUntil, undefined);
  assert.equal(s.shakes.length, 0);
  assert.equal(s.fx.screenEffects.length, 0);
  assert.ok(s.fx.particles.some((p) => p.shape === 'puff' && p.element === 'Water'));
  assert.equal(sounds[0][3].contact, 'steam');
});

test('offscreen and invalid contacts cannot shake the camera or create cues', () => {
  const s = scene();
  assert.equal(s.fx.impact(1000, 100, 'Fire', { kind: 'blast', strength: 2 }), false);
  assert.equal(s.fx.impact(NaN, 100, 'Earth'), false);
  assert.equal(s.fx.effects.length, 0);
  assert.equal(s.fx.particles.length, 0);
  assert.equal(sounds.length, 0);
  assert.equal(s.shakes.length, 0);
  assert.equal(s.hitstopUntil, undefined);
});
