// ── Battle resolution engine (pure functions, no DOM) ─────────────────────────
//
// The HOST resolves every turn and sends the full result to the guest.
// Both sides then call applyTurnResult() with that same object to stay in sync.
//
// Creature battle object (built from CREATURES data):
//   { ...creatureData, maxHp, currentHp, status: null | 'burn'|'poison'|'paralyze' }

function buildBattleCreature(creatureData, variantSprite) {
  return {
    ...creatureData,
    maxHp:     creatureData.hp,
    currentHp: creatureData.hp,
    status:    null,
    sprite:    variantSprite || creatureData.sprite,
  };
}

// ── Damage formula ────────────────────────────────────────────────────────────

function _calcDamage(attacker, move, defender) {
  const effectiveness = getTypeEffectiveness(move.type, defender.type);
  if (effectiveness === 0) return null; // type immunity
  const base  = (move.power * (attacker.atk / 100)) * (100 / (100 + defender.def));
  const roll  = 0.85 + Math.random() * 0.15;
  const crit  = Math.random() < 0.0625;
  const dmg   = Math.max(1, Math.floor(base * effectiveness * roll * (crit ? 1.5 : 1)));
  return { damage: dmg, effectiveness, isCrit: crit };
}

// ── Turn resolution (called by host only) ────────────────────────────────────
//
// hostAction / guestAction: { type: 'move', moveIndex } | { type: 'switch', targetIdx }
// Returns a JSON-serializable result sent to both peers.

function resolveTurn(hostTeam, guestTeam, hostActiveIdx, guestActiveIdx, hostAction, guestAction) {
  const hTeam = hostTeam.map(c => ({ ...c }));
  const gTeam = guestTeam.map(c => ({ ...c }));
  let hIdx = hostActiveIdx;
  let gIdx = guestActiveIdx;
  const events = [];

  // Voluntary switches resolve before attacks
  if (hostAction.type === 'switch') {
    hIdx = hostAction.targetIdx;
    events.push({ type: 'switch', side: 'host', toIdx: hIdx, name: hTeam[hIdx].name });
  }
  if (guestAction.type === 'switch') {
    gIdx = guestAction.targetIdx;
    events.push({ type: 'switch', side: 'guest', toIdx: gIdx, name: gTeam[gIdx].name });
  }

  const host  = hTeam[hIdx];
  const guest = gTeam[gIdx];
  const hostMove  = hostAction.type  === 'move' ? host.moves[hostAction.moveIndex]  : null;
  const guestMove = guestAction.type === 'move' ? guest.moves[guestAction.moveIndex] : null;

  if (hostMove || guestMove) {
    const hostStunned  = hostMove  && host.status  === 'paralyze' && Math.random() < 0.25;
    const guestStunned = guestMove && guest.status === 'paralyze' && Math.random() < 0.25;

    let order;
    if (hostMove && guestMove) {
      const hp = hostMove.priority  ?? 0;
      const gp = guestMove.priority ?? 0;
      order = (hp !== gp ? hp > gp : host.spd >= guest.spd) ? ['host', 'guest'] : ['guest', 'host'];
    } else {
      order = hostMove ? ['host'] : ['guest'];
    }

    const flinched = { host: false, guest: false };

    for (const side of order) {
      const isH     = side === 'host';
      const atk     = isH ? host  : guest;
      const def     = isH ? guest : host;
      const move    = isH ? hostMove : guestMove;
      const defSide = isH ? 'guest' : 'host';

      if (!move || def.currentHp <= 0) continue;
      if (isH ? hostStunned : guestStunned) { events.push({ type: 'paralyzed', target: side }); continue; }
      if (flinched[side])                   { events.push({ type: 'flinched',  target: side }); continue; }

      if (move.accuracy != null && Math.random() > move.accuracy) {
        events.push({ type: 'missed', attacker: side, moveName: move.name });
        continue;
      }

      if (move.power === 0) {
        if (move.effect?.type === 'heal') {
          const amt = Math.floor(atk.maxHp * move.effect.amount);
          atk.currentHp = Math.min(atk.maxHp, atk.currentHp + amt);
          events.push({ type: 'heal', target: side, amount: amt, moveName: move.name });
        }
        continue;
      }

      const calc = _calcDamage(atk, move, def);
      if (!calc) { events.push({ type: 'no-effect', attacker: side, moveName: move.name }); continue; }
      const { damage, effectiveness, isCrit } = calc;
      def.currentHp = Math.max(0, def.currentHp - damage);
      events.push({ type: 'damage', attacker: side, defender: defSide, moveName: move.name, moveType: move.type, damage, effectiveness, isCrit });

      if (move.effect?.type === 'drain') {
        const amt = Math.floor(damage * (move.effect.amount ?? 0.5));
        atk.currentHp = Math.min(atk.maxHp, atk.currentHp + amt);
        events.push({ type: 'drain', target: side, amount: amt });
      }
      if (move.effect?.type === 'flinch' && Math.random() < (move.effect.chance ?? 0)) {
        flinched[defSide] = true;
      }
      const eff = move.effect;
      if (eff && (eff.type === 'burn' || eff.type === 'poison' || eff.type === 'paralyze')) {
        if (!def.status && Math.random() < (eff.chance ?? 0)) {
          def.status = eff.type;
          events.push({ type: 'status-applied', target: defSide, status: eff.type });
        }
      }
      if (def.currentHp <= 0) {
        events.push({ type: 'fainted', target: defSide, teamIdx: isH ? gIdx : hIdx });
        break;
      }
    }
  }

  // End-of-turn status damage on active creatures
  for (const [side, c, teamIdx] of [['host', host, hIdx], ['guest', guest, gIdx]]) {
    if (c.currentHp <= 0) continue;
    const dmg = c.status === 'burn'   ? Math.max(1, Math.floor(c.maxHp * 0.125))
              : c.status === 'poison' ? Math.max(1, Math.floor(c.maxHp * 0.0625)) : 0;
    if (dmg > 0) {
      c.currentHp = Math.max(0, c.currentHp - dmg);
      events.push({ type: 'status-damage', target: side, status: c.status, amount: dmg });
      if (c.currentHp <= 0) events.push({ type: 'fainted', target: side, teamIdx });
    }
  }

  // Game over: all 3 of one side fainted
  const hostAllFainted  = hTeam.every(c => c.currentHp <= 0);
  const guestAllFainted = gTeam.every(c => c.currentHp <= 0);
  if (hostAllFainted || guestAllFainted) {
    events.push({ type: 'game-over', winner: hostAllFainted ? 'guest' : 'host' });
  }

  return {
    events,
    hostTeamHp:      hTeam.map(c => c.currentHp),
    guestTeamHp:     gTeam.map(c => c.currentHp),
    hostTeamStatus:  hTeam.map(c => c.status),
    guestTeamStatus: gTeam.map(c => c.status),
    hostActiveIdx:   hIdx,
    guestActiveIdx:  gIdx,
  };
}
