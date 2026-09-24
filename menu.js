// Front-end menu: singleplayer / multiplayer / exit, and the screens beneath them.
//
// Rendered with the same Phaser canvas as the game so it scales with the same
// Scale.FIT setup and needs no DOM overlay. Navigation works by mouse OR keyboard —
// the keyboard path matters because it is the only one that can be driven by
// synthetic events, which is how this gets tested.
//
// Screen structure:
//   main ──▶ singleplayer ──▶ Campaign (not built) | Free play
//        └─▶ multiplayer  ──▶ Browse rooms | Join with ID | Create room
//        └─▶ exit

// Matches the game's palette: near-black ground, off-white text, one accent per
// element so each screen has its own tint rather than a single flat theme.
const MENU_COLORS = {
  bg: 0x0a0a0f,
  panel: 0x11121a,
  border: 0x2a2d3d,
  borderHot: 0x66d9ff,
  text: 0xdfe4ff,
  textDim: 0x6b7191,
  textOff: 0x3d4159,
  accent: 0x66d9ff,
};

class MenuScene extends Phaser.Scene {
  constructor() {
    super('menu');
  }

  create() {
    this.screen = 'main';
    this.sel = 0;
    this.items = [];
    this.typed = '';
    this.notice = '';
    this.noticeUntil = 0;

    this.fx = new FXSystem(this);
    this.ambientTimer = 0;

    this.bgGfx = this.add.graphics().setDepth(0);
    this.panelGfx = this.add.graphics().setDepth(1);
    this.titleText = this.add.text(0, 0, '', {
      fontFamily: 'monospace', fontSize: '34px', color: '#dfe4ff',
    }).setDepth(2);
    this.subText = this.add.text(0, 0, '', {
      fontFamily: 'monospace', fontSize: '12px', color: '#6b7191',
    }).setDepth(2);
    this.noticeText = this.add.text(0, 0, '', {
      fontFamily: 'monospace', fontSize: '12px', color: '#ffcc66',
    }).setDepth(3).setOrigin(0.5, 0.5);
    this.hintText = this.add.text(0, 0, '', {
      fontFamily: 'monospace', fontSize: '11px', color: '#3d4159',
    }).setDepth(2).setOrigin(0.5, 1);

    this.labels = [];
    this.sublabels = [];

    // Lobby connection: used only to list, create and join rooms. Once a room is
    // entered the socket is handed to the game scene rather than reopened, so there
    // is no window in which the room could be reaped between the two.
    this.rooms = [];
    this.lobbyState = 'connecting';
    this.lobbyError = '';
    this.pendingAction = null;
    this.connectLobby();

    this.input.keyboard.on('keydown', this.onKey, this);
    this.showScreen('main');

    this.events.once('shutdown', () => {
      // If the socket was handed to the game, `this.lobbySocket` is already null.
      if (this.lobbySocket) {
        try { this.lobbySocket.close(); } catch (e) { /* already gone */ }
        this.lobbySocket = null;
      }
    });
  }

  connectLobby() {
    let sock;
    try {
      const proto = location.protocol === 'https:' ? 'wss' : 'ws';
      sock = new WebSocket(`${proto}://${location.hostname}:8080`);
    } catch (e) {
      this.lobbyState = 'offline';
      return;
    }
    this.lobbySocket = sock;
    sock.onopen = () => { this.lobbyState = 'online'; };
    sock.onmessage = (ev) => {
      let msg;
      try { msg = JSON.parse(ev.data); } catch (e) { return; }
      this.onLobbyMessage(msg);
    };
    sock.onclose = () => {
      this.lobbyState = 'offline';
      if (this.screen === 'browse') this.refreshScreen();
    };
    sock.onerror = () => { this.lobbyState = 'offline'; };
  }

  onLobbyMessage(msg) {
    if (msg.t === 'rooms') {
      this.rooms = Array.isArray(msg.rooms) ? msg.rooms : [];
      if (this.screen === 'browse') this.refreshScreen();
    } else if (msg.t === 'joined') {
      // The room exists and we are in it — hand the live socket to the game so the
      // seat we just took is the one we keep playing in.
      const sock = this.lobbySocket;
      this.lobbySocket = null;
      if (sock) { sock.onmessage = null; sock.onopen = null; sock.onclose = null; sock.onerror = null; }
      const data = {
        netMode: 'multi',
        roomId: msg.roomId,
        roomName: msg.roomName,
        socket: sock,
        prejoined: msg,
      };
      if (this.scene.get('sand')) this.scene.stop('sand');
      this.scene.start('sand', data);
    } else if (msg.t === 'error') {
      this.pendingAction = null;
      this.lobbyError = String(msg.message || 'Something went wrong.');
      this.notify(this.lobbyError);
      this.refreshScreen();
    }
  }

  get lobbyReady() {
    return this.lobbySocket && this.lobbySocket.readyState === 1;
  }

  requestRooms() {
    if (!this.lobbyReady) {
      this.lobbyState = 'offline';
      this.notify('Not connected to a room server.');
      this.refreshScreen();
      return;
    }
    this.lobbySocket.send(JSON.stringify({ t: 'list' }));
  }

  requestJoin(roomId) {
    if (!this.lobbyReady) { this.notify('Not connected to a room server.'); return; }
    const wanted = String(roomId || '').toUpperCase().trim();
    if (!wanted) { this.notify('Enter a room ID first.'); return; }
    this.pendingAction = 'join';
    this.notify(`Joining ${wanted}...`);
    this.lobbySocket.send(JSON.stringify({ t: 'join', roomId: wanted }));
  }

  requestCreate(name) {
    if (!this.lobbyReady) { this.notify('Not connected to a room server.'); return; }
    this.pendingAction = 'create';
    this.notify('Creating room...');
    this.lobbySocket.send(JSON.stringify({ t: 'create', name: String(name || '').trim() }));
  }

  // Rebuilds the current screen in place, e.g. when the room list changes.
  refreshScreen() {
    const keep = this.sel;
    this.showScreen(this.screen);
    if (keep < this.items.length && this.items[keep] && this.items[keep].enabled !== false) {
      this.sel = keep;
      this.draw();
    }
  }

  // ---------- screen definitions ----------
  //
  // Each entry is { label, sub, enabled, act }. Screens that are not built yet say
  // so on the button rather than silently doing nothing when clicked.

  screenDef(name) {
    switch (name) {
      case 'main':
        return {
          title: 'PIXEL2D',
          sub: 'a falling-sand world with a spell wheel',
          items: [
            { label: 'Singleplayer', sub: 'play alone', act: () => this.showScreen('singleplayer') },
            { label: 'Multiplayer', sub: 'play with others', act: () => this.showScreen('multiplayer') },
            { label: 'Exit', sub: '', act: () => this.showScreen('exit') },
          ],
        };
      case 'singleplayer':
        return {
          title: 'SINGLEPLAYER',
          sub: 'your own procedurally generated world',
          items: [
            { label: 'Campaign', sub: 'fight through levels', act: () => this.showScreen('campaign') },
            { label: 'Free play', sub: 'sandbox — dig, build, and test spells', act: () => this.startGame({ netMode: 'solo' }) },
            { label: 'Back', sub: '', act: () => this.showScreen('main') },
          ],
        };
      case 'campaign':
        return {
          title: 'CAMPAIGN',
          sub: 'pick a level',
          items: [
            {
              label: 'Level 1',
              sub: 'a wild world with a handful of hostiles',
              act: () => this.startGame({ netMode: 'solo', campaign: true, level: 1 }),
            },
            { label: 'More levels', sub: 'coming later', enabled: false, act: () => {} },
            { label: 'Back', sub: '', act: () => this.showScreen('singleplayer') },
          ],
        };
      case 'multiplayer':
        return {
          title: 'MULTIPLAYER',
          sub: 'shared world, shared destruction',
          items: [
            { label: 'Browse rooms', sub: 'see what is running', act: () => this.showScreen('browse') },
            { label: 'Join directly with ID', sub: 'connect to a specific room', act: () => this.showScreen('join') },
            { label: 'Create room', sub: 'start a fresh world', act: () => this.showScreen('create') },
            { label: 'Back', sub: '', act: () => this.showScreen('main') },
          ],
        };
      case 'browse': {
        const items = [];
        if (this.lobbyState !== 'online') {
          items.push({ label: 'Connecting...', sub: 'looking for the room server', enabled: false, act: () => {} });
        } else if (!this.rooms.length) {
          items.push({ label: 'No rooms open', sub: 'be the first — create one', enabled: false, act: () => {} });
        } else {
          for (const r of this.rooms) {
            items.push({
              label: r.name,
              sub: `${r.id}  ·  ${r.players}/${r.max} players  ·  host ${r.host}`,
              act: () => this.requestJoin(r.id),
            });
          }
        }
        items.push({ label: 'Refresh', sub: 'look again', act: () => this.requestRooms() });
        items.push({ label: 'Back', sub: '', act: () => this.showScreen('multiplayer') });
        return {
          title: 'ROOMS',
          sub: this.lobbyState === 'online'
            ? `${this.rooms.length} room${this.rooms.length === 1 ? '' : 's'} open`
            : 'not connected',
          items,
        };
      }
      case 'join':
        return {
          title: 'JOIN WITH ID',
          sub: 'type a room ID, then press Enter',
          text: 'id',
          items: [
            { label: 'Join', sub: 'connect to that room', act: () => this.requestJoin(this.typed) },
            { label: 'Back', sub: '', act: () => this.showScreen('multiplayer') },
          ],
        };
      case 'create':
        return {
          title: 'CREATE ROOM',
          sub: 'name your room, then press Enter',
          text: 'name',
          items: [
            { label: 'Create', sub: 'host a new room', act: () => this.requestCreate(this.typed) },
            { label: 'Back', sub: '', act: () => this.showScreen('multiplayer') },
          ],
        };
      case 'exit':
        return {
          title: 'GOODBYE',
          sub: 'a browser tab cannot close itself',
          notice: 'Close this tab when you are done.',
          items: [
            { label: 'Back to menu', sub: '', act: () => this.showScreen('main') },
          ],
        };
      default:
        return { title: '?', sub: '', items: [] };
    }
  }

  // ---------- rendering ----------

  // Fits the rows between the header and the footer, shrinking them when a screen
  // has more entries than the default size allows.
  computeLayout() {
    const n = Math.max(1, this.items.length);
    const availTop = 168;
    const availBottom = SCREEN_HEIGHT - 56;
    let step = 58;
    let h = 52;
    if (availTop + n * step > availBottom) {
      step = Math.max(30, Math.floor((availBottom - availTop) / n));
      h = Math.max(26, step - 6);
    }
    const top = availTop + Math.max(0, Math.floor(((availBottom - availTop) - n * step) / 2)) + Math.floor(step / 2);
    return { top, step, h, titleY: 80 };
  }

  showScreen(name) {
    this.screen = name;
    this.sel = 0;
    const def = this.screenDef(name);

    this.titleText.setText(def.title);
    this.subText.setText(def.sub || '');
    this.notice = def.notice || '';
    this.noticeText.setText('');

    // Rebuild the button list. Cheap enough at this size, and far less error-prone
    // than trying to diff the previous screen against the next.
    for (const l of this.labels) l.destroy();
    for (const l of this.sublabels) l.destroy();
    this.labels = [];
    this.sublabels = [];
    this.items = def.items;

    // Room lists vary in length, so derive the row layout from how many there are
    // rather than assuming the fixed three-to-four of the other screens.
    const cx = SCREEN_WIDTH / 2;
    const layout = this.computeLayout();
    const top = layout.top;
    const step = layout.step;
    this.rowH = layout.h;
    this.titleText.setPosition(cx, layout.titleY).setOrigin(0.5, 0.5);
    this.subText.setPosition(cx, 128).setOrigin(0.5, 0.5);
    this.noticeText.setPosition(cx, SCREEN_HEIGHT - 42);
    this.hintText.setPosition(cx, SCREEN_HEIGHT - 8);
    this.hintText.setText('↑ ↓ select    Enter confirm    Esc back');

    this.items.forEach((item, i) => {
      const y = top + i * step;
      const label = this.add.text(cx, y - (this.rowH >= 40 ? 6 : 0), item.label, {
        fontFamily: 'monospace', fontSize: '19px', color: '#dfe4ff',
      }).setOrigin(0.5, 0.5).setDepth(2);
      const sub = this.add.text(cx, y + 13, this.rowH >= 40 ? (item.sub || '') : '', {
        fontFamily: 'monospace', fontSize: '11px', color: '#6b7191',
      }).setOrigin(0.5, 0.5).setDepth(2);

      // Hit area in the label's local space. It must match the drawn box exactly
      // (centred on y, 340x52) or clicks land on the row below the one you aimed at —
      // the label itself sits 6px above centre so the two lines read as a block.
      label.setInteractive(new Phaser.Geom.Rectangle(-170, -this.rowH / 2, 340, this.rowH), Phaser.Geom.Rectangle.Contains);
      label.on('pointerover', () => {
        if (this.sel !== i) GameAudio.menuMove();
        this.sel = i;
        this.draw();
      });
      label.on('pointerdown', () => this.activate(i));

      this.labels.push(label);
      this.sublabels.push(sub);
    });

    // Keep the selection on something that can actually be activated.
    if (this.items.length && !this.items[this.sel].enabled) this.moveSelection(1);
    this.draw();
  }

  draw() {
    const g = this.panelGfx;
    g.clear();
    this.bgGfx.clear();
    this.bgGfx.fillStyle(MENU_COLORS.bg, 1);
    this.bgGfx.fillRect(0, 0, SCREEN_WIDTH, SCREEN_HEIGHT);

    const cx = SCREEN_WIDTH / 2;
    const layout = this.computeLayout();
    const top = layout.top;
    const step = layout.step;
    const w = 340, h = layout.h;

    this.items.forEach((item, i) => {
      const y = top + i * step;
      const on = i === this.sel;
      const enabled = item.enabled !== false;

      g.fillStyle(enabled ? MENU_COLORS.panel : 0x0e0f16, on && enabled ? 1 : 0.75);
      g.fillRect(cx - w / 2, y - h / 2, w, h);
      g.lineStyle(on && enabled ? 2 : 1, enabled ? (on ? MENU_COLORS.borderHot : MENU_COLORS.border) : MENU_COLORS.border, 1);
      g.strokeRect(cx - w / 2, y - h / 2, w, h);
      // A short accent bar on the selected row, so selection reads at a glance even
      // for the colour-blind or on a washed-out display.
      if (on && enabled) {
        g.fillStyle(MENU_COLORS.accent, 1);
        g.fillRect(cx - w / 2, y - h / 2, 3, h);
      }

      const label = this.labels[i];
      const sub = this.sublabels[i];
      if (label) label.setColor(!enabled ? '#3d4159' : (on ? '#ffffff' : '#dfe4ff'));
      if (sub) sub.setColor(!enabled ? '#2f3346' : (on ? '#8fa0c8' : '#6b7191'));
    });

    // Typed text for the join/create screens, with a blinking caret.
    if (this.screen === 'join' || this.screen === 'create') {
      const caret = Math.floor(this.time.now / 500) % 2 === 0 ? '_' : ' ';
      this.subText.setText(`${this.screenDef(this.screen).sub}\n\n> ${this.typed}${caret}`);
    }

    if (this.notice) {
      this.noticeText.setText(this.notice);
      this.noticeText.setColor('#8a8fae');
    }
  }

  // ---------- input ----------

  moveSelection(dir) {
    if (!this.items.length) return;
    let i = this.sel;
    for (let n = 0; n < this.items.length; n++) {
      i = (i + dir + this.items.length) % this.items.length;
      if (this.items[i].enabled !== false) { this.sel = i; GameAudio.menuMove(); break; }
    }
    this.draw();
  }

  activate(index) {
    const item = this.items[index];
    if (!item) return;
    if (item.enabled === false) {
      this.notify(`${item.label} is not available yet.`);
      return;
    }
    GameAudio.menuConfirm();
    item.act();
  }

  notify(message) {
    this.notice = message;
    this.noticeText.setText(message);
    this.noticeText.setColor('#ffcc66');
    this.noticeUntil = this.time.now + 2600;
  }

  onKey(event) {
    const key = event.key;
    const def = this.screenDef(this.screen);

    // Text entry screens consume printable characters and Backspace.
    if (def.text) {
      if (key === 'Backspace') { this.typed = this.typed.slice(0, -1); this.draw(); return; }
      if (key === 'Enter') { this.activate(0); return; }
      if (key.length === 1 && /[a-zA-Z0-9 _-]/.test(key) && this.typed.length < 24) {
        this.typed += key;
        this.draw();
        return;
      }
      if (key === 'Escape') { this.showScreen('multiplayer'); return; }
      return;
    }

    if (key === 'ArrowUp' || key === 'w' || key === 'W') { this.moveSelection(-1); return; }
    if (key === 'ArrowDown' || key === 's' || key === 'S') { this.moveSelection(1); return; }
    if (key === 'Enter' || key === ' ') { this.activate(this.sel); return; }
    if (key === 'Escape') {
      if (this.screen === 'main') return;
      this.showScreen(this.screen === 'singleplayer' || this.screen === 'multiplayer' ? 'main' : 'multiplayer');
    }
  }

  // ---------- lifecycle ----------

  startGame(data) {
    if (this.scene.get('sand')) this.scene.stop('sand');
    this.scene.start('sand', data);
  }

  update(time, delta) {
    const dt = Math.min(delta, 33) / 1000;
    this.fx.update(dt);

    // Slow drifting embers behind the menu, cycling through the element palette so
    // the front-end already looks like the magic it is advertising.
    this.ambientTimer -= dt;
    if (this.ambientTimer <= 0) {
      this.ambientTimer = 0.14;
      const elements = ['Fire', 'Water', 'Earth', 'Lightning', 'Dark', 'Arcane'];
      const el = elements[(Math.random() * elements.length) | 0];
      this.fx.burst(
        Math.random() * SCREEN_WIDTH,
        SCREEN_HEIGHT + 8,
        1, el,
        { speed: 8, life: 5.5, rise: 22, size: 1.1, spread: 0.6, angle: -Math.PI / 2 },
      );
    }
    this.fx.gfx.setScrollFactor(0);
    this.fx.draw();

    if (this.noticeUntil && time > this.noticeUntil) {
      this.noticeUntil = 0;
      this.notice = this.screenDef(this.screen).notice || '';
      this.noticeText.setColor('#8a8fae');
      this.noticeText.setText(this.notice);
    }
    // Caret blink and hp-fade both need a redraw; cheap at this scale.
    if (this.screen === 'join' || this.screen === 'create') this.draw();
  }
}
