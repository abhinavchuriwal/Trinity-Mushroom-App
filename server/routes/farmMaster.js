const express = require('express');
const db = require('../db');
const { requirePermission } = require('../lib/auth');

const router = express.Router();

function str(v) {
  return v === undefined || v === '' ? null : v;
}

// Growing rooms, tunnels, and bunkers are structurally identical master lists
// (code/name/notes/active) — one small factory instead of three near-copies
// of the same add/edit/delete routes.
function crudRoutes(table, label) {
  const sub = express.Router();
  sub.use(requirePermission('manage_farm_master'));

  sub.post('/', (req, res) => {
    const cleanCode = (req.body.code || '').trim();
    if (!cleanCode) {
      return res.redirect(`/farm-master?error=${encodeURIComponent(`Enter a ${label} code.`)}`);
    }
    try {
      db.prepare(`INSERT INTO ${table} (code, name, notes) VALUES (?, ?, ?)`).run(
        cleanCode,
        str(req.body.name),
        str(req.body.notes)
      );
    } catch (e) {
      return res.redirect(`/farm-master?error=${encodeURIComponent(`"${cleanCode}" already exists.`)}`);
    }
    res.redirect('/farm-master');
  });

  sub.post('/:id', (req, res) => {
    const cleanCode = (req.body.code || '').trim();
    try {
      db.prepare(
        `UPDATE ${table} SET code = ?, name = ?, notes = ?, active = ?, updated_at = datetime('now') WHERE id = ?`
      ).run(cleanCode, str(req.body.name), str(req.body.notes), req.body.active ? 1 : 0, req.params.id);
    } catch (e) {
      return res.redirect(`/farm-master?error=${encodeURIComponent(`"${cleanCode}" already exists.`)}`);
    }
    res.redirect('/farm-master');
  });

  sub.post('/:id/delete', (req, res) => {
    db.prepare(`DELETE FROM ${table} WHERE id = ?`).run(req.params.id);
    res.redirect('/farm-master');
  });

  return sub;
}

router.get('/', (req, res) => {
  res.render('farm-master', {
    growingRooms: db.prepare('SELECT * FROM growing_rooms ORDER BY active DESC, code').all(),
    tunnels: db.prepare('SELECT * FROM tunnels ORDER BY active DESC, code').all(),
    bunkers: db.prepare('SELECT * FROM bunkers ORDER BY active DESC, code').all(),
    error: req.query.error || null,
    settingsPage: 'farm-master',
  });
});

router.use('/rooms', crudRoutes('growing_rooms', 'growing room'));
router.use('/tunnels', crudRoutes('tunnels', 'tunnel'));
router.use('/bunkers', crudRoutes('bunkers', 'bunker'));

module.exports = router;
