// Move pool — all moves available for creature pools.
// Each entry: { type, power, accuracy (null=never miss), pp, contact,
//               priority, recoil (fraction of dmg), highCrit, facade,
//               effect, statEffect }
// effect:      { type, chance?, amount?, stages? }
//   types: burn | poison | paralyze | freeze | sleep | flinch | drain |
//          heal | stat-self | stat-opp
// statEffect:  [{ target:'self'|'opp', stat:'atk'|'def'|'spd', change, chance? }]
//   Applied after dealing damage. chance defaults to 1.0 (guaranteed).
const MOVE_POOL = {
  // ── Normal ────────────────────────────────────────────────────────────────
  'Body Slam':      { type:'Normal',   power:85,  accuracy:1.00, pp:15, contact:true,  effect:{type:'paralyze',chance:0.30} },
  'Quick Attack':   { type:'Normal',   power:40,  accuracy:1.00, pp:30, contact:true,  priority:1 },
  'Extreme Speed':  { type:'Normal',   power:80,  accuracy:1.00, pp:5,  contact:true,  priority:2 },
  'Double-Edge':    { type:'Normal',   power:120, accuracy:1.00, pp:15, contact:true,  recoil:0.33 },
  'Headbutt':       { type:'Normal',   power:70,  accuracy:1.00, pp:15, contact:true,  effect:{type:'flinch',chance:0.30} },
  'Hyper Voice':    { type:'Normal',   power:90,  accuracy:1.00, pp:10, contact:false },
  'Facade':         { type:'Normal',   power:70,  accuracy:1.00, pp:20, contact:true,  facade:true },
  'Last Resort':    { type:'Normal',   power:140, accuracy:1.00, pp:5,  contact:true },
  'Slash':          { type:'Normal',   power:70,  accuracy:1.00, pp:20, contact:true,  highCrit:true },
  'Swords Dance':   { type:'Normal',   power:0,   accuracy:null, pp:20, effect:{type:'stat-self', stages:[{stat:'atk',change:2}]} },
  'Work Up':        { type:'Normal',   power:0,   accuracy:null, pp:30, effect:{type:'stat-self', stages:[{stat:'atk',change:1}]} },

  // ── Ground ────────────────────────────────────────────────────────────────
  'Earthquake':       { type:'Ground', power:100, accuracy:1.00, pp:10, contact:false },
  'High Horsepower':  { type:'Ground', power:95,  accuracy:0.95, pp:10, contact:true },
  'Bulldoze':         { type:'Ground', power:60,  accuracy:1.00, pp:20, contact:false, statEffect:[{target:'opp',stat:'spd',change:-1}] },
  'Dig':              { type:'Ground', power:80,  accuracy:1.00, pp:10, contact:true },
  'Mud Shot':         { type:'Ground', power:55,  accuracy:0.95, pp:15, contact:false, statEffect:[{target:'opp',stat:'spd',change:-1}] },
  'Scorching Sands':  { type:'Ground', power:70,  accuracy:1.00, pp:10, contact:false, effect:{type:'burn',chance:0.30} },
  'Rock Tomb':        { type:'Rock',   power:60,  accuracy:0.95, pp:15, contact:false, statEffect:[{target:'opp',stat:'spd',change:-1}] },

  // ── Flying ────────────────────────────────────────────────────────────────
  'Hurricane':    { type:'Flying', power:110, accuracy:0.70, pp:10, contact:false, effect:{type:'paralyze',chance:0.30} },
  'Aerial Ace':   { type:'Flying', power:60,  accuracy:null, pp:20, contact:true },
  'Air Slash':    { type:'Flying', power:75,  accuracy:0.95, pp:15, contact:true,  effect:{type:'flinch',chance:0.30} },
  'Brave Bird':   { type:'Flying', power:120, accuracy:1.00, pp:15, contact:true,  recoil:0.33 },
  'Wing Attack':  { type:'Flying', power:60,  accuracy:1.00, pp:35, contact:true },
  'Bounce':       { type:'Flying', power:85,  accuracy:0.85, pp:5,  contact:true,  effect:{type:'paralyze',chance:0.30} },
  'Acrobatics':   { type:'Flying', power:55,  accuracy:1.00, pp:15, contact:true },

  // ── Bug ───────────────────────────────────────────────────────────────────
  'X-Scissor':     { type:'Bug', power:80,  accuracy:1.00, pp:15, contact:true },
  'Bug Buzz':      { type:'Bug', power:90,  accuracy:1.00, pp:10, contact:false },
  'Megahorn':      { type:'Bug', power:120, accuracy:0.85, pp:10, contact:true },
  'Lunge':         { type:'Bug', power:80,  accuracy:1.00, pp:15, contact:true,  statEffect:[{target:'opp',stat:'atk',change:-1}] },
  'Bug Bite':      { type:'Bug', power:60,  accuracy:1.00, pp:20, contact:true },
  'Attack Order':  { type:'Bug', power:90,  accuracy:1.00, pp:15, contact:false, highCrit:true },
  'U-turn':        { type:'Bug', power:70,  accuracy:1.00, pp:20, contact:true },
  'String Shot':   { type:'Bug', power:0,   accuracy:0.95, pp:40, effect:{type:'stat-opp', stages:[{stat:'spd',change:-2}]} },

  // ── Fire ──────────────────────────────────────────────────────────────────
  'Flamethrower': { type:'Fire', power:90,  accuracy:1.00, pp:15, contact:false, effect:{type:'burn',chance:0.10} },
  'Fire Blast':   { type:'Fire', power:110, accuracy:0.85, pp:5,  contact:false, effect:{type:'burn',chance:0.10} },
  'Flare Blitz':  { type:'Fire', power:120, accuracy:1.00, pp:15, contact:true,  recoil:0.33, effect:{type:'burn',chance:0.10} },
  'Lava Plume':   { type:'Fire', power:80,  accuracy:1.00, pp:15, contact:false, effect:{type:'burn',chance:0.30} },
  'Heat Wave':    { type:'Fire', power:95,  accuracy:0.90, pp:10, contact:false, effect:{type:'burn',chance:0.10} },
  'Fire Punch':   { type:'Fire', power:75,  accuracy:1.00, pp:15, contact:true,  effect:{type:'burn',chance:0.10} },
  'Will-O-Wisp':  { type:'Fire', power:0,   accuracy:0.85, pp:15, effect:{type:'burn',chance:1.0} },

  // ── Dragon ────────────────────────────────────────────────────────────────
  'Dragon Claw':   { type:'Dragon', power:80,  accuracy:1.00, pp:15, contact:true },
  'Dragon Pulse':  { type:'Dragon', power:85,  accuracy:1.00, pp:10, contact:false },
  'Dragon Hammer': { type:'Dragon', power:90,  accuracy:1.00, pp:15, contact:true },
  'Dragon Rush':   { type:'Dragon', power:100, accuracy:0.75, pp:10, contact:true, effect:{type:'flinch',chance:0.20} },
  'Outrage':       { type:'Dragon', power:120, accuracy:1.00, pp:10, contact:true },
  'Draco Meteor':  { type:'Dragon', power:130, accuracy:0.90, pp:5,  contact:false, statEffect:[{target:'self',stat:'atk',change:-2}] },
  'Dragon Dance':  { type:'Dragon', power:0,   accuracy:null, pp:20, effect:{type:'stat-self', stages:[{stat:'atk',change:1},{stat:'spd',change:1}]} },

  // ── Fairy ─────────────────────────────────────────────────────────────────
  'Moonblast':      { type:'Fairy', power:95, accuracy:1.00, pp:15, contact:false, statEffect:[{target:'opp',stat:'atk',change:-1,chance:0.30}] },
  'Play Rough':     { type:'Fairy', power:90, accuracy:0.90, pp:10, contact:true,  statEffect:[{target:'opp',stat:'atk',change:-1,chance:0.10}] },
  'Dazzling Gleam': { type:'Fairy', power:80, accuracy:1.00, pp:10, contact:false },
  'Spirit Break':   { type:'Fairy', power:75, accuracy:1.00, pp:15, contact:true,  statEffect:[{target:'opp',stat:'atk',change:-1}] },
  'Draining Kiss':  { type:'Fairy', power:50, accuracy:1.00, pp:10, contact:true,  effect:{type:'drain',amount:0.75} },
  'Charm':          { type:'Fairy', power:0,  accuracy:1.00, pp:20, effect:{type:'stat-opp', stages:[{stat:'atk',change:-2}]} },
  'Alluring Voice': { type:'Fairy', power:80, accuracy:1.00, pp:10, contact:false },

  // ── Dark ──────────────────────────────────────────────────────────────────
  'Crunch':       { type:'Dark', power:80, accuracy:1.00, pp:15, contact:true,  statEffect:[{target:'opp',stat:'def',change:-1,chance:0.20}] },
  'Night Slash':  { type:'Dark', power:70, accuracy:1.00, pp:15, contact:true,  highCrit:true },
  'Sucker Punch': { type:'Dark', power:70, accuracy:1.00, pp:5,  contact:true,  priority:1 },
  'Dark Pulse':   { type:'Dark', power:80, accuracy:1.00, pp:15, contact:false, effect:{type:'flinch',chance:0.20} },
  'Knock Off':    { type:'Dark', power:65, accuracy:1.00, pp:20, contact:true },
  'Throat Chop':  { type:'Dark', power:80, accuracy:1.00, pp:15, contact:true },
  'Snarl':        { type:'Dark', power:55, accuracy:0.95, pp:15, contact:false, statEffect:[{target:'opp',stat:'atk',change:-1}] },

  // ── Ice ───────────────────────────────────────────────────────────────────
  'Ice Beam':      { type:'Ice', power:90,  accuracy:1.00, pp:10, contact:false, effect:{type:'freeze',chance:0.10} },
  'Blizzard':      { type:'Ice', power:110, accuracy:0.70, pp:5,  contact:false, effect:{type:'freeze',chance:0.10} },
  'Ice Punch':     { type:'Ice', power:75,  accuracy:1.00, pp:15, contact:true,  effect:{type:'freeze',chance:0.10} },
  'Icicle Crash':  { type:'Ice', power:85,  accuracy:0.90, pp:10, contact:false, effect:{type:'flinch',chance:0.30} },
  'Ice Shard':     { type:'Ice', power:40,  accuracy:1.00, pp:30, contact:false, priority:1 },
  'Icy Wind':      { type:'Ice', power:55,  accuracy:0.95, pp:15, contact:false, statEffect:[{target:'opp',stat:'spd',change:-1}] },
  'Freeze-Dry':    { type:'Ice', power:70,  accuracy:1.00, pp:20, contact:false, effect:{type:'freeze',chance:0.10} },

  // ── Fighting ──────────────────────────────────────────────────────────────
  'Close Combat':   { type:'Fighting', power:120, accuracy:1.00, pp:5,  contact:true,  statEffect:[{target:'self',stat:'def',change:-1}] },
  'High Jump Kick': { type:'Fighting', power:130, accuracy:0.90, pp:10, contact:true },
  'Mach Punch':     { type:'Fighting', power:40,  accuracy:1.00, pp:30, contact:true,  priority:1 },
  'Drain Punch':    { type:'Fighting', power:75,  accuracy:1.00, pp:10, contact:true,  effect:{type:'drain',amount:0.50} },
  'Superpower':     { type:'Fighting', power:120, accuracy:1.00, pp:5,  contact:true,  statEffect:[{target:'self',stat:'atk',change:-1},{target:'self',stat:'def',change:-1}] },
  'Focus Blast':    { type:'Fighting', power:120, accuracy:0.70, pp:5,  contact:false },
  'Bulk Up':        { type:'Fighting', power:0,   accuracy:null, pp:20, effect:{type:'stat-self', stages:[{stat:'atk',change:1},{stat:'def',change:1}]} },

  // ── Grass ─────────────────────────────────────────────────────────────────
  'Energy Ball':  { type:'Grass', power:90,  accuracy:1.00, pp:10, contact:false },
  'Leaf Blade':   { type:'Grass', power:90,  accuracy:1.00, pp:15, contact:true,  highCrit:true },
  'Power Whip':   { type:'Grass', power:120, accuracy:0.85, pp:10, contact:true },
  'Giga Drain':   { type:'Grass', power:75,  accuracy:1.00, pp:10, contact:false, effect:{type:'drain',amount:0.50} },
  'Seed Bomb':    { type:'Grass', power:80,  accuracy:1.00, pp:15, contact:false },
  'Leaf Storm':   { type:'Grass', power:130, accuracy:0.90, pp:5,  contact:false, statEffect:[{target:'self',stat:'atk',change:-2}] },
  'Solar Beam':   { type:'Grass', power:90,  accuracy:1.00, pp:10, contact:false },
  'Sleep Powder': { type:'Grass', power:0,   accuracy:0.75, pp:15, effect:{type:'sleep',chance:1.0} },
  'Spore':        { type:'Grass', power:0,   accuracy:1.00, pp:15, effect:{type:'sleep',chance:1.0} },

  // ── Water ─────────────────────────────────────────────────────────────────
  'Surf':        { type:'Water', power:90,  accuracy:1.00, pp:15, contact:false },
  'Hydro Pump':  { type:'Water', power:110, accuracy:0.80, pp:5,  contact:false },
  'Waterfall':   { type:'Water', power:80,  accuracy:1.00, pp:15, contact:true,  effect:{type:'flinch',chance:0.20} },
  'Aqua Jet':    { type:'Water', power:40,  accuracy:1.00, pp:20, contact:true,  priority:1 },
  'Scald':       { type:'Water', power:80,  accuracy:1.00, pp:15, contact:false, effect:{type:'burn',chance:0.30} },
  'Aqua Tail':   { type:'Water', power:90,  accuracy:0.90, pp:10, contact:true },
  'Liquidation': { type:'Water', power:85,  accuracy:1.00, pp:10, contact:true,  statEffect:[{target:'opp',stat:'def',change:-1,chance:0.20}] },

  // ── Rock ──────────────────────────────────────────────────────────────────
  'Stone Edge':   { type:'Rock', power:100, accuracy:0.80, pp:5,  contact:false, highCrit:true },
  'Rock Slide':   { type:'Rock', power:75,  accuracy:0.90, pp:10, contact:false, effect:{type:'flinch',chance:0.30} },
  'Power Gem':    { type:'Rock', power:80,  accuracy:1.00, pp:20, contact:false },
  'Head Smash':   { type:'Rock', power:150, accuracy:0.80, pp:5,  contact:true,  recoil:0.50 },
  'Ancient Power':{ type:'Rock', power:60,  accuracy:1.00, pp:5,  contact:false, effect:{type:'stat-self',stages:[{stat:'atk',change:1},{stat:'def',change:1},{stat:'spd',change:1}],chance:0.10} },
  'Rock Polish':  { type:'Rock', power:0,   accuracy:null, pp:20, effect:{type:'stat-self',stages:[{stat:'spd',change:2}]} },

  // ── Poison ────────────────────────────────────────────────────────────────
  'Poison Jab':   { type:'Poison', power:80,  accuracy:1.00, pp:20, contact:true,  effect:{type:'poison',chance:0.30} },
  'Sludge Bomb':  { type:'Poison', power:90,  accuracy:1.00, pp:10, contact:false, effect:{type:'poison',chance:0.30} },
  'Gunk Shot':    { type:'Poison', power:120, accuracy:0.80, pp:5,  contact:false, effect:{type:'poison',chance:0.30} },
  'Cross Poison': { type:'Poison', power:70,  accuracy:1.00, pp:20, contact:true,  highCrit:true, effect:{type:'poison',chance:0.10} },
  'Venoshock':    { type:'Poison', power:65,  accuracy:1.00, pp:10, contact:false },
  'Acid Spray':   { type:'Poison', power:40,  accuracy:1.00, pp:20, contact:false, statEffect:[{target:'opp',stat:'def',change:-2}] },
  'Coil':         { type:'Poison', power:0,   accuracy:null, pp:20, effect:{type:'stat-self',stages:[{stat:'atk',change:1},{stat:'def',change:1}]} },
  'Toxic':        { type:'Poison', power:0,   accuracy:0.90, pp:10, effect:{type:'poison',chance:1.0} },

  // ── Psychic ───────────────────────────────────────────────────────────────
  'Psychic':         { type:'Psychic', power:90, accuracy:1.00, pp:10, contact:false },
  'Extrasensory':    { type:'Psychic', power:80, accuracy:1.00, pp:20, contact:false, effect:{type:'flinch',chance:0.10} },
  'Zen Headbutt':    { type:'Psychic', power:80, accuracy:0.90, pp:15, contact:true,  effect:{type:'flinch',chance:0.20} },
  'Expanding Force': { type:'Psychic', power:80, accuracy:1.00, pp:10, contact:false },
};
