// ── Battle resolution engine (pure functions, no DOM) ─────────────────────────
//
// The HOST resolves every turn and sends the full result to the guest.
// Both sides then call applyTurnResult() with that same object to stay in sync.

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
  const roll = 0.85 + Math.random() * 0.15;

  let crit = Math.random() < (move.highCrit ? 0.25 : 0.0625);
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

// ── Switch helper: apply switch-out and switch-in ability effects ─────────────

function _applySwitch(team, oldIdx, newIdx, oppTeam, oppIdx, side, events) {
  const outgoing = team[oldIdx];
  if (outgoing.currentHp > 0) {
    if (outgoing.ability === 'Regenerator') {
      const amt = Math.floor(outgoing.maxHp * 0.33);
      outgoing.currentHp = Math.min(outgoing.maxHp, outgoing.currentHp + amt);
      events.push({ type: 'ability-heal', target: side, teamIdx: oldIdx, amount: amt, ability: 'Regenerator' });
    }
    if (outgoing.ability === 'Natural Cure' && outgoing.status) {
      outgoing.status = null;
      events.push({ type: 'ability-cure', target: side, teamIdx: oldIdx, ability: 'Natural Cure' });
    }
  }
  events.push({ type: 'switch', side, toIdx: newIdx, name: team[newIdx].name });
  const incoming = team[newIdx];
  if (incoming.ability === 'Intimidate') {
    const opp = oppTeam[oppIdx];
    opp.stages.atk = Math.max(-6, (opp.stages.atk ?? 0) - 1);
    const oppSide = side === 'host' ? 'guest' : 'host';
    events.push({ type: 'stat-change', target: oppSide, stat: 'atk', change: -1, ability: 'Intimidate', byName: incoming.name });
  }
}

// ── Turn resolution (host only) ───────────────────────────────────────────────

function resolveTurn(hostTeam, guestTeam, hostActiveIdx, guestActiveIdx, hostAction, guestAction) {
  const hTeam = hostTeam.map(c => ({ ...c, stages: { ...(c.stages ?? { atk:0, def:0, spd:0 }) } }));
  const gTeam = guestTeam.map(c => ({ ...c, stages: { ...(c.stages ?? { atk:0, def:0, spd:0 }) } }));
  let hIdx = hostActiveIdx;
  let gIdx = guestActiveIdx;
  const events = [];

  // Voluntary switches first (with switch-out/switch-in ability effects)
  if (hostAction.type === 'switch') {
    _applySwitch(hTeam, hIdx, hostAction.targetIdx, gTeam, gIdx, 'host', events);
    hIdx = hostAction.targetIdx;
  }
  if (guestAction.type === 'switch') {
    _applySwitch(gTeam, gIdx, guestAction.targetIdx, hTeam, hIdx, 'guest', events);
    gIdx = guestAction.targetIdx;
  }

  const host  = hTeam[hIdx];
  const guest = gTeam[gIdx];
  const hostMove  = hostAction.type  === 'move' ? host.moves[hostAction.moveIndex]  : null;
  const guestMove = guestAction.type === 'move' ? guest.moves[guestAction.moveIndex] : null;

  if (hostMove || guestMove) {
    const hostStunned  = hostMove  && host.status  === 'paralyze' && Math.random() < 0.25;
    const guestStunned = guestMove && guest.status === 'paralyze' && Math.random() < 0.25;

    // Speed with stage modifier for turn order
    const hEffSpd = host.spd  * _stageMultiplier(host.stages.spd  ?? 0);
    const gEffSpd = guest.spd * _stageMultiplier(guest.stages.spd ?? 0);

    let order;
    if (hostMove && guestMove) {
      const hp = hostMove.priority  ?? 0;
      const gp = guestMove.priority ?? 0;
      order = (hp !== gp ? hp > gp : hEffSpd >= gEffSpd) ? ['host', 'guest'] : ['guest', 'host'];
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

      // Freeze: 20% chance to thaw and attack; otherwise stuck
      if (atk.status === 'freeze') {
        if (Math.random() < 0.20) {
          atk.status = null;
          events.push({ type: 'status-cured', target: side, reason: 'thawed' });
        } else {
          events.push({ type: 'cant-move', target: side, reason: 'frozen' });
          continue;
        }
      }
      // Sleep: 33% chance to wake and attack; otherwise stuck
      if (atk.status === 'sleep') {
        if (Math.random() < 0.33) {
          atk.status = null;
          events.push({ type: 'status-cured', target: side, reason: 'woke-up' });
        } else {
          events.push({ type: 'cant-move', target: side, reason: 'sleeping' });
          continue;
        }
      }

      if (flinched[side]) { events.push({ type: 'flinched', target: side }); continue; }

      // Accuracy check with ability modifiers
      let accuracy = move.accuracy ?? 1;
      if (atk.ability === 'Compound Eyes') accuracy = Math.min(1, accuracy * 1.3);
      if (atk.ability === 'Hustle')        accuracy = accuracy * 0.8;
      if (accuracy < 1 && Math.random() > accuracy) {
        events.push({ type: 'missed', attacker: side, moveName: move.name });
        continue;
      }

      // Type absorb / immunity check (happens before damage)
      if (move.power > 0) {
        if (def.ability === 'Flash Fire' && move.type === 'Fire') {
          def.flashFireActive = true;
          events.push({ type: 'ability-absorb', target: defSide, moveName: move.name, ability: 'Flash Fire', defName: def.name });
          continue;
        }
        if (def.ability === 'Water Absorb' && move.type === 'Water') {
          const healAmt = Math.floor(def.maxHp * 0.25);
          def.currentHp = Math.min(def.maxHp, def.currentHp + healAmt);
          events.push({ type: 'ability-absorb', target: defSide, moveName: move.name, ability: 'Water Absorb', healAmount: healAmt, defName: def.name });
          continue;
        }
        // Fire moves thaw a frozen defender (Flash Fire already handled above)
        if (move.type === 'Fire' && def.status === 'freeze') {
          def.status = null;
          events.push({ type: 'status-cured', target: defSide, reason: 'thawed' });
        }

        if (def.ability === 'Levitate' && move.type === 'Ground') {
          events.push({ type: 'no-effect', attacker: side, moveName: move.name });
          continue;
        }
      }

      if (move.power === 0) {
        const eff = move.effect;
        if (eff?.type === 'heal') {
          const amt = Math.floor(atk.maxHp * eff.amount);
          atk.currentHp = Math.min(atk.maxHp, atk.currentHp + amt);
          events.push({ type: 'heal', target: side, amount: amt, moveName: move.name });
        } else if (eff?.type === 'stat-self') {
          if (Math.random() < (eff.chance ?? 1.0)) {
            for (const { stat, change } of (eff.stages ?? [])) {
              atk.stages[stat] = Math.min(6, Math.max(-6, (atk.stages[stat] ?? 0) + change));
              events.push({ type: 'stat-change', target: side, stat, change, byName: atk.name });
            }
          }
        } else if (eff?.type === 'stat-opp') {
          for (const { stat, change } of (eff.stages ?? [])) {
            def.stages[stat] = Math.min(6, Math.max(-6, (def.stages[stat] ?? 0) + change));
            events.push({ type: 'stat-change', target: defSide, stat, change, byName: atk.name });
          }
        } else if (eff && !def.status && ['burn','poison','paralyze','freeze','sleep'].includes(eff.type)) {
          if (Math.random() < (eff.chance ?? 1.0)) {
            def.status = eff.type;
            events.push({ type: 'status-applied', target: defSide, status: eff.type });
          }
        }
        continue;
      }

      const calc = _calcDamage(atk, move, def);
      if (!calc) { events.push({ type: 'no-effect', attacker: side, moveName: move.name }); continue; }

      let { damage, effectiveness, isCrit } = calc;

      // Sturdy: survive a OHKO from full HP
      if (def.ability === 'Sturdy' && def.currentHp === def.maxHp && damage >= def.maxHp) {
        damage = def.maxHp - 1;
        events.push({ type: 'ability-triggered', target: defSide, ability: 'Sturdy', defName: def.name });
      }

      def.currentHp = Math.max(0, def.currentHp - damage);
      events.push({ type: 'damage', attacker: side, defender: defSide, moveName: move.name, moveType: move.type, damage, effectiveness, isCrit });

      if (move.effect?.type === 'drain') {
        const amt = Math.floor(damage * (move.effect.amount ?? 0.5));
        atk.currentHp = Math.min(atk.maxHp, atk.currentHp + amt);
        events.push({ type: 'drain', target: side, amount: amt });
      }

      // Recoil
      if (move.recoil && atk.currentHp > 0) {
        const rAmt = Math.max(1, Math.floor(damage * move.recoil));
        atk.currentHp = Math.max(0, atk.currentHp - rAmt);
        events.push({ type: 'recoil', target: side, amount: rAmt });
        if (atk.currentHp <= 0) events.push({ type: 'fainted', target: side, teamIdx: isH ? hIdx : gIdx });
      }

      // Flinch (Serene Grace doubles chance)
      const flinchChance = (move.effect?.type === 'flinch')
        ? (move.effect.chance ?? 0) * (atk.ability === 'Serene Grace' ? 2 : 1)
        : 0;
      if (Math.random() < flinchChance) flinched[defSide] = true;

      // Status from move (Serene Grace doubles chance)
      const eff = move.effect;
      if (eff && (eff.type === 'burn' || eff.type === 'poison' || eff.type === 'paralyze' || eff.type === 'freeze' || eff.type === 'sleep') && !def.status) {
        const chance = (eff.chance ?? 0) * (atk.ability === 'Serene Grace' ? 2 : 1);
        if (Math.random() < chance) {
          def.status = eff.type;
          events.push({ type: 'status-applied', target: defSide, status: eff.type });
        }
      }

      // On-hit stat effects (statEffect array on damaging moves)
      if (move.statEffect && def.currentHp > 0) {
        for (const { target, stat, change, chance = 1.0 } of move.statEffect) {
          if (Math.random() < chance) {
            const who  = target === 'self' ? atk  : def;
            const wSide = target === 'self' ? side : defSide;
            who.stages[stat] = Math.min(6, Math.max(-6, (who.stages[stat] ?? 0) + change));
            events.push({ type: 'stat-change', target: wSide, stat, change, byName: target === 'self' ? atk.name : null });
          }
        }
      }

      // Contact retaliation abilities (only if both alive)
      if (def.currentHp > 0 && atk.currentHp > 0 && _isContact(move)) {
        if (def.ability === 'Rough Skin') {
          const rsDmg = Math.max(1, Math.floor(atk.maxHp * 0.125));
          atk.currentHp = Math.max(0, atk.currentHp - rsDmg);
          events.push({ type: 'contact-damage', target: side, amount: rsDmg, ability: 'Rough Skin', defName: def.name });
          if (atk.currentHp <= 0) events.push({ type: 'fainted', target: side, teamIdx: isH ? hIdx : gIdx });
        }
        if (!atk.status) {
          if (def.ability === 'Static'      && Math.random() < 0.30) { atk.status = 'paralyze'; events.push({ type: 'status-applied', target: side, status: 'paralyze', ability: 'Static' }); }
          if (def.ability === 'Flame Body'  && Math.random() < 0.30) { atk.status = 'burn';     events.push({ type: 'status-applied', target: side, status: 'burn',     ability: 'Flame Body' }); }
          if (def.ability === 'Poison Point'&& Math.random() < 0.30) { atk.status = 'poison';   events.push({ type: 'status-applied', target: side, status: 'poison',   ability: 'Poison Point' }); }
        }
      }

      if (def.currentHp <= 0) {
        events.push({ type: 'fainted', target: defSide, teamIdx: isH ? gIdx : hIdx });
        if (atk.currentHp > 0 && atk.ability === 'Moxie') {
          atk.stages.atk = Math.min(6, (atk.stages.atk ?? 0) + 1);
          events.push({ type: 'stat-change', target: side, stat: 'atk', change: +1, ability: 'Moxie', byName: atk.name });
        }
        break;
      }
    }
  }

  // ── End-of-turn effects ───────────────────────────────────────────────────
  for (const [side, c, teamIdx] of [['host', host, hIdx], ['guest', guest, gIdx]]) {
    if (c.currentHp <= 0) continue;

    // Status tick (Poison Heal replaces poison damage)
    if (c.ability === 'Poison Heal' && c.status === 'poison') {
      const amt = Math.max(1, Math.floor(c.maxHp * 0.0625));
      c.currentHp = Math.min(c.maxHp, c.currentHp + amt);
      events.push({ type: 'ability-heal', target: side, teamIdx, amount: amt, ability: 'Poison Heal' });
    } else {
      const dmg = c.status === 'burn'   ? Math.max(1, Math.floor(c.maxHp * 0.125))
                : c.status === 'poison' ? Math.max(1, Math.floor(c.maxHp * 0.0625)) : 0;
      if (dmg > 0) {
        c.currentHp = Math.max(0, c.currentHp - dmg);
        events.push({ type: 'status-damage', target: side, status: c.status, amount: dmg });
        if (c.currentHp <= 0) { events.push({ type: 'fainted', target: side, teamIdx }); continue; }
      }
    }

    // Shed Skin: 33% chance to heal status
    if (c.ability === 'Shed Skin' && c.status && Math.random() < 0.33) {
      c.status = null;
      events.push({ type: 'ability-cure', target: side, teamIdx, ability: 'Shed Skin' });
    }

    // Speed Boost: +1 speed stage
    if (c.ability === 'Speed Boost') {
      c.stages.spd = Math.min(6, (c.stages.spd ?? 0) + 1);
      events.push({ type: 'stat-change', target: side, stat: 'spd', change: +1, ability: 'Speed Boost', byName: c.name });
    }
  }

  // Game over: all 3 on one side fainted
  const hostAllFainted  = hTeam.every(c => c.currentHp <= 0);
  const guestAllFainted = gTeam.every(c => c.currentHp <= 0);
  if (hostAllFainted || guestAllFainted) {
    events.push({ type: 'game-over', winner: hostAllFainted ? 'guest' : 'host' });
  }

  return {
    events,
    hostTeamHp:         hTeam.map(c => c.currentHp),
    guestTeamHp:        gTeam.map(c => c.currentHp),
    hostTeamStatus:     hTeam.map(c => c.status),
    guestTeamStatus:    gTeam.map(c => c.status),
    hostTeamStages:     hTeam.map(c => ({ ...c.stages })),
    guestTeamStages:    gTeam.map(c => ({ ...c.stages })),
    hostTeamAbilState:  hTeam.map(c => ({ flashFireActive: c.flashFireActive })),
    guestTeamAbilState: gTeam.map(c => ({ flashFireActive: c.flashFireActive })),
    hostActiveIdx:  hIdx,
    guestActiveIdx: gIdx,
  };
}
