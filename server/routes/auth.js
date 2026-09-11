const express = require('express');
const db = require('../db');
const { hashPassword, verifyPassword } = require('../lib/auth');

const router = express.Router();

function userCount() {
  return db.prepare('SELECT COUNT(*) c FROM users').get().c;
}

// ---- First-run setup: create the initial Admin account. Only reachable while
// the users table is empty, so there's never a hardcoded default password
// sitting in the source — the first real person to open the app sets it. ----
router.get('/setup', (req, res) => {
  if (userCount() > 0) return res.redirect('/login');
  res.render('setup', { error: null, full_name: '', username: '' });
});

router.post('/setup', (req, res) => {
  if (userCount() > 0) return res.redirect('/login');
  const { full_name, username, password, confirm_password } = req.body;
  const cleanUsername = (username || '').trim().toLowerCase();
  const render = (error) => res.render('setup', { error, full_name: full_name || '', username: cleanUsername });

  if (!cleanUsername) return render('Enter a username.');
  if (!password || password.length < 6) return render('Password must be at least 6 characters.');
  if (password !== confirm_password) return render('Passwords do not match.');

  const adminRole = db.prepare("SELECT id FROM roles WHERE name = 'Admin'").get();
  const createFirstAdmin = db.transaction(() => {
    const id = db
      .prepare('INSERT INTO users (username, password_hash, full_name, role_id) VALUES (?, ?, ?, ?)')
      .run(cleanUsername, hashPassword(password), (full_name || '').trim() || null, adminRole ? adminRole.id : null)
      .lastInsertRowid;
    // The first admin gets every farm, otherwise they'd be locked out of the
    // workspace they just created the account in.
    const grant = db.prepare('INSERT INTO user_farms (user_id, farm_id) VALUES (?, ?)');
    db.prepare('SELECT id FROM farms').all().forEach((f) => grant.run(id, f.id));
    return id;
  });

  req.session.userId = createFirstAdmin();
  res.redirect('/');
});

// ---- Login / logout ----
router.get('/login', (req, res) => {
  if (userCount() === 0) return res.redirect('/setup');
  res.render('login', { error: null, next: req.query.next || '/' });
});

router.post('/login', (req, res) => {
  const { username, password } = req.body;
  const next = req.body.next || '/';
  const cleanUsername = (username || '').trim().toLowerCase();
  const user = db.prepare('SELECT * FROM users WHERE username = ? AND active = 1').get(cleanUsername);

  if (!user || !verifyPassword(password || '', user.password_hash)) {
    return res.render('login', { error: 'Incorrect username or password.', next });
  }

  req.session.regenerate((err) => {
    if (err) return res.render('login', { error: 'Could not log in, try again.', next });
    req.session.userId = user.id;
    res.redirect(next.startsWith('/') ? next : '/');
  });
});

router.post('/logout', (req, res) => {
  req.session.destroy(() => res.redirect('/login'));
});

module.exports = router;
