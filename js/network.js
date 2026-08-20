// ── PeerJS + Firebase Realtime Database networking ───────────────────────────
//
// Firebase path: /yak-battle/rooms/{roomCode}
// Firebase rules needed (set in your Firebase console):
//   "yak-battle": { ".read": true, ".write": true }
//
// Room codes: 6-char alphanumeric, PeerJS peer ID = "yak-" + code.toLowerCase()
// e.g. display code "A3B4C5" → peer ID "yak-a3b4c5"

const FIREBASE_BASE = 'https://sfl-calculator-default-rtdb.firebaseio.com/yak-battle/rooms';
const ROOM_TTL_MS   = 10 * 60 * 1000; // hide rooms older than 10 minutes

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
            await _firebasePut(`${FIREBASE_BASE}/${peerId}.json`, {
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
    try { await _firebaseDelete(`${FIREBASE_BASE}/${codeToPeerId(_myRoomCode)}.json`); } catch { /* ok */ }
    _myRoomCode = null;
  }
  if (_conn)  { _conn.close();    _conn  = null; }
  if (_peer)  { _peer.destroy();  _peer  = null; }
}

/** Mark hosted room as full (called once a guest connects). */
async function netCloseRoom() {
  if (!_myRoomCode) return;
  try {
    await _firebasePut(`${FIREBASE_BASE}/${codeToPeerId(_myRoomCode)}/status.json`, 'full');
  } catch { /* ok */ }
}

/** Fetch public waiting rooms from Firebase. Returns array of room objects. */
async function netGetPublicRooms() {
  try {
    const data = await _firebaseGet(`${FIREBASE_BASE}.json`);
    if (!data) return [];
    const now = Date.now();
    return Object.values(data).filter(
      r => r.status === 'waiting' && (now - r.createdAt) < ROOM_TTL_MS
    );
  } catch {
    return [];
  }
}

// ── Firebase REST helpers ─────────────────────────────────────────────────────

async function _firebaseGet(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Firebase GET failed: ${res.status}`);
  return res.json();
}

async function _firebasePut(url, body) {
  const res = await fetch(url, {
    method:  'PUT',
    headers: { 'Content-Type': 'application/json' },
    body:    JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`Firebase PUT failed: ${res.status}`);
}

async function _firebaseDelete(url) {
  await fetch(url, { method: 'DELETE' });
}
