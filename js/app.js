// ── Yak Battle — main application controller ──────────────────────────────────

// Timeout handles for the current battle's event/render chain; cancelled on new battle start.
let _pendingBattleTimeouts = [];

// ── App state ─────────────────────────────────────────────────────────────────
const S = {
  playerName:    'Trainer',
  opponentName:  'Opponent',
  isHost:        false,
  myTeam:        [],    // array of 3 battle creature objects
  oppTeam:       [],    // array of 3 battle creature objects
  myActiveIdx:   0,
  oppActiveIdx:  0,
  myConfirmed:   false,
  oppConfirmed:  false,
  myPendingAction:    null,  // { type: 'move', moveIndex } | { type: 'switch', targetIdx }
  guestPendingAction: null,  // host only
  turnActive:         false,
  myForcedSwitch:     false,
  oppForcedSwitch:    false,
  _mySelectedTeam:    [],    // [{id, variant, ability, moves}, ...] built during select screen
  _pendingPreviewId:  null,
  _pendingVariant:    null,
  _pendingAbility:    null,
  _pendingMoves:      [],
  _oppTeamData:       null,  // [{id, variant, ability}, ...] from opponent's creature-ready
};

// ── Screen management ─────────────────────────────────────────────────────────

function showScreen(name) {
  document.querySelectorAll('.screen').forEach(el => el.classList.remove('active'));
  document.getElementById('screen-' + name).classList.add('active');
  const showExit = name === 'select' || name === 'battle';
  document.getElementById('btn-exit').classList.toggle('hidden', !showExit);
}

// ── Utility ───────────────────────────────────────────────────────────────────

function esc(str) {
  return String(str).replace(/[&<>"']/g, c => ({ '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;' }[c]));
}

function playerName() {
  return document.getElementById('player-name').value.trim() || 'Trainer';
}

// ── Team persistence (localStorage) ──────────────────────────────────────────

const TEAM_STORAGE_KEY = 'yak-battle-saved-team';

function _saveTeam() {
  try { localStorage.setItem(TEAM_STORAGE_KEY, JSON.stringify(S._mySelectedTeam)); } catch { /* private mode / quota */ }
}

function _loadSavedTeam() {
  try {
    const raw = localStorage.getItem(TEAM_STORAGE_KEY);
    if (!raw) return [];
    const team = JSON.parse(raw);
    if (!Array.isArray(team)) return [];
    return team.filter(entry => {
      if (!entry?.id || !Array.isArray(entry.moves) || entry.moves.length !== 4) return false;
      if (!CREATURES.find(c => c.id === entry.id)) return false;
      if (!entry.moves.every(m => MOVE_POOL[m])) return false;
      if (entry.ability && !ABILITIES[entry.ability]) return false;
      return true;
    }).slice(0, 3);
  } catch { return []; }
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
        netCloseRoom();
        netSend({ type: 'hello-ack', name: S.playerName });
        enterCreatureSelect();
      }
      break;

    case 'hello-ack':
      S.opponentName = esc(msg.name);
      enterCreatureSelect();
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
        S.guestPendingAction = msg.action;
        _tryHostResolve();
      }
      break;

    case 'forced-switch':
      // Opponent chose a new creature after their mon fainted
      S.oppActiveIdx    = msg.targetIdx;
      S.oppForcedSwitch = false;
      // Apply Intimidate from opponent's incoming creature onto my active
      const incomingOpp = S.oppTeam[msg.targetIdx];
      if (incomingOpp.ability === 'Intimidate') {
        const myActive = S.myTeam[S.myActiveIdx];
        if (!myActive.stages) myActive.stages = { atk:0, def:0, spd:0 };
        myActive.stages.atk = Math.max(-6, (myActive.stages.atk ?? 0) - 1);
        _log(`${incomingOpp.name}'s <b>Intimidate</b> lowered ${myActive.name}'s Attack!`);
      }
      _renderActiveCreatures();
      _renderTeamIndicators();
      _log(`${S.opponentName} sent out <b>${esc(S.oppTeam[msg.targetIdx].name)}</b>!`);
      _checkReadyForNextTurn();
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

document.getElementById('btn-exit').addEventListener('click', () => {
  _pendingBattleTimeouts.forEach(clearTimeout);
  _pendingBattleTimeouts = [];
  netDisconnect();
  showScreen('lobby');
});

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
  S.myConfirmed       = false;
  S.oppConfirmed      = false;
  S._mySelectedTeam   = _loadSavedTeam();
  S._pendingPreviewId = null;
  S._pendingVariant   = null;
  S._pendingAbility   = null;
  S._pendingMoves     = [];
  showScreen('select');
  document.getElementById('opp-select-status').textContent = 'Opponent is selecting…';
  document.getElementById('select-preview').classList.add('hidden');
  _renderTeamSlots();
  _updateConfirmBtn();
  _refreshCardBadges();

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

function _renderTeamSlots() {
  const slotsEl = document.getElementById('team-slots');
  slotsEl.innerHTML = '';
  for (let i = 0; i < 3; i++) {
    const entry = S._mySelectedTeam[i];
    const div   = document.createElement('div');
    div.className = 'team-slot' + (entry ? ' filled' : '');
    if (entry) {
      const c = CREATURES.find(x => x.id === entry.id);
      div.innerHTML = `
        <img src="${entry.variant || c.sprite}" alt="${esc(c.name)}">
        <span>${esc(c.name)}</span>
        <button class="slot-remove" data-slot="${i}" title="Remove">✕</button>
      `;
      div.querySelector('.slot-remove').addEventListener('click', (e) => {
        e.stopPropagation();
        _removeFromTeam(i);
      });
    } else {
      div.innerHTML = `<span class="slot-num">${i + 1}</span>`;
    }
    slotsEl.appendChild(div);
  }
}

function _addToTeam() {
  if (S._mySelectedTeam.length >= 3) return;
  if (!S._pendingPreviewId) return;
  if (S._mySelectedTeam.some(x => x.id === S._pendingPreviewId)) return;
  const _c = CREATURES.find(x => x.id === S._pendingPreviewId);
  const ability = S._pendingAbility ?? (_c?.abilities?.[0] ?? null);
  if (_c?.movesPool?.length && S._pendingMoves.length !== 4) return;
  S._mySelectedTeam.push({ id: S._pendingPreviewId, variant: S._pendingVariant, ability, moves: [...S._pendingMoves] });
  _saveTeam();
  _renderTeamSlots();
  _updateConfirmBtn();
  _refreshCardBadges();
}

function _removeFromTeam(slotIdx) {
  S._mySelectedTeam.splice(slotIdx, 1);
  _saveTeam();
  _renderTeamSlots();
  _updateConfirmBtn();
  _refreshCardBadges();
  if (S._pendingPreviewId) _selectCard(S._pendingPreviewId);
}

function _updateConfirmBtn() {
  const n   = S._mySelectedTeam.length;
  const btn = document.getElementById('btn-confirm-select');
  btn.disabled    = n < 3 || S.myConfirmed;
  btn.textContent = `CONFIRM (${n}/3)`;
}

function _refreshCardBadges() {
  const onTeamIds = new Set(S._mySelectedTeam.map(x => x.id));
  document.querySelectorAll('.creature-card').forEach(card => {
    card.classList.toggle('on-team', onTeamIds.has(card.dataset.id));
  });
}

function _selectCard(id) {
  if (S.myConfirmed) return;
  document.querySelectorAll('.creature-card').forEach(c => c.classList.remove('selected'));
  const card = document.querySelector(`.creature-card[data-id="${id}"]`);
  card.classList.add('selected');

  const c = CREATURES.find(x => x.id === id);

  // Reset variant/ability/moves only when switching to a new creature
  if (S._pendingPreviewId !== id) {
    const teamEntry = S._mySelectedTeam.find(x => x.id === id);
    S._pendingVariant = teamEntry ? teamEntry.variant : c.sprite;
    S._pendingAbility = teamEntry ? teamEntry.ability : (c.abilities?.[0] ?? null);
    S._pendingMoves   = teamEntry ? [...teamEntry.moves] : [];
  }
  S._pendingPreviewId = id;

  const onTeam       = S._mySelectedTeam.some(x => x.id === id);
  const teamFull     = S._mySelectedTeam.length >= 3;
  const currentVariant = S._pendingVariant || c.sprite;

  const preview = document.getElementById('select-preview');
  preview.innerHTML = `
    <img src="${currentVariant}" alt="${esc(c.name)}" id="preview-sprite-img">
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
          ${c.variants.map(v => `<img src="${v}" class="variant-thumb${v === currentVariant ? ' active' : ''}" data-variant="${v}" title="${v}">`).join('')}
        </div>
      ` : ''}
      <div class="preview-moves">
        ${(c.movesPool ?? []).slice(0, 4).map(mvName => {
          const m = MOVE_POOL[mvName];
          if (!m) return '';
          return `<span class="move-pill" style="border-color:${getTypeColor(m.type)}">${esc(mvName)}</span>`;
        }).join('')}
      </div>
      ${c.abilities?.length ? `
        <div class="ability-picker">
          <span class="ability-picker-label">ABILITY</span>
          ${c.abilities.map(ab => `
            <button class="ability-choice-btn${ab === (S._mySelectedTeam.find(x=>x.id===id)?.ability ?? c.abilities[0]) ? ' active' : ''}" data-ability="${esc(ab)}">
              <span class="ability-choice-name">${esc(ab)}</span>
              <span class="ability-choice-desc">${esc(ABILITIES[ab]?.desc ?? '')}</span>
            </button>
          `).join('')}
        </div>
      ` : ''}
      ${c.movesPool?.length ? `
        <div class="move-picker-section">
          <div class="move-picker-label">MOVES <span class="move-pick-count" id="mpc-count">${S._pendingMoves.length}/4</span></div>
          <div class="move-picker-grid">
            ${c.movesPool.map(moveName => {
              const m = MOVE_POOL[moveName];
              if (!m) return '';
              const sel = S._pendingMoves.includes(moveName);
              return `<button class="move-pick-btn${sel ? ' active' : ''}" data-move="${esc(moveName)}">
                <span class="move-pick-name">${esc(moveName)}</span>
                <span class="type-badge" style="background:${getTypeColor(m.type)}">${m.type}</span>
                <span class="move-pick-power">${m.power > 0 ? 'PWR ' + m.power : 'STATUS'}</span>
              </button>`;
            }).join('')}
          </div>
        </div>
      ` : ''}
    </div>
  `;

  preview.querySelectorAll('.move-pick-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      if (S.myConfirmed) return;
      const mv = btn.dataset.move;
      const idx = S._pendingMoves.indexOf(mv);
      if (idx >= 0) {
        S._pendingMoves.splice(idx, 1);
        btn.classList.remove('active');
      } else if (S._pendingMoves.length < 4) {
        S._pendingMoves.push(mv);
        btn.classList.add('active');
      }
      const countEl = document.getElementById('mpc-count');
      if (countEl) countEl.textContent = S._pendingMoves.length + '/4';
      const teamIdx2 = S._mySelectedTeam.findIndex(x => x.id === id);
      if (teamIdx2 >= 0) { S._mySelectedTeam[teamIdx2].moves = [...S._pendingMoves]; _saveTeam(); }
      const needMoves2 = !!(c.movesPool?.length);
      addBtn.disabled = !onTeam && (teamFull || (needMoves2 && S._pendingMoves.length !== 4));
      _updateConfirmBtn();
    });
  });

  preview.querySelectorAll('.ability-choice-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      if (S.myConfirmed) return;
      const ab = btn.dataset.ability;
      S._pendingAbility = ab;
      preview.querySelectorAll('.ability-choice-btn').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      const teamIdx = S._mySelectedTeam.findIndex(x => x.id === id);
      if (teamIdx >= 0) { S._mySelectedTeam[teamIdx].ability = ab; _saveTeam(); }
    });
  });

  preview.querySelectorAll('.variant-thumb').forEach(img => {
    img.addEventListener('click', () => {
      S._pendingVariant = img.dataset.variant;
      preview.querySelectorAll('.variant-thumb').forEach(i => i.classList.remove('active'));
      img.classList.add('active');
      document.getElementById('preview-sprite-img').src = S._pendingVariant;
      const teamIdx = S._mySelectedTeam.findIndex(x => x.id === id);
      if (teamIdx >= 0) {
        S._mySelectedTeam[teamIdx].variant = S._pendingVariant;
        _saveTeam();
        _renderTeamSlots();
      }
    });
  });

  const addBtn = document.createElement('button');
  addBtn.className   = 'btn btn-sm ' + (onTeam ? 'btn-danger' : 'btn-primary');
  addBtn.style.marginTop = '8px';
  addBtn.textContent = onTeam ? '\u2715 REMOVE' : (teamFull ? 'TEAM FULL' : '\uff0b ADD TO TEAM');
  const needMoves = !!(c.movesPool?.length);
  addBtn.disabled    = !onTeam && (teamFull || (needMoves && S._pendingMoves.length !== 4));
  addBtn.addEventListener('click', () => {
    if (onTeam) {
      _removeFromTeam(S._mySelectedTeam.findIndex(x => x.id === id));
    } else {
      _addToTeam();
      _selectCard(id);
    }
  });
  preview.querySelector('.preview-info').appendChild(addBtn);
  preview.classList.remove('hidden');
}

document.getElementById('btn-confirm-select').addEventListener('click', () => {
  if (S._mySelectedTeam.length < 3 || S.myConfirmed) return;
  S.myConfirmed = true;
  document.getElementById('btn-confirm-select').textContent = 'WAITING…';
  document.getElementById('btn-confirm-select').disabled = true;
  netSend({ type: 'creature-ready', team: S._mySelectedTeam });
  if (S.isHost) _maybeStartBattle();
});

function _maybeStartBattle() {
  if (!S.isHost || !S.myConfirmed || !S.oppConfirmed) return;
  if (!S._oppTeamData) return;
  const battleMsg = {
    type:      'battle-start',
    hostTeam:  S._mySelectedTeam,
    guestTeam: S._oppTeamData,
  };
  netSend(battleMsg);
  startBattle(battleMsg);
}

// Intercept creature-ready to capture opponent team before handleMessage runs
netSetHandlers({
  onMessage: (msg) => {
    if (msg.type === 'creature-ready') {
      S._oppTeamData = msg.team;
    }
    handleMessage(msg);
  },
  onDisconnect: handleDisconnect,
});

// ── Battle screen ─────────────────────────────────────────────────────────────

function startBattle(msg) {
  // Cancel any leftover event callbacks from a previous battle
  _pendingBattleTimeouts.forEach(clearTimeout);
  _pendingBattleTimeouts = [];
  document.getElementById('battle-waiting').classList.add('hidden');

  const myTeamData  = S.isHost ? msg.hostTeam  : msg.guestTeam;
  const oppTeamData = S.isHost ? msg.guestTeam : msg.hostTeam;

  S.myTeam  = myTeamData.map(entry => {
    const c = CREATURES.find(x => x.id === entry.id);
    return buildBattleCreature(c, entry.variant || c.sprite, entry.ability, entry.moves);
  });
  S.oppTeam = oppTeamData.map(entry => {
    const c = CREATURES.find(x => x.id === entry.id);
    return buildBattleCreature(c, entry.variant || c.sprite, entry.ability, entry.moves);
  });

  S.myActiveIdx        = 0;
  S.oppActiveIdx       = 0;
  S.myPendingAction    = null;
  S.guestPendingAction = null;
  S.turnActive         = false;
  S.myForcedSwitch     = false;
  S.oppForcedSwitch    = false;

  showScreen('battle');
  document.getElementById('battle-log').innerHTML = '';
  _renderBattleUI();
  _log(`Battle start! ${S.playerName} vs ${S.opponentName}!`);
  _setBattleActionsEnabled(true);
}

function _renderBattleUI() {
  _renderActiveCreatures();
  _renderMoveButtons();
  _renderTeamIndicators();
}

function _renderActiveCreatures() {
  const my  = S.myTeam[S.myActiveIdx];
  const opp = S.oppTeam[S.oppActiveIdx];

  document.getElementById('opp-creature-name').textContent = opp.name;
  document.getElementById('opp-trainer-name').textContent  = S.opponentName;
  _setTypeBadge('opp-type-badge', opp.type);
  document.getElementById('opp-sprite').src = opp.sprite;
  document.getElementById('opp-sprite').classList.remove('fainted');
  _updateHpBar('opp', opp.currentHp, opp.maxHp);
  _updateStatusBadge('opp', opp.status);
  _updateAbilityBadge('opp', opp.ability);

  document.getElementById('my-creature-name').textContent = my.name;
  document.getElementById('my-trainer-name').textContent  = S.playerName;
  _setTypeBadge('my-type-badge', my.type);
  document.getElementById('my-sprite').src = my.sprite;
  document.getElementById('my-sprite').classList.remove('fainted');
  _updateHpBar('my', my.currentHp, my.maxHp);
  _updateStatusBadge('my', my.status);
  _updateAbilityBadge('my', my.ability);
}

function _renderMoveButtons() {
  const my = S.myTeam[S.myActiveIdx];
  const container = document.getElementById('move-buttons');
  container.innerHTML = '';
  my.moves.forEach((move, i) => {
    const btn = document.createElement('button');
    btn.className = 'move-btn';
    btn.dataset.index = i;
    btn.innerHTML = `
      <span class="move-btn-name">${esc(move.name)}</span>
      <span class="type-badge move-btn-type" style="background:${getTypeColor(move.type)}">${move.type}</span>
      <span class="move-btn-power">${move.power > 0 ? `PWR ${move.power}` : 'STATUS'}</span>
    `;
    btn.addEventListener('click', () => _onActionPicked({ type: 'move', moveIndex: i }));
    container.appendChild(btn);
  });
}

function _renderTeamIndicators() {
  for (const [prefix, team, activeIdx] of [['my', S.myTeam, S.myActiveIdx], ['opp', S.oppTeam, S.oppActiveIdx]]) {
    const el = document.getElementById(prefix + '-team-indicator');
    if (!el) continue;
    el.innerHTML = team.map((c, i) => {
      const cls = c.currentHp <= 0 ? 'fainted' : i === activeIdx ? 'active' : 'alive';
      return `<span class="team-dot ${cls}" title="${esc(c.name)}"></span>`;
    }).join('');
  }
}

function _onActionPicked(action) {
  if (S.turnActive) return;
  S.turnActive      = true;
  S.myPendingAction = action;
  _setBattleActionsEnabled(false);
  document.getElementById('battle-waiting').classList.remove('hidden');

  if (S.isHost) {
    _tryHostResolve();
  } else {
    netSend({ type: 'move', action });
  }
}

function _tryHostResolve() {
  if (S.myPendingAction === null || S.guestPendingAction === null) return;
  const result = resolveTurn(
    S.myTeam, S.oppTeam,
    S.myActiveIdx, S.oppActiveIdx,
    S.myPendingAction, S.guestPendingAction
  );
  S.myPendingAction    = null;
  S.guestPendingAction = null;
  netSend({ type: 'turn-result', ...result });
  _applyResult(result);
}

function _applyResult(result) {
  document.getElementById('battle-waiting').classList.add('hidden');

  const myTeamHp      = S.isHost ? result.hostTeamHp      : result.guestTeamHp;
  const oppTeamHp     = S.isHost ? result.guestTeamHp     : result.hostTeamHp;
  const myTeamStatus  = S.isHost ? result.hostTeamStatus  : result.guestTeamStatus;
  const oppTeamStatus = S.isHost ? result.guestTeamStatus : result.hostTeamStatus;

  myTeamHp.forEach((hp, i)      => { S.myTeam[i].currentHp  = hp; });
  oppTeamHp.forEach((hp, i)     => { S.oppTeam[i].currentHp = hp; });
  myTeamStatus.forEach((st, i)  => { S.myTeam[i].status     = st; });
  oppTeamStatus.forEach((st, i) => { S.oppTeam[i].status    = st; });

  // Apply stat stages and ability state returned by host
  const myStages     = S.isHost ? result.hostTeamStages     : result.guestTeamStages;
  const oppStages    = S.isHost ? result.guestTeamStages    : result.hostTeamStages;
  const myAbilState  = S.isHost ? result.hostTeamAbilState  : result.guestTeamAbilState;
  const oppAbilState = S.isHost ? result.guestTeamAbilState : result.hostTeamAbilState;
  if (myStages)     myStages.forEach((s, i)     => { S.myTeam[i].stages = s; });
  if (oppStages)    oppStages.forEach((s, i)    => { S.oppTeam[i].stages = s; });
  if (myAbilState)  myAbilState.forEach((s, i)  => { Object.assign(S.myTeam[i],  s); });
  if (oppAbilState) oppAbilState.forEach((s, i) => { Object.assign(S.oppTeam[i], s); });

  // Reflect voluntary switches that happened during the turn
  S.myActiveIdx  = S.isHost ? result.hostActiveIdx  : result.guestActiveIdx;
  S.oppActiveIdx = S.isHost ? result.guestActiveIdx : result.hostActiveIdx;

  let delay = 0;
  result.events.forEach(ev => {
    _pendingBattleTimeouts.push(setTimeout(() => _showEvent(ev), delay));
    delay += 600;
  });

  _pendingBattleTimeouts.push(setTimeout(() => {
    _renderActiveCreatures();
    _renderTeamIndicators();

    const goEvent = result.events.find(e => e.type === 'game-over');
    if (goEvent) {
      const iWin = (goEvent.winner === 'host') === S.isHost;
      _pendingBattleTimeouts.push(setTimeout(() => _showGameOver(iWin), 800));
      return;
    }

    const myFainted  = S.myTeam[S.myActiveIdx].currentHp  <= 0;
    const oppFainted = S.oppTeam[S.oppActiveIdx].currentHp <= 0;
    S.myForcedSwitch  = myFainted  && S.myTeam.some(c  => c.currentHp > 0);
    S.oppForcedSwitch = oppFainted && S.oppTeam.some(c => c.currentHp > 0);

    if (S.myForcedSwitch) {
      _showSwitchPanel(true);
    } else {
      _checkReadyForNextTurn();
    }
  }, delay + 200));
}

function _checkReadyForNextTurn() {
  if (S.myForcedSwitch || S.oppForcedSwitch) return;
  S.turnActive      = false;
  S.myPendingAction = null;
  _setBattleActionsEnabled(true);
  _renderMoveButtons();
}

function _showSwitchPanel(forced) {
  const panel     = document.getElementById('switch-panel');
  const options   = document.getElementById('switch-options');
  const forcedMsg = document.getElementById('switch-forced-msg');
  const cancelBtn = document.getElementById('btn-cancel-switch');

  forcedMsg.classList.toggle('hidden', !forced);
  cancelBtn.classList.toggle('hidden', forced);

  options.innerHTML = '';
  S.myTeam.forEach((c, i) => {
    if (i === S.myActiveIdx) return;
    const btn = document.createElement('button');
    btn.className = 'switch-option-btn';
    btn.disabled  = c.currentHp <= 0;
    btn.innerHTML = `
      <img src="${c.sprite}" alt="${esc(c.name)}">
      <span class="switch-name">${esc(c.name)}</span>
      <span class="switch-hp">${Math.max(0, c.currentHp)}/${c.maxHp} HP</span>
    `;
    btn.addEventListener('click', () => _performSwitch(i, forced));
    options.appendChild(btn);
  });

  panel.classList.remove('hidden');
  _setBattleActionsEnabled(false);
}

function _performSwitch(targetIdx, forced) {
  document.getElementById('switch-panel').classList.add('hidden');

  if (forced) {
    S.myActiveIdx    = targetIdx;
    S.myForcedSwitch = false;
    // Apply Intimidate from incoming creature onto opponent's active
    const incomingMy = S.myTeam[targetIdx];
    if (incomingMy.ability === 'Intimidate') {
      const oppActive = S.oppTeam[S.oppActiveIdx];
      if (!oppActive.stages) oppActive.stages = { atk:0, def:0, spd:0 };
      oppActive.stages.atk = Math.max(-6, (oppActive.stages.atk ?? 0) - 1);
      _log(`${incomingMy.name}'s <b>Intimidate</b> lowered ${oppActive.name}'s Attack!`);
    }
    netSend({ type: 'forced-switch', targetIdx });
    _renderActiveCreatures();
    _renderMoveButtons();
    _renderTeamIndicators();
    _log(`${S.playerName} sent out <b>${esc(S.myTeam[targetIdx].name)}</b>!`);
    _checkReadyForNextTurn();
  } else {
    _onActionPicked({ type: 'switch', targetIdx });
  }
}

document.getElementById('btn-switch').addEventListener('click', () => {
  if (S.turnActive) return;
  _showSwitchPanel(false);
});

document.getElementById('btn-cancel-switch').addEventListener('click', () => {
  document.getElementById('switch-panel').classList.add('hidden');
  _setBattleActionsEnabled(true);
});

// ── Battle event display ──────────────────────────────────────────────────────

function _showEvent(ev) {
  const myActive  = S.myTeam[S.myActiveIdx];
  const oppActive = S.oppTeam[S.oppActiveIdx];

  switch (ev.type) {
    case 'switch': {
      const isMe  = (ev.side === 'host') === S.isHost;
      const team  = isMe ? S.myTeam : S.oppTeam;
      const trainer = isMe ? S.playerName : S.opponentName;
      _log(`${trainer} switched in <b>${esc(team[ev.toIdx].name)}</b>!`);
      break;
    }
    case 'no-effect': {
      const atkIsMe = (ev.attacker === 'host') === S.isHost;
      const name    = atkIsMe ? myActive.name : oppActive.name;
      _log(`${name} used <b>${esc(ev.moveName)}</b>… but it had no effect!`);
      break;
    }
    case 'damage': {
      const atkIsMe = (ev.attacker === 'host') === S.isHost;
      const defIsMe = (ev.defender === 'host') === S.isHost;
      const atkName = atkIsMe ? myActive.name : oppActive.name;
      const defName = defIsMe ? myActive.name : oppActive.name;
      let msg = `${atkName} used <b>${esc(ev.moveName)}</b>! ${defName} took <b>${ev.damage}</b> damage.`;
      if (ev.isCrit) msg += ' <em>Critical hit!</em>';
      if (ev.effectiveness > 1)  msg += ' <em>Super effective!</em>';
      if (ev.effectiveness < 1)  msg += ' <em>Not very effective…</em>';
      _log(msg);
      _lungeSprite(atkIsMe ? 'my' : 'opp');
      setTimeout(() => _impactSprite(defIsMe ? 'my' : 'opp'), 220);
      break;
    }
    case 'missed':
      _log(`${esc(ev.moveName)} missed!`);
      break;
    case 'heal': {
      const isMe = (ev.target === 'host') === S.isHost;
      const name = isMe ? myActive.name : oppActive.name;
      _log(`${name} used <b>${esc(ev.moveName)}</b> and recovered <b>${ev.amount}</b> HP!`);
      break;
    }
    case 'drain': {
      const isMe = (ev.target === 'host') === S.isHost;
      const name = isMe ? myActive.name : oppActive.name;
      _log(`${name} drained <b>${ev.amount}</b> HP!`);
      break;
    }
    case 'status-applied': {
      const isMe  = (ev.target === 'host') === S.isHost;
      const name  = isMe ? myActive.name : oppActive.name;
      const label = { burn: 'burned 🔥', poison: 'poisoned ☠', paralyze: 'paralyzed ⚡' }[ev.status];
      _log(`${name} was ${label}!`);
      break;
    }
    case 'status-damage': {
      const isMe = (ev.target === 'host') === S.isHost;
      const name = isMe ? myActive.name : oppActive.name;
      _log(`${name} took <b>${ev.amount}</b> damage from ${ev.status}!`);
      break;
    }
    case 'paralyzed': {
      const isMe = (ev.target === 'host') === S.isHost;
      const name = isMe ? myActive.name : oppActive.name;
      _log(`${name} is paralyzed and couldn't move!`);
      break;
    }
    case 'flinched': {
      const isMe = (ev.target === 'host') === S.isHost;
      const name = isMe ? myActive.name : oppActive.name;
      _log(`${name} flinched and couldn't move!`);
      break;
    }
    case 'cant-move': {
      const isMe = (ev.target === 'host') === S.isHost;
      const name = isMe ? myActive.name : oppActive.name;
      _log(ev.reason === 'frozen' ? `${name} is frozen solid and can't move!` : `${name} is fast asleep!`);
      break;
    }
    case 'status-cured': {
      const isMe = (ev.target === 'host') === S.isHost;
      const name = isMe ? myActive.name : oppActive.name;
      _log(ev.reason === 'thawed' ? `${name} thawed out!` : `${name} woke up!`);
      break;
    }
    case 'recoil': {
      const isMe = (ev.target === 'host') === S.isHost;
      const name = isMe ? myActive.name : oppActive.name;
      _log(`${name} was hurt by recoil! (${ev.amount} dmg)`);
      break;
    }
    case 'fainted': {
      const isMe = (ev.target === 'host') === S.isHost;
      const team = isMe ? S.myTeam : S.oppTeam;
      const name = (ev.teamIdx != null ? team[ev.teamIdx] : null)?.name
                 ?? (isMe ? myActive.name : oppActive.name);
      _log(`<b>${name} fainted!</b>`);
      document.getElementById(isMe ? 'my-sprite' : 'opp-sprite').classList.add('fainted');
      break;
    }
    case 'stat-change': {
      const isMe = (ev.target === 'host') === S.isHost;
      const name = ev.byName ?? (isMe ? myActive.name : oppActive.name);
      const labels = { atk: 'Attack', def: 'Defense', spd: 'Speed' };
      const dir = ev.change > 0 ? 'rose' : 'fell';
      const suffix = ev.ability ? ` (${ev.ability})` : '';
      _log(`${name}'s <b>${labels[ev.stat] ?? ev.stat}</b> ${dir}!${suffix}`);
      break;
    }
    case 'ability-heal': {
      const isMe = (ev.target === 'host') === S.isHost;
      const c = (ev.teamIdx != null ? (isMe ? S.myTeam : S.oppTeam)[ev.teamIdx] : null)
              ?? (isMe ? myActive : oppActive);
      _log(`${c.name} recovered <b>${ev.amount}</b> HP! (${ev.ability})`);
      break;
    }
    case 'ability-cure': {
      const isMe = (ev.target === 'host') === S.isHost;
      const c = (ev.teamIdx != null ? (isMe ? S.myTeam : S.oppTeam)[ev.teamIdx] : null)
              ?? (isMe ? myActive : oppActive);
      _log(`${c.name}'s status was cured by <b>${ev.ability}</b>!`);
      break;
    }
    case 'ability-absorb': {
      const isMe = (ev.target === 'host') === S.isHost;
      const name = isMe ? myActive.name : oppActive.name;
      if (ev.healAmount) {
        _log(`${name} absorbed ${esc(ev.moveName)} and recovered <b>${ev.healAmount}</b> HP! (${ev.ability})`);
      } else {
        _log(`${name}'s <b>${ev.ability}</b> absorbed ${esc(ev.moveName)}!`);
      }
      break;
    }
    case 'ability-triggered': {
      const isMe = (ev.target === 'host') === S.isHost;
      const name = isMe ? myActive.name : oppActive.name;
      _log(`${name} held on with <b>${ev.ability}</b>!`);
      break;
    }
    case 'contact-damage': {
      const isMe = (ev.target === 'host') === S.isHost;
      const name = isMe ? myActive.name : oppActive.name;
      _log(`${name} was hurt by ${ev.defName}'s <b>${ev.ability}</b>! (${ev.amount} dmg)`);
      break;
    }
  }
}

// ── Game-over screen ──────────────────────────────────────────────────────────

function _showGameOver(won) {
  const winTeam  = won ? S.myTeam  : S.oppTeam;
  const survivor = winTeam.find(c => c.currentHp > 0) || winTeam[0];
  document.getElementById('gameover-title').textContent  = won ? '🏆 YOU WIN!' : '💀 YOU LOSE!';
  document.getElementById('gameover-winner-sprite').src  = survivor.sprite;
  document.getElementById('gameover-result-text').textContent =
    won ? `${survivor.name} stood victorious!` : `${survivor.name} was too strong…`;
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
  S._mySelectedTeam   = [];
  S._pendingPreviewId = null;
  S._pendingVariant   = null;
  S._oppTeamData      = null;
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
  fill.className   = 'hp-fill ' + (pct > 0.5 ? 'hp-high' : pct > 0.25 ? 'hp-mid' : 'hp-low');
  text.textContent = `${Math.max(0, current)} / ${max}`;
}

function _setTypeBadge(id, type) {
  const el = document.getElementById(id);
  el.textContent      = type;
  el.style.background = getTypeColor(type);
}

function _updateStatusBadge(prefix, status) {
  const el = document.getElementById(prefix + '-status');
  if (status) {
    el.textContent = { burn: '🔥 BRN', poison: '☠ PSN', paralyze: '⚡ PAR', freeze: '❄ FRZ', sleep: '💤 SLP' }[status] ?? status;
    el.classList.remove('hidden');
  } else {
    el.classList.add('hidden');
  }
}

function _updateAbilityBadge(prefix, ability) {
  const el = document.getElementById(prefix + '-ability');
  if (!el) return;
  if (ability) {
    el.textContent = ability;
    el.classList.remove('hidden');
  } else {
    el.classList.add('hidden');
  }
}

function _setBattleActionsEnabled(enabled) {
  document.querySelectorAll('.move-btn').forEach(b => b.disabled = !enabled);
  const sw = document.getElementById('btn-switch');
  if (sw) sw.disabled = !enabled;
}

function _lungeSprite(prefix) {
  const el = document.getElementById(prefix + '-sprite');
  const cls = prefix === 'opp' ? 'lunge-flip' : 'lunge';
  el.classList.add(cls);
  setTimeout(() => el.classList.remove(cls), 480);
}

function _impactSprite(prefix) {
  const el = document.getElementById(prefix + '-sprite');
  el.classList.add('impact-flash', 'hit-shake');
  setTimeout(() => el.classList.remove('impact-flash', 'hit-shake'), 420);
}

function _shakeSprite(prefix) {
  const el = document.getElementById(prefix + '-sprite');
  el.classList.add('hit-shake');
  setTimeout(() => el.classList.remove('hit-shake'), 400);
}