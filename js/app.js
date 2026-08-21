// ── Yak Battle — main application controller ──────────────────────────────────

// Timeout handles for the current battle's event/render chain; cancelled on new battle start.
let _pendingBattleTimeouts = [];
let _soloBuilder   = false; // true when editing team from lobby (no opponent)
let _dragSlotIdx   = null;  // source slot index during drag-and-drop

// ── Version check ─────────────────────────────────────────────────────────────
(async function _checkVersion() {
  try {
    const res = await fetch('./version.json?_=' + Date.now());
    if (!res.ok) return;
    const { version } = await res.json();
    if (version !== PAGE_VERSION) {
      document.getElementById('update-panel').classList.remove('hidden');
    }
  } catch { /* ignore network errors */ }
})();

document.getElementById('btn-update-ok').addEventListener('click', () => {
  // Redirect with a cache-busting param so browser fetches fresh index.html + scripts
  window.location.replace(location.origin + location.pathname + '?r=' + Date.now());
});

// ── App state ─────────────────────────────────────────────────────────────────
const S = {
  playerName:    'Trainer',
  opponentName:  'Opponent',
  isHost:        false,
  myLanes:       [],    // [[frontBC, backBC|null], ...] × 3
  oppLanes:      [],
  myConfirmed:   false,
  oppConfirmed:  false,
  _mySelectedTeam:    [],    // [{id, variant, ability, moves}, ...] up to 6 entries
  _pendingPreviewId:  null,
  _pendingVariant:    null,
  _pendingAbility:    null,
  _pendingMoves:      [],
  _oppTeamData:       null,  // [{id, variant, ability, moves}, ...] from opponent's creature-ready
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

// Restore saved username on page load
(function () {
  const saved = localStorage.getItem('yak-battle-username');
  if (saved) document.getElementById('player-name').value = saved;
})();

document.getElementById('player-name').addEventListener('change', () => {
  const v = document.getElementById('player-name').value.trim();
  if (v) localStorage.setItem('yak-battle-username', v);
});

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
    return team.slice(0, 6).map(entry => {
      if (!entry) return null;
      if (!entry.id || !Array.isArray(entry.moves) || entry.moves.length !== 4) return null;
      if (!CREATURES.find(c => c.id === entry.id)) return null;
      if (!entry.moves.every(m => MOVE_POOL[m])) return null;
      if (entry.ability && !ABILITIES[entry.ability]) return null;
      return entry;
    });
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
  _soloBuilder = false;
  netDisconnect();
  showScreen('lobby');
});

document.getElementById('btn-manage-team').addEventListener('click', () => {
  enterCreatureSelect(true);
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

function enterCreatureSelect(solo = false) {
  _soloBuilder        = solo;
  S.myConfirmed       = false;
  S.oppConfirmed      = false;
  S._mySelectedTeam   = _loadSavedTeam();
  S._mySelectedTeam   = Array.from({ length: 6 }, (_, i) => S._mySelectedTeam[i] ?? null);
  S._pendingPreviewId = null;
  S._pendingVariant   = null;
  S._pendingAbility   = null;
  S._pendingMoves     = [];
  showScreen('select');
  document.getElementById('opp-select-status').textContent = solo ? '' : 'Opponent is selecting…';
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

const SLOT_LABELS = ['L1 FRONT', 'L2 FRONT', 'L3 FRONT', 'L1 BACK', 'L2 BACK', 'L3 BACK'];

function _renderTeamSlots() {
  const slotsEl = document.getElementById('team-slots');
  slotsEl.innerHTML = '';
  for (let i = 0; i < 6; i++) {
    const entry = S._mySelectedTeam[i];
    const div   = document.createElement('div');
    div.className = 'team-slot' + (entry ? ' filled' : '');
    div.draggable = true;
    div.addEventListener('dragstart', e => {
      _dragSlotIdx = i;
      e.dataTransfer.effectAllowed = 'move';
      setTimeout(() => div.classList.add('dragging'), 0);
    });
    div.addEventListener('dragend', () => {
      _dragSlotIdx = null;
      document.querySelectorAll('.team-slot').forEach(s => s.classList.remove('dragging', 'drag-over'));
    });
    div.addEventListener('dragover', e => {
      if (_dragSlotIdx === i) return;
      e.preventDefault();
      e.dataTransfer.dropEffect = 'move';
      div.classList.add('drag-over');
    });
    div.addEventListener('dragleave', () => div.classList.remove('drag-over'));
    div.addEventListener('drop', e => {
      e.preventDefault();
      div.classList.remove('drag-over');
      const from = _dragSlotIdx, to = i;
      if (from === null || from === to) return;
      [S._mySelectedTeam[from], S._mySelectedTeam[to]] = [S._mySelectedTeam[to], S._mySelectedTeam[from]];
      _dragSlotIdx = null;
      _saveTeam();
      _renderTeamSlots();
      _updateConfirmBtn();
      _refreshCardBadges();
    });
    if (entry) {
      const c = CREATURES.find(x => x.id === entry.id);
      div.innerHTML = `
        <span class="slot-label">${SLOT_LABELS[i]}</span>
        <img src="${entry.variant || c.sprite}" alt="${esc(c.name)}">
        <span class="slot-name">${esc(c.name)}</span>
        <button class="slot-remove" data-slot="${i}" title="Remove">✕</button>
      `;
      div.querySelector('.slot-remove').addEventListener('click', (e) => {
        e.stopPropagation();
        _removeFromTeam(i);
      });
    } else {
      div.innerHTML = `<span class="slot-label">${SLOT_LABELS[i]}</span><span class="slot-num">${i + 1}</span>`;
    }
    slotsEl.appendChild(div);
  }
}

function _addToTeam() {
  if (!S._pendingPreviewId) return;
  if (S._mySelectedTeam.some(x => x?.id === S._pendingPreviewId)) return;
  const freeIdx = S._mySelectedTeam.findIndex(x => x === null);
  if (freeIdx === -1) return;
  const _c = CREATURES.find(x => x.id === S._pendingPreviewId);
  const ability = S._pendingAbility ?? (_c?.abilities?.[0] ?? null);
  if (_c?.movesPool?.length && S._pendingMoves.length !== 4) return;
  S._mySelectedTeam[freeIdx] = { id: S._pendingPreviewId, variant: S._pendingVariant, ability, moves: [...S._pendingMoves] };
  _saveTeam();
  _renderTeamSlots();
  _updateConfirmBtn();
  _refreshCardBadges();
}

function _removeFromTeam(slotIdx) {
  S._mySelectedTeam[slotIdx] = null;
  _saveTeam();
  _renderTeamSlots();
  _updateConfirmBtn();
  _refreshCardBadges();
  if (S._pendingPreviewId) _selectCard(S._pendingPreviewId);
}

function _updateConfirmBtn() {
  const n   = S._mySelectedTeam.filter(Boolean).length;
  const btn = document.getElementById('btn-confirm-select');
  btn.disabled    = n < 6 || (!_soloBuilder && S.myConfirmed);
  btn.textContent = _soloBuilder ? `SAVE & EXIT (${n}/6)` : `CONFIRM (${n}/6)`;
}

function _refreshCardBadges() {
  const onTeamIds = new Set(S._mySelectedTeam.filter(Boolean).map(x => x.id));
  document.querySelectorAll('.creature-card').forEach(card => {
    card.classList.toggle('on-team', onTeamIds.has(card.dataset.id));
  });
}

// Build a short human-readable description from a move's mechanical properties.
function _moveSummary(m) {
  const parts = [];
  if (m.accuracy === null)   parts.push('Always hits');
  else if (m.accuracy < 1)   parts.push(`${Math.round(m.accuracy * 100)}% acc`);
  if (m.priority > 0)        parts.push('Priority');
  if (m.highCrit)            parts.push('High crit');
  if (m.facade)              parts.push('2× if statused');
  if (m.recoil)              parts.push(`${Math.round(m.recoil * 100)}% recoil`);
  if (m.effect) {
    const pct = m.effect.chance != null && m.effect.chance < 1 ? `${Math.round(m.effect.chance * 100)}% ` : '';
    const lbl = { burn:'Burns', poison:'Poisons', paralyze:'Paralyzes', freeze:'Freezes',
                  sleep:'Sleeps', flinch:'Flinch', drain:'Drains HP', heal:'Heals user',
                  'stat-self':'Boosts self', 'stat-opp':'Drops foe' }[m.effect.type] ?? m.effect.type;
    parts.push(pct + lbl);
  }
  if (m.statEffect?.length) {
    m.statEffect.forEach(se => {
      const pct  = se.chance != null && se.chance < 1 ? `${Math.round(se.chance * 100)}% ` : '';
      const stat = { atk:'ATK', def:'DEF', spd:'SPD' }[se.stat] ?? se.stat;
      const dir  = se.change > 0 ? '↑' : '↓';
      const tgt  = se.target === 'self' ? '' : 'Foe ';
      parts.push(`${pct}${tgt}${stat}${dir}`);
    });
  }
  return parts.join(' · ');
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

  const onTeam   = S._mySelectedTeam.some(x => x?.id === id);
  const teamFull = S._mySelectedTeam.filter(Boolean).length >= 6;
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
            <button class="ability-choice-btn${ab === (S._mySelectedTeam.find(x=>x?.id===id)?.ability ?? c.abilities[0]) ? ' active' : ''}" data-ability="${esc(ab)}">
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
              const desc = _moveSummary(m);
              return `<button class="move-pick-btn${sel ? ' active' : ''}" data-move="${esc(moveName)}">
                <span class="move-pick-name">${esc(moveName)}</span>
                <span class="type-badge" style="background:${getTypeColor(m.type)}">${m.type}</span>
                <span class="move-pick-power">${m.power > 0 ? 'PWR ' + m.power : 'STATUS'}</span>
                ${desc ? `<span class="move-pick-desc">${esc(desc)}</span>` : ''}
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
      const teamIdx2 = S._mySelectedTeam.findIndex(x => x?.id === id);
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
      const teamIdx = S._mySelectedTeam.findIndex(x => x?.id === id);
      if (teamIdx >= 0) { S._mySelectedTeam[teamIdx].ability = ab; _saveTeam(); }
    });
  });

  preview.querySelectorAll('.variant-thumb').forEach(img => {
    img.addEventListener('click', () => {
      S._pendingVariant = img.dataset.variant;
      preview.querySelectorAll('.variant-thumb').forEach(i => i.classList.remove('active'));
      img.classList.add('active');
      document.getElementById('preview-sprite-img').src = S._pendingVariant;
      const teamIdx = S._mySelectedTeam.findIndex(x => x?.id === id);
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
      _removeFromTeam(S._mySelectedTeam.findIndex(x => x?.id === id));
    } else {
      _addToTeam();
      _selectCard(id);
    }
  });
  preview.querySelector('.preview-info').appendChild(addBtn);
  preview.classList.remove('hidden');
}

document.getElementById('btn-confirm-select').addEventListener('click', () => {
  if (S._mySelectedTeam.filter(Boolean).length < 6) return;
  if (_soloBuilder) {
    _soloBuilder = false;
    showScreen('lobby');
    return;
  }
  if (S.myConfirmed) return;
  S.myConfirmed = true;
  document.getElementById('btn-confirm-select').textContent = 'WAITING…';
  document.getElementById('btn-confirm-select').disabled = true;
  netSend({ type: 'creature-ready', team: S._mySelectedTeam });
  if (S.isHost) _maybeStartBattle();
});

function _maybeStartBattle() {
  if (!S.isHost || !S.myConfirmed || !S.oppConfirmed) return;
  if (!S._oppTeamData) return;
  const hostLanes  = _buildBattleLanes(S._mySelectedTeam);
  const guestLanes = _buildBattleLanes(S._oppTeamData);
  const { events } = resolveFullBattle(hostLanes, guestLanes);
  const battleMsg = {
    type:      'battle-start',
    hostTeam:  S._mySelectedTeam,
    guestTeam: S._oppTeamData,
    events,
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

// ── Battle screen (auto-battle) ───────────────────────────────────────────────

// Build [[frontBC, backBC|null], ...] × 3 from a flat 6-entry team array.
// Layout: indices 0,1,2 = fronts (lanes 0-2); indices 3,4,5 = backs (lanes 0-2).
function _buildBattleLanes(teamEntries) {
  const lanes = [];
  for (let i = 0; i < 3; i++) {
    const fe = teamEntries[i];
    const be = teamEntries[i + 3];
    const frontBC = fe ? buildBattleCreature(CREATURES.find(x => x.id === fe.id), fe.variant, fe.ability, fe.moves) : null;
    const backBC  = be ? buildBattleCreature(CREATURES.find(x => x.id === be.id), be.variant, be.ability, be.moves) : null;
    lanes.push([frontBC, backBC]);
  }
  return lanes;
}

function _startCountdown(onDone) {
  const overlay = document.getElementById('battle-countdown');
  const textEl  = document.getElementById('countdown-text');
  overlay.classList.remove('hidden');
  ['3', '2', '1', 'FIGHT!'].forEach((label, i) => {
    const t = setTimeout(() => {
      textEl.textContent = label;
      textEl.classList.remove('countdown-anim');
      void textEl.offsetWidth; // trigger reflow so animation restarts
      textEl.classList.add('countdown-anim');
    }, i * 900);
    _pendingBattleTimeouts.push(t);
  });
  const doneT = setTimeout(() => {
    overlay.classList.add('hidden');
    onDone();
  }, 3700);
  _pendingBattleTimeouts.push(doneT);
}

function startBattle(msg) {
  _pendingBattleTimeouts.forEach(clearTimeout);
  _pendingBattleTimeouts = [];
  document.getElementById('battle-countdown').classList.add('hidden');

  const myTeamData  = S.isHost ? msg.hostTeam  : msg.guestTeam;
  const oppTeamData = S.isHost ? msg.guestTeam : msg.hostTeam;

  S.myLanes  = _buildBattleLanes(myTeamData);
  S.oppLanes = _buildBattleLanes(oppTeamData);

  showScreen('battle');
  document.getElementById('battle-log').innerHTML = '';
  document.getElementById('my-trainer-name').textContent  = S.playerName;
  document.getElementById('opp-trainer-name').textContent = S.opponentName;
  _renderAllLanes();
  _log(`Battle start! ${S.playerName} vs ${S.opponentName}!`);

  if (msg.events) _startCountdown(() => _playbackBattle(msg.events));
}

function _renderAllLanes() {
  for (let i = 0; i < 3; i++) {
    _setLaneFront('my',  i, S.myLanes[i][0]);
    _setLaneFront('opp', i, S.oppLanes[i][0]);
    const mbEl = document.getElementById(`my-lane-${i}-back-sprite`);
    if (mbEl) { mbEl.src = S.myLanes[i][1]?.sprite ?? ''; mbEl.classList.toggle('hidden', !S.myLanes[i][1]); }
    const obEl = document.getElementById(`opp-lane-${i}-back-sprite`);
    if (obEl) { obEl.src = S.oppLanes[i][1]?.sprite ?? ''; obEl.classList.toggle('hidden', !S.oppLanes[i][1]); }
  }
}

function _setLaneFront(prefix, laneIdx, bc) {
  const sprEl  = document.getElementById(`${prefix}-lane-${laneIdx}-front-sprite`);
  const nameEl = document.getElementById(`${prefix}-lane-${laneIdx}-front-name`);
  if (sprEl)  { sprEl.src = bc?.sprite ?? ''; sprEl.classList.toggle('hidden', !bc); sprEl.classList.remove('fainted'); }
  if (nameEl) nameEl.textContent = bc?.name ?? '';
  if (bc) _updateLaneHpBar(prefix, laneIdx, bc.currentHp, bc.maxHp);
}

function _updateLaneHpBar(prefix, laneIdx, hp, maxHp) {
  const fill = document.getElementById(`${prefix}-lane-${laneIdx}-front-hp`);
  if (!fill) return;
  const pct = maxHp > 0 ? Math.max(0, hp / maxHp) : 0;
  fill.style.width = (pct * 100).toFixed(1) + '%';
  fill.className = 'hp-fill ' + (pct > 0.5 ? 'hp-high' : pct > 0.25 ? 'hp-mid' : 'hp-low');
}

function _playbackBattle(events) {
  let delay = 0;
  for (const ev of events) {
    const t = setTimeout(() => _showBattleEvent(ev), delay);
    _pendingBattleTimeouts.push(t);
    delay += 1100;
  }
}

function _lungeAutoSprite(prefix, lane) {
  const el = document.getElementById(`${prefix}-lane-${lane}-front-sprite`);
  if (!el) return;
  const cls = prefix === 'opp' ? 'lunge-flip' : 'lunge';
  el.classList.add(cls);
  setTimeout(() => el.classList.remove(cls), 480);
}

function _impactAutoSprite(prefix, lane) {
  const el = document.getElementById(`${prefix}-lane-${lane}-front-sprite`);
  if (!el) return;
  el.classList.add('impact-flash', 'hit-shake');
  setTimeout(() => el.classList.remove('impact-flash', 'hit-shake'), 420);
}

// ── Battle event display ──────────────────────────────────────────────────────

function _showBattleEvent(ev) {
  const mySide = S.isHost ? 'host' : 'guest';

  switch (ev.type) {
    case 'damage': {
      const atkIsMe = ev.attackerSide === mySide;
      const defIsMe = ev.defenderSide === mySide;
      const atkPfx  = atkIsMe ? 'my' : 'opp';
      const defPfx  = defIsMe ? 'my' : 'opp';
      let msg = `${esc(ev.atkName)} used <b>${esc(ev.moveName)}</b>! ${esc(ev.defName)} took <b>${ev.damage}</b> dmg.`;
      if (ev.isCrit) msg += ' <em>Critical hit!</em>';
      if (ev.effectiveness > 1)  msg += ' <em>Super effective!</em>';
      if (ev.effectiveness < 1 && ev.effectiveness > 0) msg += ' <em>Not very effective…</em>';
      _log(msg);
      _updateLaneHpBar(defPfx, ev.defenderLane, ev.defHpAfter, ev.defMaxHp);
      _lungeAutoSprite(atkPfx, ev.attackerLane);
      setTimeout(() => _impactAutoSprite(defPfx, ev.defenderLane), 220);
      break;
    }
    case 'fainted': {
      const isMe = ev.side === mySide;
      const pfx  = isMe ? 'my' : 'opp';
      _log(`<b>${esc(ev.name)} fainted!</b>`);
      const sprEl = document.getElementById(`${pfx}-lane-${ev.lane}-front-sprite`);
      if (sprEl) sprEl.classList.add('fainted');
      _updateLaneHpBar(pfx, ev.lane, 0, 1);
      break;
    }
    case 'advance': {
      const isMe = ev.side === mySide;
      const pfx  = isMe ? 'my' : 'opp';
      _log(`${esc(ev.name)} advanced to the front!`);
      const frontEl = document.getElementById(`${pfx}-lane-${ev.lane}-front-sprite`);
      const backEl  = document.getElementById(`${pfx}-lane-${ev.lane}-back-sprite`);
      const nameEl  = document.getElementById(`${pfx}-lane-${ev.lane}-front-name`);
      if (frontEl) { frontEl.src = ev.sprite; frontEl.classList.remove('fainted', 'hidden'); frontEl.classList.add('entering'); setTimeout(() => frontEl.classList.remove('entering'), 500); }
      if (backEl)  backEl.classList.add('hidden');
      if (nameEl)  nameEl.textContent = ev.name;
      if (ev.hpAfter != null) _updateLaneHpBar(pfx, ev.lane, ev.hpAfter, ev.maxHp);
      break;
    }
    case 'missed':
      _log(`${esc(ev.atkName)}'s <b>${esc(ev.moveName)}</b> missed!`);
      break;
    case 'no-effect':
      _log(`${esc(ev.atkName)} used <b>${esc(ev.moveName)}</b>… but it had no effect!`);
      break;
    case 'heal': {
      const isMe = ev.side === mySide;
      _log(`${esc(ev.name)} used <b>${esc(ev.moveName)}</b> and recovered <b>${ev.amount}</b> HP!`);
      _updateLaneHpBar(isMe ? 'my' : 'opp', ev.lane, ev.hpAfter, ev.maxHp);
      break;
    }
    case 'drain': {
      const isMe = ev.side === mySide;
      _log(`${esc(ev.name)} drained <b>${ev.amount}</b> HP!`);
      _updateLaneHpBar(isMe ? 'my' : 'opp', ev.lane, ev.hpAfter, ev.maxHp);
      break;
    }
    case 'status-applied': {
      const label = { burn: 'burned 🔥', poison: 'poisoned ☠', paralyze: 'paralyzed ⚡', freeze: 'frozen ❄', sleep: 'put to sleep 💤' }[ev.status] ?? ev.status;
      const suffix = ev.ability ? ` (${ev.ability})` : '';
      _log(`${esc(ev.name)} was ${label}!${suffix}`);
      break;
    }
    case 'status-damage': {
      const isMe = ev.side === mySide;
      _log(`${esc(ev.name)} took <b>${ev.amount}</b> damage from ${ev.status}!`);
      _updateLaneHpBar(isMe ? 'my' : 'opp', ev.lane, ev.hpAfter, ev.maxHp);
      break;
    }
    case 'paralyzed':
      _log(`${esc(ev.name)} is paralyzed and couldn't move!`);
      break;
    case 'flinched':
      _log(`${esc(ev.name)} flinched and couldn't move!`);
      break;
    case 'cant-move':
      _log(ev.reason === 'frozen' ? `${esc(ev.name)} is frozen solid!` : `${esc(ev.name)} is fast asleep!`);
      break;
    case 'status-cured':
      _log(ev.reason === 'thawed' ? `${esc(ev.name)} thawed out!` : `${esc(ev.name)} woke up!`);
      break;
    case 'recoil': {
      const isMe = ev.side === mySide;
      _log(`${esc(ev.name)} was hurt by recoil! (${ev.amount} dmg)`);
      _updateLaneHpBar(isMe ? 'my' : 'opp', ev.lane, ev.hpAfter, ev.maxHp);
      break;
    }
    case 'contact-damage': {
      const isMe = ev.side === mySide;
      _log(`${esc(ev.name)} was hurt by ${esc(ev.defName)}'s <b>${ev.ability}</b>! (${ev.amount} dmg)`);
      _updateLaneHpBar(isMe ? 'my' : 'opp', ev.lane, ev.hpAfter, ev.maxHp);
      break;
    }
    case 'stat-change': {
      const name = ev.byName ?? '???';
      const labels = { atk: 'Attack', def: 'Defense', spd: 'Speed' };
      const dir = ev.change > 0 ? 'rose' : 'fell';
      const suffix = ev.ability ? ` (${ev.ability})` : '';
      _log(`${esc(name)}'s <b>${labels[ev.stat] ?? ev.stat}</b> ${dir}!${suffix}`);
      break;
    }
    case 'ability-heal': {
      const isMe = ev.side === mySide;
      _log(`${esc(ev.name)} recovered <b>${ev.amount}</b> HP! (${ev.ability})`);
      _updateLaneHpBar(isMe ? 'my' : 'opp', ev.lane, ev.hpAfter, ev.maxHp);
      break;
    }
    case 'ability-cure':
      _log(`${esc(ev.name)}'s status was cured by <b>${ev.ability}</b>!`);
      break;
    case 'ability-absorb': {
      const isMe = ev.side === mySide;
      if (ev.healAmount) {
        _log(`${esc(ev.defName)} absorbed ${esc(ev.moveName)} and recovered <b>${ev.healAmount}</b> HP! (${ev.ability})`);
        _updateLaneHpBar(isMe ? 'my' : 'opp', ev.lane, ev.hpAfter, ev.maxHp);
      } else {
        _log(`${esc(ev.defName)}'s <b>${ev.ability}</b> absorbed ${esc(ev.moveName)}!`);
      }
      break;
    }
    case 'ability-triggered':
      _log(`${esc(ev.name)} held on with <b>${ev.ability}</b>!`);
      break;
    case 'game-over': {
      const iWin = (ev.winner === 'host') === S.isHost;
      const t = setTimeout(() => _showGameOver(iWin, ev.survivorSprite, ev.survivorName), 600);
      _pendingBattleTimeouts.push(t);
      break;
    }
  }
}

// ── Game-over screen ──────────────────────────────────────────────────────────

function _showGameOver(won, survivorSprite, survivorName) {
  document.getElementById('gameover-title').textContent  = won ? '🏆 YOU WIN!' : '💀 YOU LOSE!';
  document.getElementById('gameover-winner-sprite').src  = survivorSprite ?? '';
  document.getElementById('gameover-result-text').textContent =
    won ? `${survivorName ?? '???'} stood victorious!` : `${survivorName ?? '???'} was too strong…`;
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
