// ── Firebase app initialisation + email/password auth ─────────────────────────
//
// Must be loaded AFTER firebase-config.js and BEFORE app.js.

firebase.initializeApp(FIREBASE_CONFIG);

const _auth = firebase.auth();
let _currentPlayer = null; // { uid, username, wins, losses }
let _isRegistering = false;
let _pending = null; // { username, email, pass, lc, code, expiresAt, attempts }

function authGetCurrentPlayer() { return _currentPlayer; }

async function authLogout() {
  _currentPlayer = null;
  await _auth.signOut();
}

// ── Boot entry point called by app.js ────────────────────────────────────────
// onLogin fires each time auth state changes to a signed-in, verified user with
// a valid player record. Shows screen-auth when no valid session exists.
function authInit(onLogin) {
  _auth.onAuthStateChanged(async user => {
    if (_isRegistering) return;
    if (user) {
      try {
        const snap = await firebase.database()
          .ref('yak-battle/players/' + user.uid).once('value');
        if (snap.exists()) {
          _currentPlayer = { ...snap.val(), uid: user.uid };
          onLogin(_currentPlayer);
          return;
        }
      } catch { /* fall through to show auth */ }
      // Auth account exists but no player record — sign out cleanly
      await _auth.signOut().catch(() => {});
      return;
    }
    _currentPlayer = null;
    document.querySelectorAll('.screen').forEach(s => s.classList.remove('active'));
    document.getElementById('screen-auth').classList.add('active');
  });
}

// ── OTP verification helpers ─────────────────────────────────────────────────

function _generateOtp() {
  return String(Math.floor(100000 + Math.random() * 900000));
}

async function _sendOtp() {
  _pending.code = _generateOtp();
  _pending.expiresAt = Date.now() + 10 * 60 * 1000; // 10 minutes
  _pending.attempts = 0;
  await emailjs.send(EMAILJS_SERVICE_ID, EMAILJS_TEMPLATE_ID, {
    to_name:  _pending.username,
    to_email: _pending.email,
    otp_code: _pending.code,
  }, EMAILJS_PUBLIC_KEY);
}

function _showVerifyPanel() {
  document.getElementById('auth-form-register').classList.add('hidden');
  document.getElementById('auth-form-verify').classList.remove('hidden');
  document.getElementById('auth-verify-email-display').textContent = _pending.email;
  document.getElementById('auth-verify-code').value = '';
  document.getElementById('auth-error').textContent = '';
  document.getElementById('auth-verify-msg').classList.add('hidden');
}

function _hideVerifyPanel() {
  document.getElementById('auth-form-verify').classList.add('hidden');
  document.getElementById('auth-form-register').classList.remove('hidden');
  _pending = null;
}

// ── Auth screen UI wiring ─────────────────────────────────────────────────────

document.getElementById('auth-tab-login').addEventListener('click', () => {
  document.getElementById('auth-tab-login').classList.add('active');
  document.getElementById('auth-tab-register').classList.remove('active');
  document.getElementById('auth-form-login').classList.remove('hidden');
  document.getElementById('auth-form-register').classList.add('hidden');
  document.getElementById('auth-form-verify').classList.add('hidden');
  document.getElementById('auth-error').textContent = '';
  document.getElementById('auth-verify-msg').classList.add('hidden');
  _pending = null;
});

document.getElementById('auth-tab-register').addEventListener('click', () => {
  document.getElementById('auth-tab-register').classList.add('active');
  document.getElementById('auth-tab-login').classList.remove('active');
  document.getElementById('auth-form-login').classList.add('hidden');
  document.getElementById('auth-error').textContent = '';
  document.getElementById('auth-verify-msg').classList.add('hidden');
  if (_pending) {
    _showVerifyPanel();
  } else {
    document.getElementById('auth-form-register').classList.remove('hidden');
  }
});

document.getElementById('auth-btn-login').addEventListener('click', async () => {
  const email = document.getElementById('auth-login-email').value.trim();
  const pass  = document.getElementById('auth-login-password').value;
  const errEl = document.getElementById('auth-error');
  errEl.textContent = '';
  document.getElementById('auth-verify-msg').classList.add('hidden');
  if (!email || !pass) { errEl.textContent = 'Please enter email and password.'; return; }
  const btn = document.getElementById('auth-btn-login');
  btn.disabled = true;
  try {
    await _auth.signInWithEmailAndPassword(email, pass);
    // onAuthStateChanged takes it from here
  } catch (e) {
    errEl.textContent = _friendlyAuthError(e);
    btn.disabled = false;
  }
});

document.getElementById('auth-btn-register').addEventListener('click', async () => {
  const username = document.getElementById('auth-reg-username').value.trim();
  const email    = document.getElementById('auth-reg-email').value.trim();
  const pass     = document.getElementById('auth-reg-password').value;
  const confirm  = document.getElementById('auth-reg-confirm').value;
  const errEl    = document.getElementById('auth-error');
  errEl.textContent = '';
  document.getElementById('auth-verify-msg').classList.add('hidden');

  if (!username || !email || !pass || !confirm) { errEl.textContent = 'All fields are required.'; return; }
  if (username.length < 3 || username.length > 16) { errEl.textContent = 'Username must be 3–16 characters.'; return; }
  if (!/^[A-Za-z0-9_]+$/.test(username)) { errEl.textContent = 'Username: letters, numbers, underscores only.'; return; }
  if (pass.length < 6) { errEl.textContent = 'Password must be at least 6 characters.'; return; }
  if (pass !== confirm) { errEl.textContent = 'Passwords do not match.'; return; }

  const btn = document.getElementById('auth-btn-register');
  btn.disabled = true;
  _pending = { username, email, pass, lc: username.toLowerCase() };

  try {
    await _sendOtp();
    _showVerifyPanel();
  } catch (e) {
    _pending = null;
    errEl.textContent = 'Could not send verification email. Check your connection and try again.';
  }
  btn.disabled = false;
});

// ── Verify code handler ───────────────────────────────────────────────────────

document.getElementById('auth-btn-verify').addEventListener('click', async () => {
  const code  = document.getElementById('auth-verify-code').value.trim();
  const errEl = document.getElementById('auth-error');
  errEl.textContent = '';
  document.getElementById('auth-verify-msg').classList.add('hidden');

  if (!_pending) { errEl.textContent = 'Session expired. Please register again.'; return; }
  if (Date.now() > _pending.expiresAt) { errEl.textContent = 'Code expired. Click Resend.'; return; }
  if (_pending.attempts >= 3) { errEl.textContent = 'Too many attempts. Click Resend.'; return; }
  if (code !== _pending.code) {
    _pending.attempts++;
    const left = 3 - _pending.attempts;
    errEl.textContent = left > 0 ? `Incorrect code. ${left} attempt(s) remaining.` : 'Too many attempts. Click Resend.';
    return;
  }

  const btn   = document.getElementById('auth-btn-verify');
  const resnd = document.getElementById('auth-btn-resend');
  btn.disabled = resnd.disabled = true;
  const { username, email, pass, lc } = _pending;

  _isRegistering = true;
  try {
    const userCred = await _auth.createUserWithEmailAndPassword(email, pass);
    const uid = userCred.user.uid;

    const usernameRef = firebase.database().ref('yak-battle/usernames/' + lc);
    let claimed = false;
    await usernameRef.transaction(current => {
      if (current !== null) return;
      claimed = true;
      return uid;
    });

    if (!claimed) {
      await userCred.user.delete();
      _hideVerifyPanel();
      errEl.textContent = 'That username was just taken. Please register again with a different one.';
      return; // finally resets flags
    }

    await firebase.database().ref('yak-battle/players/' + uid).set({
      username, wins: 0, losses: 0, createdAt: Date.now(),
    });

    _pending = null;
    _isRegistering = false; // allow onAuthStateChanged(null) to show auth screen
    await _auth.signOut();

    _hideVerifyPanel();
    ['auth-reg-username', 'auth-reg-email', 'auth-reg-password', 'auth-reg-confirm']
      .forEach(id => { document.getElementById(id).value = ''; });
    _showVerifyMsg('Account created! You can now log in.');
  } catch (e) {
    errEl.textContent = _friendlyAuthError(e);
  } finally {
    _isRegistering = false;
    btn.disabled = resnd.disabled = false;
  }
});

// ── Resend code handler ───────────────────────────────────────────────────────

document.getElementById('auth-btn-resend').addEventListener('click', async () => {
  const errEl = document.getElementById('auth-error');
  if (!_pending) return;
  const btn = document.getElementById('auth-btn-resend');
  btn.disabled = true;
  try {
    await _sendOtp();
    document.getElementById('auth-verify-code').value = '';
    errEl.textContent = '';
    _showVerifyMsg('A new code has been sent.');
  } catch {
    errEl.textContent = 'Failed to resend. Check your connection.';
  }
  btn.disabled = false;
});

// ── Back to register form ─────────────────────────────────────────────────────

document.getElementById('auth-btn-back-register').addEventListener('click', () => {
  _hideVerifyPanel();
  document.getElementById('auth-error').textContent = '';
  document.getElementById('auth-verify-msg').classList.add('hidden');
});

// ── Helpers ───────────────────────────────────────────────────────────────────

function _showVerifyMsg(html) {
  const el = document.getElementById('auth-verify-msg');
  el.innerHTML = html;
  el.classList.remove('hidden');
}

function _friendlyAuthError(e) {
  const map = {
    'auth/user-not-found':         'No account found with this email.',
    'auth/wrong-password':         'Incorrect password.',
    'auth/invalid-credential':     'Incorrect email or password.',
    'auth/email-already-in-use':   'An account with this email already exists.',
    'auth/invalid-email':          'Invalid email address.',
    'auth/weak-password':          'Password must be at least 6 characters.',
    'auth/too-many-requests':      'Too many attempts. Please wait and try again.',
    'auth/network-request-failed': 'Network error. Check your connection.',
  };
  return map[e.code] || e.message || 'An error occurred.';
}
