// ── Firebase app initialisation + email/password auth ─────────────────────────
//
// Must be loaded AFTER firebase-config.js and BEFORE app.js.

firebase.initializeApp(FIREBASE_CONFIG);

const _auth = firebase.auth();
let _currentPlayer = null; // { uid, username, wins, losses }

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
    if (user) {
      // Unverified accounts are not allowed in
      if (!user.emailVerified) {
        await _auth.signOut().catch(() => {});
        return; // onAuthStateChanged re-fires with null
      }
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

// ── Auth screen UI wiring ─────────────────────────────────────────────────────

document.getElementById('auth-tab-login').addEventListener('click', () => {
  document.getElementById('auth-tab-login').classList.add('active');
  document.getElementById('auth-tab-register').classList.remove('active');
  document.getElementById('auth-form-login').classList.remove('hidden');
  document.getElementById('auth-form-register').classList.add('hidden');
  document.getElementById('auth-error').textContent = '';
  document.getElementById('auth-verify-msg').classList.add('hidden');
});

document.getElementById('auth-tab-register').addEventListener('click', () => {
  document.getElementById('auth-tab-register').classList.add('active');
  document.getElementById('auth-tab-login').classList.remove('active');
  document.getElementById('auth-form-register').classList.remove('hidden');
  document.getElementById('auth-form-login').classList.add('hidden');
  document.getElementById('auth-error').textContent = '';
  document.getElementById('auth-verify-msg').classList.add('hidden');
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
    const user = _auth.currentUser;
    if (user && !user.emailVerified) {
      // Resend verification while briefly signed in, then boot them out
      try { await user.sendEmailVerification(); } catch { /* rate-limit is ok */ }
      await _auth.signOut();
      _showVerifyMsg(`A new verification link has been sent to <b>${email}</b>. Check your inbox and click the link before logging in.`);
      btn.disabled = false;
      return;
    }
    // Verified — onAuthStateChanged takes it from here
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
  if (username.length < 3 || username.length > 16) {
    errEl.textContent = 'Username must be 3–16 characters.'; return;
  }
  if (!/^[A-Za-z0-9_]+$/.test(username)) {
    errEl.textContent = 'Username: letters, numbers, underscores only.'; return;
  }
  if (pass.length < 6) { errEl.textContent = 'Password must be at least 6 characters.'; return; }
  if (pass !== confirm) { errEl.textContent = 'Passwords do not match.'; return; }

  const btn = document.getElementById('auth-btn-register');
  btn.disabled = true;
  const lc = username.toLowerCase();

  try {
    // Create auth account first so all subsequent DB writes are authenticated
    const userCred = await _auth.createUserWithEmailAndPassword(email, pass);
    const uid = userCred.user.uid;

    // Atomically claim the username — transaction aborts if already taken
    const usernameRef = firebase.database().ref('yak-battle/usernames/' + lc);
    let claimed = false;
    await usernameRef.transaction(current => {
      if (current !== null) return; // abort
      claimed = true;
      return uid;
    });

    if (!claimed) {
      await userCred.user.delete(); // release auth account — username was taken
      errEl.textContent = 'Username already taken.';
      btn.disabled = false;
      return;
    }

    // Write player record (username already set to uid by transaction above)
    await firebase.database().ref('yak-battle/players/' + uid).set({
      username,
      wins:      0,
      losses:    0,
      createdAt: Date.now(),
    });

    // Send verification email then immediately sign out — must verify before playing
    await userCred.user.sendEmailVerification();
    await _auth.signOut();

    ['auth-reg-username', 'auth-reg-email', 'auth-reg-password', 'auth-reg-confirm']
      .forEach(id => { document.getElementById(id).value = ''; });

    _showVerifyMsg(`Account created! A verification email has been sent to <b>${email}</b>.<br>Click the link in your inbox, then come back and log in.`);
    btn.disabled = false;
  } catch (e) {
    errEl.textContent = _friendlyAuthError(e);
    btn.disabled = false;
  }
});

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
