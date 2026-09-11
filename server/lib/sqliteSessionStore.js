const session = require('express-session');
const db = require('../db');

// A ~50-line SQLite-backed session store against the `sessions` table (see
// db.js) instead of pulling in connect-sqlite3: keeps logins alive across a
// server restart, in the same one .db file this whole app already backs up,
// without adding a second SQLite dependency alongside better-sqlite3.
class SqliteSessionStore extends session.Store {
  get(sid, cb) {
    try {
      const row = db.prepare('SELECT sess, expires FROM sessions WHERE sid = ?').get(sid);
      if (!row) return cb(null, null);
      if (row.expires && row.expires < Date.now()) {
        db.prepare('DELETE FROM sessions WHERE sid = ?').run(sid);
        return cb(null, null);
      }
      cb(null, JSON.parse(row.sess));
    } catch (err) {
      cb(err);
    }
  }

  set(sid, sess, cb) {
    try {
      const expires = sess.cookie && sess.cookie.expires ? new Date(sess.cookie.expires).getTime() : Date.now() + 30 * 86400000;
      db.prepare(
        `INSERT INTO sessions (sid, sess, expires) VALUES (?, ?, ?)
         ON CONFLICT(sid) DO UPDATE SET sess = excluded.sess, expires = excluded.expires`
      ).run(sid, JSON.stringify(sess), expires);
      cb && cb();
    } catch (err) {
      cb && cb(err);
    }
  }

  destroy(sid, cb) {
    try {
      db.prepare('DELETE FROM sessions WHERE sid = ?').run(sid);
      cb && cb();
    } catch (err) {
      cb && cb(err);
    }
  }

  touch(sid, sess, cb) {
    this.set(sid, sess, cb);
  }
}

module.exports = SqliteSessionStore;
