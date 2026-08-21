// ── Battle resolution engine (pure functions, no DOM) ─────────────────────────
//
// The HOST pre-resolves the ENTIRE battle before sending battle-start.
// Both sides animate the pre-computed event log at 1100 ms per event.

// ── Seeded PRNG (mulberry32) ──────────────────────────────────────────────────
// Default to Math.random so solo/test code works without a seed.
let _rng = Math.random.bind(Math);

// Call before resolveFullBattle() to make simulation deterministic.
// Both host and guest must use the same seed to get identical outcomes.
function setBattleSeed(seed) {
  let s = seed >>> 0;
  _rng = function () {
    s += 0x6D2B79F5;
    let t = Math.imul(s ^ (s >>> 15), 1 | s);
    t ^= t + Math.imul(t ^ (t >>> 7), 61 | t);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// Legacy contact set — used for moves without a .contact property
const CONTACT_MOVES = new Set([
  'Sand Slash','Bulldoze','Dig',
  'Peck','Wing Attack','Air Slash','Aerial Ace',
  'Tackle','Bug Bite','X-Scissor',
  'Quick Attack','Double Kick','Headbutt','Last Resort',
  'Horn Blaze','Body Slam','Eruption Charge',
  'Dragon Claw','Bite','Outrage',
  'Play Rough',
  'Night Slash','Crunch','Sucker Punch',
  'Mach Punch','Low Kick','Close Combat',
  'Vine Whip','Vine Wrap','Leaf Slash',
  'Spur Jab','Tail Slap',
  'Shell Smash',
  'Poison Sting','Venom Fang','Coil Strike',
  'Web Wrap','Poison Jab',
  'Tentacle Slap',
  'Fury Swipes',
]);

function _isContact(move) {
  if (move.contact != null) return move.contact;
  return CONTACT_MOVES.has(move.name);
}

function buildBattleCreature(creatureData, variantSprite, abilityId, selectedMoveNames) {
  const moves = selectedMoveNames?.length
    ? selectedMoveNames.map(n => MOVE_POOL[n] ? { name: n, ...MOVE_POOL[n] } : null).filter(Boolean)
    : creatureData.moves;
  return {
    ...creatureData,
    moves,
    maxHp:           creatureData.hp,
    currentHp:       creatureData.hp,
    status:          null,
    sprite:          variantSprite || creatureData.sprite,
    ability:         abilityId || null,
    stages:          { atk: 0, def: 0, spd: 0 },
    flashFireActive: false,
    moveIdx:         0,
  };
}

// stat stage multiplier: +1=1.5×, +2=2×, -1=0.67×, etc.
function _stageMultiplier(stage) {
  return stage >= 0 ? (2 + stage) / 2 : 2 / (2 - stage);
}

// ── Damage formula ────────────────────────────────────────────────────────────

function _calcDamage(atk, move, def) {
  const effectiveness = getTypeEffectiveness(move.type, def.type);
  if (effectiveness === 0) return null;

  let atkVal = atk.atk * _stageMultiplier(atk.stages?.atk ?? 0);
  let defVal = def.def * _stageMultiplier(def.stages?.def ?? 0);

  // Attacker ability attack modifiers
  if (atk.ability === 'Guts'   && atk.status)  atkVal *= 1.5;
  if (atk.ability === 'Hustle')                 atkVal *= 1.5;

  // Defender ability defense modifiers
  if (def.ability === 'Thick Fat' && (move.type === 'Fire' || move.type === 'Ice')) defVal *= 2;

  const base = (move.power * (atkVal / 100)) * (100 / (100 + defVal));
  const roll = 0.85 + _rng() * 0.15;

  let crit = _rng() < (move.highCrit ? 0.25 : 0.0625);
  if (def.ability === 'Shell Armor') crit = false;

  // Facade: doubles power when attacker is statused
  const facadeMult = (move.facade && atk.status) ? 2 : 1;

  // Attacker offensive multipliers
  let mult = 1;
  if (atk.ability === 'Adaptability' && move.type === atk.type)               mult *= 1.5;
  const pinchMap = { Blaze: 'Fire', Torrent: 'Water', Overgrow: 'Grass', Swarm: 'Bug' };
  if (pinchMap[atk.ability] === move.type && atk.currentHp <= atk.maxHp * 0.33) mult *= 1.5;
  if (atk.ability === 'Flash Fire' && atk.flashFireActive && move.type === 'Fire') mult *= 1.5;

  let dmg = Math.max(1, Math.floor(base * effectiveness * facadeMult * mult * roll * (crit ? 1.5 : 1)));

  // Defender Multiscale: halve when at full HP
  if (def.ability === 'Multiscale' && def.currentHp === def.maxHp) dmg = Math.max(1, Math.floor(dmg * 0.5));

  return { damage: dmg, effectiveness, isCrit: crit };
}

// ── Auto-battle helpers ───────────────────────────────────────────────────────

// Move the back creature to the front slot when the front is dead.
// Returns true if an advance occurred.
function _tryAdvance(lanes, laneIdx, side, events) {
  const back = lanes[laneIdx][1];
  if (back && back.currentHp > 0) {
    lanes[laneIdx][0] = back;
    lanes[laneIdx][1] = null;
    events.push({ type: 'advance', side, lane: laneIdx, name: back.name, sprite: back.sprite, hpAfter: back.currentHp, maxHp: back.maxHp });
    return true;
  }
  return false;
}

// Apply one creature's attack.
// Mutates atk / def in place and pushes events.
// Does NOT push 'fainted' events — the caller handles those.
function _applyOneMoveAuto(atk, atkSide, atkLane, def, defSide, defLane, move, events, flinchSet) {
  // Paralysis: 25 % chance can't move
  if (atk.status === 'paralyze' && _rng() < 0.25) {
    events.push({ type: 'paralyzed', side: atkSide, lane: atkLane, name: atk.name });
    return;
  }
  // Freeze: 20 % chance to thaw; otherwise stuck
  if (atk.status === 'freeze') {
    if (_rng() < 0.20) {
      atk.status = null;
      events.push({ type: 'status-cured', side: atkSide, lane: atkLane, name: atk.name, reason: 'thawed' });
    } else {
      events.push({ type: 'cant-move', side: atkSide, lane: atkLane, name: atk.name, reason: 'frozen' });
      return;
    }
  }
  // Sleep: 33 % chance to wake; otherwise stuck
  if (atk.status === 'sleep') {
    if (_rng() < 0.33) {
      atk.status = null;
      events.push({ type: 'status-cured', side: atkSide, lane: atkLane, name: atk.name, reason: 'woke-up' });
    } else {
      events.push({ type: 'cant-move', side: atkSide, lane: atkLane, name: atk.name, reason: 'sleeping' });
      return;
    }
  }

  // Accuracy check
  let accuracy = move.accuracy ?? 1;
  if (atk.ability === 'Compound Eyes') accuracy = Math.min(1, accuracy * 1.3);
  if (atk.ability === 'Hustle')        accuracy = accuracy * 0.8;
  if (accuracy < 1 && _rng() > accuracy) {
    events.push({ type: 'missed', attackerSide: atkSide, attackerLane: atkLane, atkName: atk.name, moveName: move.name });
    return;
  }

  // Type absorb / immunity (before damage)
  if (move.power > 0) {
    if (def.ability === 'Flash Fire' && move.type === 'Fire') {
      def.flashFireActive = true;
      events.push({ type: 'ability-absorb', side: defSide, lane: defLane, defName: def.name, moveName: move.name, ability: 'Flash Fire' });
      return;
    }
    if (def.ability === 'Water Absorb' && move.type === 'Water') {
      const healAmt = Math.floor(def.maxHp * 0.25);
      def.currentHp = Math.min(def.maxHp, def.currentHp + healAmt);
      events.push({ type: 'ability-absorb', side: defSide, lane: defLane, defName: def.name, moveName: move.name, ability: 'Water Absorb', healAmount: healAmt, hpAfter: def.currentHp, maxHp: def.maxHp });
      return;
    }
    // Fire thaws frozen defender
    if (move.type === 'Fire' && def.status === 'freeze') {
      def.status = null;
      events.push({ type: 'status-cured', side: defSide, lane: defLane, name: def.name, reason: 'thawed' });
    }
    if (def.ability === 'Levitate' && move.type === 'Ground') {
      events.push({ type: 'no-effect', attackerSide: atkSide, attackerLane: atkLane, atkName: atk.name, moveName: move.name });
      return;
    }
  }

  // Status (power-0) moves
  if (move.power === 0) {
    const eff = move.effect;
    if (eff?.type === 'heal') {
      const amt = Math.floor(atk.maxHp * eff.amount);
      atk.currentHp = Math.min(atk.maxHp, atk.currentHp + amt);
      events.push({ type: 'heal', side: atkSide, lane: atkLane, name: atk.name, amount: amt, moveName: move.name, hpAfter: atk.currentHp, maxHp: atk.maxHp });
    } else if (eff?.type === 'stat-self') {
      if (_rng() < (eff.chance ?? 1.0)) {
        for (const { stat, change } of (eff.stages ?? [])) {
          atk.stages[stat] = Math.min(6, Math.max(-6, (atk.stages[stat] ?? 0) + change));
          events.push({ type: 'stat-change', side: atkSide, lane: atkLane, stat, change, byName: atk.name });
        }
      }
    } else if (eff?.type === 'stat-opp') {
      for (const { stat, change } of (eff.stages ?? [])) {
        def.stages[stat] = Math.min(6, Math.max(-6, (def.stages[stat] ?? 0) + change));
        events.push({ type: 'stat-change', side: defSide, lane: defLane, stat, change, byName: atk.name });
      }
    } else if (eff && !def.status && ['burn','poison','paralyze','freeze','sleep'].includes(eff.type)) {
      if (_rng() < (eff.chance ?? 1.0)) {
        def.status = eff.type;
        events.push({ type: 'status-applied', side: defSide, lane: defLane, name: def.name, status: eff.type });
      }
    }
    return;
  }

  // Damage moves
  const calc = _calcDamage(atk, move, def);
  if (!calc) {
    events.push({ type: 'no-effect', attackerSide: atkSide, attackerLane: atkLane, atkName: atk.name, moveName: move.name });
    return;
  }

  let { damage, effectiveness, isCrit } = calc;

  // Sturdy: survive OHKO from full HP
  if (def.ability === 'Sturdy' && def.currentHp === def.maxHp && damage >= def.maxHp) {
    damage = def.maxHp - 1;
    events.push({ type: 'ability-triggered', side: defSide, lane: defLane, name: def.name, ability: 'Sturdy' });
  }

  def.currentHp = Math.max(0, def.currentHp - damage);
  events.push({
    type: 'damage',
    attackerSide: atkSide, attackerLane: atkLane, atkName: atk.name,
    defenderSide: defSide, defenderLane: defLane, defName: def.name,
    moveName: move.name, moveType: move.type,
    damage, effectiveness, isCrit,
    defHpAfter: def.currentHp, defMaxHp: def.maxHp,
  });

  // Drain
  if (move.effect?.type === 'drain') {
    const amt = Math.floor(damage * (move.effect.amount ?? 0.5));
    atk.currentHp = Math.min(atk.maxHp, atk.currentHp + amt);
    events.push({ type: 'drain', side: atkSide, lane: atkLane, name: atk.name, amount: amt, hpAfter: atk.currentHp, maxHp: atk.maxHp });
  }

  // Recoil
  if (move.recoil && atk.currentHp > 0) {
    const rAmt = Math.max(1, Math.floor(damage * move.recoil));
    atk.currentHp = Math.max(0, atk.currentHp - rAmt);
    events.push({ type: 'recoil', side: atkSide, lane: atkLane, name: atk.name, amount: rAmt, hpAfter: atk.currentHp, maxHp: atk.maxHp });
  }

  // Flinch (Serene Grace doubles chance)
  const flinchChance = (move.effect?.type === 'flinch')
    ? (move.effect.chance ?? 0) * (atk.ability === 'Serene Grace' ? 2 : 1)
    : 0;
  if (def.currentHp > 0 && _rng() < flinchChance) {
    flinchSet.add(def);
  }

  // Status from move (Serene Grace doubles chance)
  const eff = move.effect;
  if (eff && (eff.type === 'burn' || eff.type === 'poison' || eff.type === 'paralyze' || eff.type === 'freeze' || eff.type === 'sleep') && !def.status && def.currentHp > 0) {
    const chance = (eff.chance ?? 0) * (atk.ability === 'Serene Grace' ? 2 : 1);
    if (_rng() < chance) {
      def.status = eff.type;
      events.push({ type: 'status-applied', side: defSide, lane: defLane, name: def.name, status: eff.type });
    }
  }

  // On-hit stat effects (statEffect array on damaging moves)
  if (move.statEffect && def.currentHp > 0) {
    for (const { target, stat, change, chance = 1.0 } of move.statEffect) {
      if (_rng() < chance) {
        const who   = target === 'self' ? atk : def;
        const wSide = target === 'self' ? atkSide : defSide;
        const wLane = target === 'self' ? atkLane : defLane;
        who.stages[stat] = Math.min(6, Math.max(-6, (who.stages[stat] ?? 0) + change));
        events.push({ type: 'stat-change', side: wSide, lane: wLane, stat, change, byName: atk.name });
      }
    }
  }

  // Contact retaliation (only if both alive)
  if (def.currentHp > 0 && atk.currentHp > 0 && _isContact(move)) {
    if (def.ability === 'Rough Skin') {
      const rsDmg = Math.max(1, Math.floor(atk.maxHp * 0.125));
      atk.currentHp = Math.max(0, atk.currentHp - rsDmg);
      events.push({ type: 'contact-damage', side: atkSide, lane: atkLane, name: atk.name, amount: rsDmg, ability: 'Rough Skin', defName: def.name, hpAfter: atk.currentHp, maxHp: atk.maxHp });
    }
    if (!atk.status) {
      if (def.ability === 'Static'       && _rng() < 0.30) { atk.status = 'paralyze'; events.push({ type: 'status-applied', side: atkSide, lane: atkLane, name: atk.name, status: 'paralyze', ability: 'Static' }); }
      if (def.ability === 'Flame Body'   && _rng() < 0.30) { atk.status = 'burn';     events.push({ type: 'status-applied', side: atkSide, lane: atkLane, name: atk.name, status: 'burn',     ability: 'Flame Body' }); }
      if (def.ability === 'Poison Point' && _rng() < 0.30) { atk.status = 'poison';   events.push({ type: 'status-applied', side: atkSide, lane: atkLane, name: atk.name, status: 'poison',   ability: 'Poison Point' }); }
    }
  }

  // Moxie: +1 Atk on KO
  if (def.currentHp <= 0 && atk.currentHp > 0 && atk.ability === 'Moxie') {
    atk.stages.atk = Math.min(6, (atk.stages.atk ?? 0) + 1);
    events.push({ type: 'stat-change', side: atkSide, lane: atkLane, stat: 'atk', change: +1, ability: 'Moxie', byName: atk.name });
  }
}

// ── Full battle resolution (host only) ────────────────────────────────────────
//
// hostLanes / guestLanes: [ [frontBC, backBC|null], [f,b], [f,b] ]
// Returns { events: [...], winner: 'host'|'guest' }

function resolveFullBattle(hostLanes, guestLanes) {
  // Deep-copy creatures so originals are not mutated
  const cp = (c) => c ? ({ ...c, stages: { ...(c.stages ?? { atk: 0, def: 0, spd: 0 }) } }) : null;
  const hLanes = hostLanes.map(lane => [cp(lane[0]), cp(lane[1])]);
  const gLanes = guestLanes.map(lane => [cp(lane[0]), cp(lane[1])]);

  const events = [];

  const getFront = (lanes, i) => {
    const f = lanes[i][0];
    return (f && f.currentHp > 0) ? f : null;
  };

  const isAllDead = (lanes) => lanes.every(lane =>
    (!lane[0] || lane[0].currentHp <= 0) && (!lane[1] || lane[1].currentHp <= 0)
  );

  // Ensure all front slots are alive before the first round
  for (let i = 0; i < 3; i++) {
    if (!getFront(hLanes, i)) _tryAdvance(hLanes, i, 'host', events);
    if (!getFront(gLanes, i)) _tryAdvance(gLanes, i, 'guest', events);
  }

  let safetyCount = 0;

  while (safetyCount++ < 600) {
    if (isAllDead(hLanes) || isAllDead(gLanes)) break;

    // Build the fighter list for this round: all living front creatures
    const fighters = [];
    for (let i = 0; i < 3; i++) {
      const hf = getFront(hLanes, i);
      const gf = getFront(gLanes, i);
      if (hf) fighters.push({ c: hf, side: 'host',  lane: i, oppLanes: gLanes, ownLanes: hLanes });
      if (gf) fighters.push({ c: gf, side: 'guest', lane: i, oppLanes: hLanes, ownLanes: gLanes });
    }

    // Sort by effective speed (desc); host breaks ties
    fighters.sort((a, b) => {
      const sA = a.c.spd * _stageMultiplier(a.c.stages?.spd ?? 0);
      const sB = b.c.spd * _stageMultiplier(b.c.stages?.spd ?? 0);
      if (sB !== sA) return sB - sA;
      return a.side === 'host' ? -1 : 1;
    });

    const flinchSet = new Set();
    let gameOver = false;

    for (let fi = 0; fi < fighters.length; fi++) {
      const { c: atk, side: atkSide, lane: atkLane, oppLanes, ownLanes } = fighters[fi];
      if (atk.currentHp <= 0) continue;

      // Flinch check (set by a faster attacker this round)
      if (flinchSet.has(atk)) {
        events.push({ type: 'flinched', side: atkSide, lane: atkLane, name: atk.name });
        continue;
      }

      const defSide = atkSide === 'host' ? 'guest' : 'host';

      // Find target: same lane first, then lowest-HP surviving front
      let def = getFront(oppLanes, atkLane);
      let defLane = atkLane;
      if (!def) {
        let minHp = Infinity;
        for (let i = 0; i < 3; i++) {
          const f = getFront(oppLanes, i);
          if (f && f.currentHp < minHp) { minHp = f.currentHp; def = f; defLane = i; }
        }
      }
      if (!def) continue; // no living targets

      // Cycle through moves
      const move = atk.moves[atk.moveIdx % atk.moves.length];
      atk.moveIdx++;

      const defHpBefore = def.currentHp;
      const atkHpBefore = atk.currentHp;

      _applyOneMoveAuto(atk, atkSide, atkLane, def, defSide, defLane, move, events, flinchSet);

      // Defender fainted
      if (defHpBefore > 0 && def.currentHp <= 0) {
        events.push({ type: 'fainted', side: defSide, lane: defLane, name: def.name });
        const advanced = _tryAdvance(oppLanes, defLane, defSide, events);
        if (advanced) {
          const newFront = oppLanes[defLane][0];
          if (newFront && !fighters.some(f => f.c === newFront)) {
            fighters.push({ c: newFront, side: defSide, lane: defLane, oppLanes: ownLanes, ownLanes: oppLanes });
          }
        }
      }

      // Attacker fainted (recoil / contact)
      if (atkHpBefore > 0 && atk.currentHp <= 0) {
        events.push({ type: 'fainted', side: atkSide, lane: atkLane, name: atk.name });
        _tryAdvance(ownLanes, atkLane, atkSide, events);
      }

      if (isAllDead(hLanes) || isAllDead(gLanes)) { gameOver = true; break; }
    }

    if (gameOver) break;

    // ── End-of-round effects ──────────────────────────────────────────────────
    for (let i = 0; i < 3; i++) {
      for (const [side, lanes] of [['host', hLanes], ['guest', gLanes]]) {
        const c = getFront(lanes, i);
        if (!c) continue;

        if (c.ability === 'Poison Heal' && c.status === 'poison') {
          const amt = Math.max(1, Math.floor(c.maxHp * 0.0625));
          c.currentHp = Math.min(c.maxHp, c.currentHp + amt);
          events.push({ type: 'ability-heal', side, lane: i, name: c.name, amount: amt, ability: 'Poison Heal', hpAfter: c.currentHp, maxHp: c.maxHp });
        } else {
          const dmg = c.status === 'burn'   ? Math.max(1, Math.floor(c.maxHp * 0.125))
                    : c.status === 'poison' ? Math.max(1, Math.floor(c.maxHp * 0.0625)) : 0;
          if (dmg > 0) {
            c.currentHp = Math.max(0, c.currentHp - dmg);
            events.push({ type: 'status-damage', side, lane: i, name: c.name, status: c.status, amount: dmg, hpAfter: c.currentHp, maxHp: c.maxHp });
            if (c.currentHp <= 0) {
              events.push({ type: 'fainted', side, lane: i, name: c.name });
              _tryAdvance(lanes, i, side, events);
            }
          }
        }

        if (c.currentHp <= 0) continue;

        if (c.ability === 'Shed Skin' && c.status && _rng() < 0.33) {
          c.status = null;
          events.push({ type: 'ability-cure', side, lane: i, name: c.name, ability: 'Shed Skin' });
        }

        if (c.ability === 'Speed Boost') {
          c.stages.spd = Math.min(6, (c.stages.spd ?? 0) + 1);
          events.push({ type: 'stat-change', side, lane: i, stat: 'spd', change: +1, ability: 'Speed Boost', byName: c.name });
        }
      }
    }

    if (isAllDead(hLanes) || isAllDead(gLanes)) break;
  }

  // Determine winner and find a survivor for the game-over screen
  const winner = isAllDead(hLanes) ? 'guest' : 'host';
  const winLanes = winner === 'host' ? hLanes : gLanes;
  let survivorSprite = '', survivorName = '???';
  outer: for (const lane of winLanes) {
    for (const c of lane) {
      if (c && c.currentHp > 0) { survivorSprite = c.sprite; survivorName = c.name; break outer; }
    }
  }
  events.push({ type: 'game-over', winner, survivorSprite, survivorName });

  return { events, winner };
}
