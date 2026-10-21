const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');

const source = fs.readFileSync(path.join(__dirname, '..', 'menu.js'), 'utf8');
const { MenuScene } = vm.runInNewContext(source + '\n({ MenuScene })', {
  Phaser: { Scene: class { constructor(key) { this.key = key; } } },
});

test('free play offers Town first and all implemented maps', () => {
  const menu = new MenuScene();
  const def = menu.screenDef('freeplay');
  assert.equal(def.title, 'FREE PLAY');
  assert.equal(
    def.items.map((item) => item.label).join('|'),
    'Town|Agni Kai Arena|Sky Temple|Frozen North|Volcanic Caldera|Back',
  );

  const started = [];
  menu.startGame = (data) => started.push(data);
  for (const item of def.items) {
    if (item.label !== 'Back') item.act();
  }
  assert.deepEqual(started.map((game) => game.map).join(','), 'town,arena,sky,north,caldera');
  for (const game of started) assert.equal(game.netMode, 'solo');
});

test('the singleplayer Free play button opens the map selector', () => {
  const menu = new MenuScene();
  const shown = [];
  menu.showScreen = (name) => shown.push(name);
  const def = menu.screenDef('singleplayer');
  const freePlay = def.items.find((item) => item.label === 'Free play');
  assert.ok(freePlay);
  freePlay.act();
  assert.deepEqual(shown, ['freeplay']);
});

test('Escape from the map selector returns to singleplayer, not multiplayer', () => {
  const menu = new MenuScene();
  const shown = [];
  menu.showScreen = (name) => shown.push(name);
  menu.screen = 'freeplay';
  menu.onKey({ key: 'Escape' });
  assert.deepEqual(shown, ['singleplayer']);
});
