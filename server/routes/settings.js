const express = require('express');
const db = require('../db');
const qc = require('../lib/qc');
const { requirePermission } = require('../lib/auth');

const router = express.Router();

const STAGE_ORDER = ['intake', 'phase1', 'phase2', 'spawning', 'casing'];

router.get('/', (req, res) => {
  const params = db
    .prepare('SELECT * FROM qc_parameters ORDER BY id')
    .all()
    .sort((a, b) => STAGE_ORDER.indexOf(a.stage) - STAGE_ORDER.indexOf(b.stage));
  res.render('settings', { params, settingsPage: 'qc' });
});

router.post('/qc-parameters/:id', requirePermission('manage_qc_settings'), (req, res) => {
  const { min_value, max_value } = req.body;
  db.prepare('UPDATE qc_parameters SET min_value = ?, max_value = ? WHERE id = ?').run(
    min_value === '' ? null : Number(min_value),
    max_value === '' ? null : Number(max_value),
    req.params.id
  );
  qc.invalidate();
  res.redirect('/settings');
});

module.exports = router;
