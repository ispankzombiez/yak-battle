// ── Firebase Configuration ────────────────────────────────────────────────────
//
// HOW TO GET THESE VALUES:
//   1. Go to https://console.firebase.google.com
//   2. Open your project (sfl-calculator)
//   3. Click the gear icon → "Project settings"
//   4. Scroll to "Your apps" → click your web app (or "Add app" if none exists)
//   5. Copy the firebaseConfig object values below
//
// HOW TO RESTRICT THE API KEY (prevents use from other domains):
//   1. Go to https://console.cloud.google.com/apis/credentials
//   2. Find "Browser key (auto created by Firebase)" and click it
//   3. Under "Application restrictions" select "HTTP referrers (websites)"
//   4. Add:  https://ispankzombiez.github.io/*
//   5. Add:  http://localhost/*     ← keeps local dev working
//   6. Click Save

const FIREBASE_CONFIG = {
  apiKey:            'AIzaSyAv5mzdWcWJUwfZIwApkyWR9Vn2rGTwnyM',
  authDomain:        'sfl-calculator.firebaseapp.com',
  databaseURL:       'https://sfl-calculator-default-rtdb.firebaseio.com',
  projectId:         'sfl-calculator',
  storageBucket:     'sfl-calculator.firebasestorage.app',
  messagingSenderId: '279520711470',
  appId:             '1:279520711470:web:998b6d743a4f3a7e76e0bf',
  measurementId:     'G-WR0Q9QQ474',
};
