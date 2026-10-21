const test = require('node:test');
const assert = require('node:assert/strict');
const GameNet = require('../net');

function loc(overrides = {}) {
  return Object.assign({
    href: 'http://localhost:8000/index.html',
    protocol: 'http:',
    hostname: 'localhost',
    search: '',
  }, overrides);
}

test('defaults to the server port on the page host', () => {
  assert.equal(GameNet.socketUrl(loc()), 'ws://localhost:8080');
});

test('uses wss when the page is served over https', () => {
  assert.equal(GameNet.socketUrl(loc({
    href: 'https://game.example/index.html', protocol: 'https:', hostname: 'game.example',
  })), 'wss://game.example:8080');
});

test('?server= overrides the endpoint and upgrades http to ws', () => {
  assert.equal(
    GameNet.socketUrl(loc({ search: '?server=http%3A%2F%2F192.168.1.5%3A9000' })),
    'ws://192.168.1.5:9000',
  );
});

test('an explicit wss endpoint is preserved', () => {
  assert.equal(
    GameNet.socketUrl(loc(), 'wss://rooms.example/live'),
    'wss://rooms.example/live',
  );
});

test('non-websocket overrides are rejected instead of producing a broken socket', () => {
  assert.equal(GameNet.socketUrl(loc(), 'ftp://example.test/live'), '');
});
