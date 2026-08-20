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
// Returns a result object safe to JSON-serialize and send over the network.
// The host and guest both call interpretTurnResult() with this same object.

function resolveTurn(hostCreature, guestCreature, hostMoveIdx, guestMoveIdx) {
  // Work on shallow copies; caller's objects are NOT mutated
  const host  = { ...hostCreature };
  const guest = { ...guestCreature };
  const events = [];

  const hostMove  = host.moves[hostMoveIdx];
  const guestMove = guest.moves[guestMoveIdx];

  // Paralysis check
  const hostStunned  = host.status  === 'paralyze' && Math.random() < 0.25;
  const guestStunned = guest.status === 'paralyze' && Math.random() < 0.25;

  // Move order: priority first, then speed (host wins ties)
  const hp = hostMove.priority  ?? 0;
  const gp = guestMove.priority ?? 0;
  const hostFirst = hp !== gp ? hp > gp : host.spd >= guest.spd;
  const order = hostFirst ? ['host', 'guest'] : ['guest', 'host'];

  const flinched = { host: false, guest: false };

  for (const side of order) {
    const isHost  = side === 'host';
    const atk     = isHost ? host  : guest;
    const def     = isHost ? guest : host;
    const move    = isHost ? hostMove  : guestMove;
    const stunned = isHost ? hostStunned : guestStunned;
    const defSide = isHost ? 'guest' : 'host';

    if (def.currentHp <= 0) break;

    if (stunned) {
      events.push({ type: 'paralyzed', target: side });
      continue;
    }
    if (flinched[side]) {
      events.push({ type: 'flinched', target: side });
      continue;
    }

    // Accuracy check
    if (move.accuracy != null && Math.random() > move.accuracy) {
      events.push({ type: 'missed', attacker: side, moveName: move.name });
      continue;
    }

    // Heal / status move (power === 0)
    if (move.power === 0) {
      if (move.effect?.type === 'heal') {
        const amt = Math.floor(atk.maxHp * move.effect.amount);
        atk.currentHp = Math.min(atk.maxHp, atk.currentHp + amt);
        events.push({ type: 'heal', target: side, amount: amt, moveName: move.name });
      }
      continue;
    }

    // Damage
    const calcResult = _calcDamage(atk, move, def);
    if (!calcResult) {
      events.push({ type: 'no-effect', attacker: side, moveName: move.name });
      continue;
    }
    const { damage, effectiveness, isCrit } = calcResult;
    def.currentHp = Math.max(0, def.currentHp - damage);
    events.push({
      type: 'damage',
      attacker: side, defender: defSide,
      moveName: move.name, moveType: move.type,
      damage, effectiveness, isCrit,
    });

    // Drain heal
    if (move.effect?.type === 'drain') {
      const amt = Math.floor(damage * (move.effect.amount ?? 0.5));
      atk.currentHp = Math.min(atk.maxHp, atk.currentHp + amt);
      events.push({ type: 'drain', target: side, amount: amt });
    }

    // Flinch
    if (move.effect?.type === 'flinch' && Math.random() < (move.effect.chance ?? 0)) {
      flinched[defSide] = true;
    }

    // Secondary status (burn / poison / paralyze)
    const eff = move.effect;
    if (eff && (eff.type === 'burn' || eff.type === 'poison' || eff.type === 'paralyze')) {
      if (!def.status && Math.random() < (eff.chance ?? 0)) {
        def.status = eff.type;
        events.push({ type: 'status-applied', target: defSide, status: eff.type });
      }
    }

    if (def.currentHp <= 0) {
      events.push({ type: 'fainted', target: defSide });
      break;
    }
  }

  // End-of-turn status damage
  for (const [side, c] of [['host', host], ['guest', guest]]) {
    if (c.currentHp <= 0) continue;
    let dmg = 0;
    if (c.status === 'burn')   dmg = Math.max(1, Math.floor(c.maxHp * 0.125));
    if (c.status === 'poison') dmg = Math.max(1, Math.floor(c.maxHp * 0.0625));
    if (dmg > 0) {
      c.currentHp = Math.max(0, c.currentHp - dmg);
      events.push({ type: 'status-damage', target: side, status: c.status, amount: dmg });
      if (c.currentHp <= 0) events.push({ type: 'fainted', target: side });
    }
  }

  // Game-over check
  if (host.currentHp <= 0 || guest.currentHp <= 0) {
    events.push({
      type:   'game-over',
      winner: host.currentHp <= 0 ? 'guest' : 'host',
    });
  }

  return {
    events,
    hostHp:     host.currentHp,
    guestHp:    guest.currentHp,
    hostStatus: host.status,
    guestStatus: guest.status,
  };
}
