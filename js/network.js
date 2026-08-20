// ── PeerJS + Firebase Realtime Database networking ─────────────────────────────────
//
// Security model:
//   • Anonymous auth required by Firebase rules  (”.read/.write”: ”auth != null”)
//   • API key restricted to ispankzombiez.github.io in Google Cloud Console
//   • Data structure validated by Firebase rules
//
// Room codes: 6-char alphanumeric, PeerJS peer ID = ”yak-” + code.toLowerCase()

const ROOMS_PATH  = 'yak-battle/rooms';
const ROOM_TTL_MS = 10 * 60 * 1000;

// ── Firebase SDK (lazy singleton, anonymous auth) ────────────────────────────
let _db = null;

async function _initFirebase() {
  if (_db) return;
  if (!firebase.apps.length) firebase.initializeApp(FIREBASE_CONFIG);
  const auth = firebase.auth();
  if (!auth.currentUser) await auth.signInAnonymously();
  _db = firebase.database();
}

async function _fbGet(path)         { await _initFirebase(); return (await _db.ref(path).once('value')).val(); }
async function _fbSet(path, data)    { await _initFirebase(); await _db.ref(path).set(data); }
async function _fbUpdate(path, data) { await _initFirebase(); await _db.ref(path).update(data); }
async function _fbRemove(path)       { await _initFirebase(); await _db.ref(path).remove(); }

let _peer           = null;
let _conn           = null;
let _onMessage      = null;
let _onDisconnect   = null;
let _myRoomCode     = null; // the 6-char code if we're hosting

// ── Helpers ──────────────────────────────────────────────────────────────────

function _randomCode() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // no 0/O/1/I ambiguity
  let code = '';
  for (let i = 0; i < 6; i++) code += chars[Math.floor(Math.random() * chars.length)];
  return code;
}

function codeToPeerId(code) {
  return 'yak-' + code.toLowerCase();
}

function peerIdToCode(peerId) {
  return peerId.replace(/^yak-/, '').toUpperCase();
}

function _setupConn(conn) {
  _conn = conn;
  conn.on('data',  data  => _onMessage  && _onMessage(data));
  conn.on('close', ()    => _onDisconnect && _onDisconnect());
  conn.on('error', ()    => _onDisconnect && _onDisconnect());
}

// ── Public API ────────────────────────────────────────────────────────────────

function netSetHandlers({ onMessage, onDisconnect }) {
  _onMessage    = onMessage;
  _onDisconnect = onDisconnect;
}

/**
 * Host a battle. Returns { code } on success.
 * isPublic: if true, registers the room in Firebase.
 */
async function netHost(playerName, isPublic) {
  return new Promise((resolve, reject) => {
    let attempts = 0;

    function tryCreate() {
      attempts++;
      const code   = _randomCode();
      const peerId = codeToPeerId(code);

      _peer = new Peer(peerId);

      _peer.on('open', async () => {
        _myRoomCode = code;

        if (isPublic) {
          try {
            await _fbSet(`${ROOMS_PATH}/${peerId}`, {
              hostName:  playerName,
              peerId,
              code,
              createdAt: Date.now(),
              status:    'waiting',
            });
          } catch {
            // Non-fatal — battle can still work without Firebase listing
          }
        }

        _peer.on('connection', conn => _setupConn(conn));
        resolve({ code });
      });

      _peer.on('error', err => {
        if (err.type === 'unavailable-id' && attempts < 5) {
          _peer.destroy();
          _peer = null;
          tryCreate();
        } else {
          reject(err);
        }
      });
    }

    tryCreate();
  });
}

/**
 * Join a battle by 6-char code. Returns when connection is open.
 */
async function netJoin(code) {
  const peerId = codeToPeerId(code.trim());

  return new Promise((resolve, reject) => {
    _peer = new Peer(); // random ID for guest
    _peer.on('open', () => {
      const conn = _peer.connect(peerId, { reliable: true });
      conn.on('open',  () => { _setupConn(conn); resolve(); });
      conn.on('error', reject);
    });
    _peer.on('error', reject);

    // Timeout after 12 s so users get a clear error
    setTimeout(() => reject(new Error('Connection timed out. Check the code and try again.')), 12000);
  });
}

/** Send a message to the connected peer. */
function netSend(data) {
  if (_conn && _conn.open) _conn.send(data);
}

/** Close connection and destroy peer. Removes public room if we hosted one. */
async function netDisconnect() {
  if (_myRoomCode) {
    try { await _fbRemove(`${ROOMS_PATH}/${codeToPeerId(_myRoomCode)}`); } catch { /* ok */ }
    _myRoomCode = null;
  }
  if (_conn)  { _conn.close();    _conn  = null; }
  if (_peer)  { _peer.destroy();  _peer  = null; }
}

/** Mark hosted room as full (called once a guest connects). */
async function netCloseRoom() {
  if (!_myRoomCode) return;
  try {
    await _fbUpdate(`${ROOMS_PATH}/${codeToPeerId(_myRoomCode)}`, { status: 'full' });
  } catch { /* ok */ }
}

/** Fetch public waiting rooms from Firebase. Returns array of room objects. */
async function netGetPublicRooms() {
  try {
    const data = await _fbGet(ROOMS_PATH);
    if (!data) return [];
    const now = Date.now();
    return Object.values(data).filter(
      r => r.status === 'waiting' && (now - r.createdAt) < ROOM_TTL_MS
    );
  } catch {
    return [];
  }
}
