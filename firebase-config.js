/* ============================================================
   FIREBASE CONFIGURATION — PrintIt
   ─────────────────────────────────────────────────────────────
   How to get your config values:
   1. Go to https://console.firebase.google.com
   2. Create a project (or open an existing one)
   3. Click ⚙️ Project Settings → General → "Your apps"
   4. Click </> (Web) → Register app → copy the firebaseConfig
   5. Paste the values below

   Services to enable in the Firebase Console:
   ─ Authentication  → Sign-in method → Email/Password  ✓
   ─ Firestore       → Create database (start in test mode)
   ─ Storage         → Get started (start in test mode)

   Admin account:
   ─ In Firebase Console → Authentication → Add user manually:
       Email:    admin@printit.in
       Password: admin123   (choose a strong password)
   ─ The app auto-assigns the "admin" role for this email.
============================================================ */

const firebaseConfig = {
  apiKey:            "AIzaSyAfkItTiV4ApRlgUDqjVtR3oE0GNDFYfqY",
  authDomain:        "printit-333ec.firebaseapp.com",
  projectId:         "printit-333ec",
  storageBucket:     "printit-333ec.firebasestorage.app",
  messagingSenderId: "624248255913",
  appId:             "1:624248255913:web:610a973fd806d100b500b8"
};

/* ── Initialize ── */
firebase.initializeApp(firebaseConfig);

const auth    = firebase.auth();
const db      = firebase.firestore();
const storage = firebase.storage();
