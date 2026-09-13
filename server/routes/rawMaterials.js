const express = require('express');
const db = require('../db');
const { requirePermission } = require('../lib/auth');

const router = express.Router();

function num(v) {
  if (v === undefined || v === null || v === '') return null;
  const n = Number(v);
  return Number.isNaN(n) ? null : n;
}

function str(v) {
  return v === undefined || v === '' ? null : v;
}

router.get('/', (req, res) => {
  const materials = db.prepare('SELECT * FROM raw_materials ORDER BY active DESC, name').all();
  res.render('raw-materials', { materials, error: req.query.error || null });
});

router.post('/', requirePermission('manage_raw_materials'), (req, res) => {
  const { name, default_cost_per_kg_npr, carbon_pct, nitrogen_pct, moisture_pct, notes } = req.body;
  const cleanName = (name || '').trim();
  if (!cleanName) {
    return res.redirect(`/raw-materials?error=${encodeURIComponent('Enter a material name.')}`);
  }
  try {
    db.prepare(
      `INSERT INTO raw_materials (name, default_cost_per_kg_npr, carbon_pct, nitrogen_pct, moisture_pct, notes)
       VALUES (?, ?, ?, ?, ?, ?)`
    ).run(cleanName, num(default_cost_per_kg_npr), num(carbon_pct), num(nitrogen_pct), num(moisture_pct), str(notes));
  } catch (e) {
    return res.redirect(`/raw-materials?error=${encodeURIComponent(`"${cleanName}" already exists.`)}`);
  }
  res.redirect('/raw-materials');
});

router.post('/:id', requirePermission('manage_raw_materials'), (req, res) => {
  const { name, default_cost_per_kg_npr, carbon_pct, nitrogen_pct, moisture_pct, notes, active } = req.body;
  db.prepare(
    `UPDATE raw_materials
     SET name = ?, default_cost_per_kg_npr = ?, carbon_pct = ?, nitrogen_pct = ?, moisture_pct = ?, notes = ?, active = ?, updated_at = datetime('now')
     WHERE id = ?`
  ).run(
    (name || '').trim(),
    num(default_cost_per_kg_npr),
    num(carbon_pct),
    num(nitrogen_pct),
    num(moisture_pct),
    str(notes),
    active ? 1 : 0,
    req.params.id
  );
  res.redirect('/raw-materials');
});

router.post('/:id/delete', requirePermission('manage_raw_materials'), (req, res) => {
  db.prepare('DELETE FROM raw_materials WHERE id = ?').run(req.params.id);
  res.redirect('/raw-materials');
});

module.exports = router;
