const fs = require('fs');
const path = require('path');
const db = require('../db');

// Backups live beside the live database, in the OS application-data directory.
// That protects against accidental deletion inside the app, NOT against losing
// the machine — copy this folder somewhere off-machine periodically too.
const BACKUP_DIR = path.join(db.dataDir, 'backups');

// How many snapshots to keep. Old ones are pruned newest-first beyond this.
const KEEP = Number(process.env.TRINITY_BACKUP_KEEP) || 30;

// A restart-heavy afternoon shouldn't flush real history out of the retention
// window, so a startup backup is skipped when a recent one already exists.
const STARTUP_MIN_AGE_MS = 15 * 60 * 1000;

const FILENAME_RE = /^trinity-agro-[\dT:-]+(?:-[a-z]+)?\.db$/;

function ensureDir() {
  if (!fs.existsSync(BACKUP_DIR)) fs.mkdirSync(BACKUP_DIR, { recursive: true });
}

// Ordered newest-first by the timestamp embedded in the filename rather than by
// file mtime: copying a backup folder around (or restoring one) rewrites mtimes,
// and pruning by mtime would then discard the wrong snapshots. The name records
// when the snapshot was actually taken.
function takenAt(file) {
  const m = file.match(/^trinity-agro-(\d{4}-\d{2}-\d{2})T(\d{2})-(\d{2})-(\d{2})/);
  if (!m) return null;
  const parsed = new Date(`${m[1]}T${m[2]}:${m[3]}:${m[4]}Z`);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

function listBackups() {
  ensureDir();
  return fs
    .readdirSync(BACKUP_DIR)
    .filter((f) => FILENAME_RE.test(f))
    .map((f) => {
      const stat = fs.statSync(path.join(BACKUP_DIR, f));
      return { file: f, size: stat.size, created: takenAt(f) || stat.mtime };
    })
    .sort((a, b) => b.created - a.created);
}

// Resolves a user-supplied filename to a real backup path, or null. Guards the
// download route against path traversal — only plain names that match the
// backup pattern and actually exist in the backup directory are accepted.
function resolveBackupPath(file) {
  if (!file || typeof file !== 'string') return null;
  if (file !== path.basename(file) || !FILENAME_RE.test(file)) return null;
  const full = path.join(BACKUP_DIR, file);
  return fs.existsSync(full) ? full : null;
}

function prune() {
  const all = listBackups();
  all.slice(KEEP).forEach((b) => {
    try {
      fs.unlinkSync(path.join(BACKUP_DIR, b.file));
    } catch (_) {
      /* a backup we couldn't remove is harmless — it just ages out next time */
    }
  });
}

// Uses SQLite's own online-backup API rather than copying the file. In WAL mode
// a plain file copy can capture a torn database (the .db without its -wal), so
// this is the only safe way to snapshot while the server is running.
async function backupNow(reason = 'manual') {
  ensureDir();
  const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const file = `trinity-agro-${stamp}-${reason}.db`;
  await db.backup(path.join(BACKUP_DIR, file));
  prune();
  return file;
}

function newestBackupAgeMs() {
  const [newest] = listBackups();
  return newest ? Date.now() - newest.created.getTime() : Infinity;
}

// One snapshot at boot (so there's always a restore point from before this
// run), then an hourly tick that takes a snapshot the first time it notices a
// new calendar day. Checking the day rather than counting 24h intervals means
// a machine that sleeps or restarts still gets its daily backup.
function start() {
  if (newestBackupAgeMs() >= STARTUP_MIN_AGE_MS) {
    backupNow('startup').catch((err) => console.error('Startup backup failed:', err.message));
  }

  setInterval(() => {
    const today = new Date().toISOString().slice(0, 10);
    const haveToday = listBackups().some((b) => b.file.includes(`trinity-agro-${today}`));
    if (!haveToday) {
      backupNow('daily').catch((err) => console.error('Daily backup failed:', err.message));
    }
  }, 60 * 60 * 1000);
}

module.exports = { BACKUP_DIR, KEEP, listBackups, resolveBackupPath, backupNow, start };
