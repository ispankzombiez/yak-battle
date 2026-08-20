// ── Yak Battle — main application controller ──────────────────────────────────

// ── App state ─────────────────────────────────────────────────────────────────
const S = {
  playerName:    'Trainer',
  opponentName:  'Opponent',
  isHost:        false,
  myCreature:    null,  // battle creature object (currentHp, status, etc.)
  oppCreature:   null,
  myConfirmed:   false, // creature select confirmed
  oppConfirmed:  false,
  myPendingMove: null,  // move index chosen this turn (not yet resolved)
  guestPendingMove: null, // host only: received guest's move
  turnActive:    false,
};

// ── Screen management ─────────────────────────────────────────────────────────

function showScreen(name) {
  document.querySelectorAll('.screen').forEach(el => el.classList.remove('active'));
  document.getElementById('screen-' + name).classList.add('active');
}

// ── Utility ───────────────────────────────────────────────────────────────────

function esc(str) {
  return String(str).replace(/[&<>"']/g, c => ({ '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;' }[c]));
}

function playerName() {
  return document.getElementById('player-name').value.trim() || 'Trainer';
}

// ── Network handlers ──────────────────────────────────────────────────────────

netSetHandlers({ onMessage: handleMessage, onDisconnect: handleDisconnect });

function handleDisconnect() {
  const screen = document.querySelector('.screen.active')?.id ?? '';
  if (screen !== 'screen-lobby') {
    alert('Your opponent disconnected.');
    netDisconnect();
    showScreen('lobby');
  }
}

function handleMessage(msg) {
  switch (msg.type) {

    case 'hello':
      S.opponentName = esc(msg.name);
      if (S.isHost) {
        // Guest connected — close Firebase room listing, send ack, go to select
        netCloseRoom();
        netSend({ type: 'hello-ack', name: S.playerName });
        enterCreatureSelect();
      }
      break;

    case 'hello-ack':
      S.opponentName = esc(msg.name);
      enterCreatureSelect(); // guest enters select
      break;

    case 'creature-ready':
      S.oppConfirmed = true;
      document.getElementById('opp-select-status').textContent = `${S.opponentName} is ready! ✓`;
      if (S.isHost) _maybeStartBattle();
      break;

    case 'battle-start':
      startBattle(msg);
      break;

    case 'move':
      if (S.isHost) {
        S.guestPendingMove = msg.moveIndex;
        _tryHostResolve();
      }
      break;

    case 'turn-result':
      if (!S.isHost) _applyResult(msg);
      break;

    case 'rematch-request':
      if (confirm(`${S.opponentName} wants a rematch! Accept?`)) {
        netSend({ type: 'rematch-accept' });
        _resetForRematch();
      } else {
        netSend({ type: 'rematch-decline' });
      }
      break;

    case 'rematch-accept':
      _resetForRematch();
      break;

    case 'rematch-decline':
      alert(`${S.opponentName} declined the rematch.`);
      break;
  }
}

// ── Lobby screen ──────────────────────────────────────────────────────────────

document.getElementById('btn-host-public').addEventListener('click', async () => {
  await _startHost(true);
});

document.getElementById('btn-host-private').addEventListener('click', async () => {
  await _startHost(false);
});

async function _startHost(isPublic) {
  S.playerName = playerName();
  S.isHost     = true;
  showScreen('waiting');
  document.getElementById('display-room-code').textContent = '……';
  document.getElementById('waiting-visibility').textContent = isPublic ? '(Public)' : '(Private)';

  try {
    const { code } = await netHost(S.playerName, isPublic);
    document.getElementById('display-room-code').textContent = code;
  } catch (e) {
    alert('Could not create room: ' + e.message);
    showScreen('lobby');
  }
}

document.getElementById('btn-join').addEventListener('click', async () => {
  const code = document.getElementById('join-code').value.trim().toUpperCase();
  if (code.length !== 6) { alert('Enter a 6-character room code.'); return; }
  S.playerName = playerName();
  S.isHost     = false;
  try {
    await netJoin(code);
    netSend({ type: 'hello', name: S.playerName });
  } catch (e) {
    alert(e.message || 'Failed to join. Check the code and try again.');
  }
});

document.getElementById('btn-browse').addEventListener('click', () => {
  showScreen('browse');
  loadPublicRooms();
});

document.getElementById('btn-browse-back').addEventListener('click', () => showScreen('lobby'));
document.getElementById('btn-refresh').addEventListener('click', loadPublicRooms);

document.getElementById('btn-cancel-wait').addEventListener('click', async () => {
  await netDisconnect();
  showScreen('lobby');
});

// ── Browse screen ─────────────────────────────────────────────────────────────

async function loadPublicRooms() {
  const list = document.getElementById('rooms-list');
  list.innerHTML = '<p class="empty-msg">Loading…</p>';
  const rooms = await netGetPublicRooms();

  if (rooms.length === 0) {
    list.innerHTML = '<p class="empty-msg">No open battles found. Try refreshing!</p>';
    return;
  }

  list.innerHTML = '';
  rooms.forEach(room => {
    const row = document.createElement('div');
    row.className = 'room-row';
    row.innerHTML = `
      <span class="room-host-name">${esc(room.hostName)}</span>
      <span class="room-code-label">Code: <strong>${esc(room.code)}</strong></span>
      <button class="btn btn-sm btn-accent" data-code="${esc(room.code)}">JOIN</button>
    `;
    row.querySelector('button').addEventListener('click', async (e) => {
      const code = e.target.dataset.code;
      S.playerName = playerName();
      S.isHost = false;
      try {
        await netJoin(code);
        netSend({ type: 'hello', name: S.playerName });
      } catch (err) {
        alert(err.message || 'Could not connect.');
      }
    });
    list.appendChild(row);
  });
}

// ── Creature select screen ────────────────────────────────────────────────────

function enterCreatureSelect() {
  S.myConfirmed  = false;
  S.oppConfirmed = false;
  showScreen('select');
  document.getElementById('opp-select-status').textContent = 'Opponent is selecting…';
  document.getElementById('btn-confirm-select').disabled = true;
  document.getElementById('btn-confirm-select').textContent = 'CONFIRM';

  const grid = document.getElementById('creature-grid');
  grid.innerHTML = '';

  CREATURES.forEach(c => {
    const card = document.createElement('div');
    card.className = 'creature-card';
    card.dataset.id = c.id;
    card.innerHTML = `
      <img src="${c.sprite}" alt="${esc(c.name)}" loading="lazy">
      <div class="card-name">${esc(c.name)}</div>
      <span class="type-badge" style="background:${getTypeColor(c.type)}">${c.type}</span>
      <div class="card-stats">HP ${c.hp} · SPD ${c.spd}</div>
    `;
    card.addEventListener('click', () => _selectCard(c.id));
    grid.appendChild(card);
  });
}

function _selectCard(id) {
  if (S.myConfirmed) return;
  document.querySelectorAll('.creature-card').forEach(c => c.classList.remove('selected'));
  const card = document.querySelector(`.creature-card[data-id="${id}"]`);
  card.classList.add('selected');

  const c = CREATURES.find(x => x.id === id);
  // Reset variant to default when switching creatures
  S._pendingVariant = c.sprite;

  const preview = document.getElementById('select-preview');
  preview.innerHTML = `
    <img src="${c.sprite}" alt="${esc(c.name)}" id="preview-sprite-img">
    <div class="preview-info">
      <strong>${esc(c.name)}</strong>
      <span class="type-badge" style="background:${getTypeColor(c.type)}">${c.type}</span>
      <div class="preview-stats">
        HP <b>${c.hp}</b> · ATK <b>${c.atk}</b> · DEF <b>${c.def}</b> · SPD <b>${c.spd}</b>
      </div>
      <p class="preview-desc">${esc(c.desc)}</p>
      ${c.variants && c.variants.length > 1 ? `
        <div class="variant-picker">
          <span class="variant-label">Colour:</span>
          ${c.variants.map(v => `<img src="${v}" class="variant-thumb${v === c.sprite ? ' active' : ''}" data-variant="${v}" title="${v}">`).join('')}
        </div>
      ` : ''}
      <div class="preview-moves">
        ${c.moves.map(m => `<span class="move-pill" style="border-color:${getTypeColor(m.type)}">${esc(m.name)}</span>`).join('')}
      </div>
    </div>
  `;

  // Variant click handlers
  preview.querySelectorAll('.variant-thumb').forEach(img => {
    img.addEventListener('click', () => {
      S._pendingVariant = img.dataset.variant;
      preview.querySelectorAll('.variant-thumb').forEach(i => i.classList.remove('active'));
      img.classList.add('active');
      document.getElementById('preview-sprite-img').src = S._pendingVariant;
    });
  });

  preview.classList.remove('hidden');
  document.getElementById('btn-confirm-select').disabled = false;
  S._pendingSelectId = id;
}

document.getElementById('btn-confirm-select').addEventListener('click', () => {
  if (!S._pendingSelectId || S.myConfirmed) return;
  S.myConfirmed = true;
  document.getElementById('btn-confirm-select').textContent = 'WAITING…';
  document.getElementById('btn-confirm-select').disabled = true;
  netSend({ type: 'creature-ready', creatureId: S._pendingSelectId, variant: S._pendingVariant });
  if (S.isHost) _maybeStartBattle();
});

function _maybeStartBattle() {
  if (!S.isHost || !S.myConfirmed || !S.oppConfirmed) return;
  const oppId = S._pendingOppId;
  if (!oppId) return;
  const battleMsg = {
    type: 'battle-start',
    hostCreatureId:  S._pendingSelectId,
    hostVariant:     S._pendingVariant,
    guestCreatureId: oppId,
    guestVariant:    S._pendingOppVariant,
  };
  netSend(battleMsg);
  startBattle(battleMsg);
}

// Intercept creature-ready to capture the opponent's creature ID before handleMessage runs
netSetHandlers({
  onMessage: (msg) => {
    if (msg.type === 'creature-ready') {
      S._pendingOppId      = msg.creatureId;
      S._pendingOppVariant = msg.variant || null;
    }
    handleMessage(msg);
  },
  onDisconnect: handleDisconnect,
});

// ── Battle screen ─────────────────────────────────────────────────────────────

function startBattle(msg) {
  const hostData  = CREATURES.find(c => c.id === msg.hostCreatureId);
  const guestData = CREATURES.find(c => c.id === msg.guestCreatureId);

  S.myCreature  = buildBattleCreature(
    S.isHost ? hostData  : guestData,
    S.isHost ? msg.hostVariant  : msg.guestVariant
  );
  S.oppCreature = buildBattleCreature(
    S.isHost ? guestData : hostData,
    S.isHost ? msg.guestVariant : msg.hostVariant
  );
  S.myPendingMove   = null;
  S.guestPendingMove = null;
  S.turnActive  = false;

  showScreen('battle');
  _renderBattleUI();
  _log(`Battle start! ${S.playerName}'s ${S.myCreature.name} vs ${S.opponentName}'s ${S.oppCreature.name}!`);
  _setMoveButtonsEnabled(true);
}

function _renderBattleUI() {
  // Opponent info
  document.getElementById('opp-creature-name').textContent = S.oppCreature.name;
  document.getElementById('opp-trainer-name').textContent  = S.opponentName;
  _setTypeBadge('opp-type-badge', S.oppCreature.type);
  document.getElementById('opp-sprite').src = S.oppCreature.sprite;
  _updateHpBar('opp', S.oppCreature.currentHp, S.oppCreature.maxHp);

  // My info
  document.getElementById('my-creature-name').textContent = S.myCreature.name;
  document.getElementById('my-trainer-name').textContent  = S.playerName;
  _setTypeBadge('my-type-badge', S.myCreature.type);
  document.getElementById('my-sprite').src = S.myCreature.sprite;
  _updateHpBar('my', S.myCreature.currentHp, S.myCreature.maxHp);

  // Move buttons
  const container = document.getElementById('move-buttons');
  container.innerHTML = '';
  S.myCreature.moves.forEach((move, i) => {
    const btn = document.createElement('button');
    btn.className = 'move-btn';
    btn.dataset.index = i;
    btn.innerHTML = `
      <span class="move-btn-name">${esc(move.name)}</span>
      <span class="type-badge move-btn-type" style="background:${getTypeColor(move.type)}">${move.type}</span>
      <span class="move-btn-power">${move.power > 0 ? `PWR ${move.power}` : 'STATUS'}</span>
    `;
    btn.addEventListener('click', () => _onMoveClick(i));
    container.appendChild(btn);
  });
}

function _onMoveClick(moveIndex) {
  if (S.turnActive) return;
  S.turnActive    = true;
  S.myPendingMove = moveIndex;
  _setMoveButtonsEnabled(false);
  document.getElementById('battle-waiting').classList.remove('hidden');

  if (S.isHost) {
    _tryHostResolve();
  } else {
    netSend({ type: 'move', moveIndex });
  }
}

function _tryHostResolve() {
  if (S.myPendingMove === null || S.guestPendingMove === null) return;
  const result = resolveTurn(S.myCreature, S.oppCreature, S.myPendingMove, S.guestPendingMove);
  S.myPendingMove    = null;
  S.guestPendingMove = null;
  netSend({ type: 'turn-result', ...result });
  _applyResult(result);
}

function _applyResult(result) {
  document.getElementById('battle-waiting').classList.add('hidden');

  // Update battle objects
  S.myCreature.currentHp   = S.isHost ? result.hostHp    : result.guestHp;
  S.oppCreature.currentHp  = S.isHost ? result.guestHp   : result.hostHp;
  S.myCreature.status      = S.isHost ? result.hostStatus  : result.guestStatus;
  S.oppCreature.status     = S.isHost ? result.guestStatus : result.hostStatus;

  // Animate events sequentially (simple queue with timeouts)
  let delay = 0;
  result.events.forEach(ev => {
    setTimeout(() => _showEvent(ev), delay);
    delay += 600;
  });

  // Update HP bars and check for game over after all events render
  setTimeout(() => {
    _updateHpBar('my',  S.myCreature.currentHp,  S.myCreature.maxHp);
    _updateHpBar('opp', S.oppCreature.currentHp, S.oppCreature.maxHp);
    _updateStatusBadge('my',  S.myCreature.status);
    _updateStatusBadge('opp', S.oppCreature.status);

    const goEvent = result.events.find(e => e.type === 'game-over');
    if (goEvent) {
      const iWin = (goEvent.winner === 'host') === S.isHost;
      setTimeout(() => _showGameOver(iWin), 800);
    } else {
      S.turnActive    = false;
      S.myPendingMove = null;
      _setMoveButtonsEnabled(true);
    }
  }, delay + 200);
}

function _showEvent(ev) {
  switch (ev.type) {
    case 'no-effect': {
      const atkIsMe = (ev.attacker === 'host') === S.isHost;
      const name = atkIsMe ? S.myCreature.name : S.oppCreature.name;
      _log(`${name} used <b>${esc(ev.moveName)}</b>… but it had no effect!`);
      break;
    }
    case 'damage': {
      const atkIsMe = (ev.attacker === 'host') === S.isHost;
      const defIsMe = (ev.defender === 'host') === S.isHost;
      const atkName = atkIsMe ? S.myCreature.name : S.oppCreature.name;
      const defName = defIsMe ? S.myCreature.name : S.oppCreature.name;
      let msg = `${atkName} used <b>${esc(ev.moveName)}</b>! ${defName} took <b>${ev.damage}</b> damage.`;
      if (ev.isCrit) msg += ' <em>Critical hit!</em>';
      if (ev.effectiveness > 1)  msg += " <em>Super effective!</em>";
      if (ev.effectiveness < 1)  msg += " <em>Not very effective…</em>";
      _log(msg);
      if (defIsMe) _shakeSprite('my');
      else         _shakeSprite('opp');
      break;
    }
    case 'missed':
      _log(`${esc(ev.moveName)} missed!`);
      break;
    case 'heal': {
      const isMe = (ev.target === 'host') === S.isHost;
      const name = isMe ? S.myCreature.name : S.oppCreature.name;
      _log(`${name} used <b>${esc(ev.moveName)}</b> and recovered <b>${ev.amount}</b> HP!`);
      break;
    }
    case 'drain': {
      const isMe = (ev.target === 'host') === S.isHost;
      const name = isMe ? S.myCreature.name : S.oppCreature.name;
      _log(`${name} drained <b>${ev.amount}</b> HP!`);
      break;
    }
    case 'status-applied': {
      const isMe = (ev.target === 'host') === S.isHost;
      const name = isMe ? S.myCreature.name : S.oppCreature.name;
      const label = { burn: 'burned 🔥', poison: 'poisoned ☠', paralyze: 'paralyzed ⚡' }[ev.status];
      _log(`${name} was ${label}!`);
      break;
    }
    case 'status-damage': {
      const isMe = (ev.target === 'host') === S.isHost;
      const name = isMe ? S.myCreature.name : S.oppCreature.name;
      _log(`${name} took <b>${ev.amount}</b> damage from ${ev.status}!`);
      break;
    }
    case 'paralyzed': {
      const isMe = (ev.target === 'host') === S.isHost;
      const name = isMe ? S.myCreature.name : S.oppCreature.name;
      _log(`${name} is paralyzed and couldn't move!`);
      break;
    }
    case 'flinched': {
      const isMe = (ev.target === 'host') === S.isHost;
      const name = isMe ? S.myCreature.name : S.oppCreature.name;
      _log(`${name} flinched and couldn't move!`);
      break;
    }
    case 'fainted': {
      const isMe = (ev.target === 'host') === S.isHost;
      const name = isMe ? S.myCreature.name : S.oppCreature.name;
      _log(`<b>${name} fainted!</b>`);
      const id = isMe ? 'my-sprite' : 'opp-sprite';
      document.getElementById(id).classList.add('fainted');
      break;
    }
  }
}

// ── Game-over screen ──────────────────────────────────────────────────────────

function _showGameOver(won) {
  document.getElementById('gameover-title').textContent   = won ? '🏆 YOU WIN!' : '💀 YOU LOSE!';
  document.getElementById('gameover-winner-sprite').src   = won ? S.myCreature.sprite : S.oppCreature.sprite;
  document.getElementById('gameover-result-text').textContent =
    won ? `${S.myCreature.name} stood victorious!` : `${S.oppCreature.name} was too strong…`;
  const rematchBtn = document.getElementById('btn-rematch');
  rematchBtn.textContent = '↺ REMATCH';
  rematchBtn.disabled    = false;
  showScreen('gameover');
}

document.getElementById('btn-rematch').addEventListener('click', () => {
  netSend({ type: 'rematch-request' });
  document.getElementById('btn-rematch').textContent = 'Waiting…';
  document.getElementById('btn-rematch').disabled = true;
});

document.getElementById('btn-return-lobby').addEventListener('click', async () => {
  await netDisconnect();
  showScreen('lobby');
});

function _resetForRematch() {
  S._pendingSelectId = null;
  S._pendingOppId    = null;
  enterCreatureSelect();
}

// ── UI helpers ────────────────────────────────────────────────────────────────

function _log(html) {
  const log  = document.getElementById('battle-log');
  const line = document.createElement('p');
  line.innerHTML = html;
  log.appendChild(line);
  log.scrollTop  = log.scrollHeight;
}

function _updateHpBar(prefix, current, max) {
  const pct  = max > 0 ? Math.max(0, current / max) : 0;
  const fill = document.getElementById(prefix + '-hp-fill');
  const text = document.getElementById(prefix + '-hp-text');
  fill.style.width = (pct * 100).toFixed(1) + '%';
  fill.className = 'hp-fill ' + (pct > 0.5 ? 'hp-high' : pct > 0.25 ? 'hp-mid' : 'hp-low');
  text.textContent = `${Math.max(0, current)} / ${max}`;
}

function _setTypeBadge(id, type) {
  const el = document.getElementById(id);
  el.textContent        = type;
  el.style.background   = getTypeColor(type);
}

function _updateStatusBadge(prefix, status) {
  const el = document.getElementById(prefix + '-status');
  if (status) {
    el.textContent = { burn: '🔥 BRN', poison: '☠ PSN', paralyze: '⚡ PAR' }[status] ?? status;
    el.classList.remove('hidden');
  } else {
    el.classList.add('hidden');
  }
}

function _setMoveButtonsEnabled(enabled) {
  document.querySelectorAll('.move-btn').forEach(b => b.disabled = !enabled);
}

function _shakeSprite(prefix) {
  const el = document.getElementById(prefix + '-sprite');
  el.classList.add('hit-shake');
  setTimeout(() => el.classList.remove('hit-shake'), 400);
}
