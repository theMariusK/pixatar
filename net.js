// Multiplayer endpoint resolution shared by the menu and the game scene.
//
// The server can listen on any PORT, so the client must not hard-code 8080. An
// explicit endpoint wins, then ?server=..., then the default host:8080. Accepting
// http(s) URLs and upgrading them to ws(s) makes reverse-proxy setups work.
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.GameNet = api;
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  const DEFAULT_PORT = 8080;

  function socketUrl(loc, override) {
    loc = loc || (typeof location !== 'undefined' ? location : null);
    if (!loc) return '';
    if (!override && typeof window !== 'undefined') override = window.MULTIPLAYER_URL;
    if (!override && loc.search) {
      try { override = new URLSearchParams(loc.search).get('server'); } catch (e) { /* old browser */ }
    }

    if (override) {
      try {
        const url = new URL(override, loc.href || undefined);
        if (url.protocol === 'http:') url.protocol = 'ws:';
        else if (url.protocol === 'https:') url.protocol = 'wss:';
        if (url.protocol !== 'ws:' && url.protocol !== 'wss:') return '';
        return url.toString().replace(/\/$/, '');
      } catch (e) {
        return '';
      }
    }

    const proto = loc.protocol === 'https:' ? 'wss:' : 'ws:';
    return `${proto}//${loc.hostname || 'localhost'}:${DEFAULT_PORT}`;
  }

  return { DEFAULT_PORT, socketUrl };
});
