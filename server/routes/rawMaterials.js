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

// Which recipe a material belongs to: the compost mix, the casing mix, or both.
function cat(v) {
  return ['compost', 'casing', 'both'].includes(v) ? v : 'compost';
}

router.get('/', (req, res) => {
  const materials = db.prepare('SELECT * FROM raw_materials ORDER BY active DESC, category, name').all();
  res.render('raw-materials', { materials, settingsPage: 'raw-materials', saved: !!req.query.saved, error: req.query.error || null });
});

router.post('/', requirePermission('manage_raw_materials'), (req, res) => {
  const { name, default_cost_per_kg_npr, carbon_pct, nitrogen_pct, moisture_pct, ash_pct, notes, category } = req.body;
  const cleanName = (name || '').trim();
  if (!cleanName) {
    return res.redirect(`/raw-materials?error=${encodeURIComponent('Enter a material name.')}`);
  }
  try {
    db.prepare(
      `INSERT INTO raw_materials (name, default_cost_per_kg_npr, carbon_pct, nitrogen_pct, moisture_pct, ash_pct, notes, category)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(cleanName, num(default_cost_per_kg_npr), num(carbon_pct), num(nitrogen_pct), num(moisture_pct), num(ash_pct), str(notes), cat(category));
  } catch (e) {
    return res.redirect(`/raw-materials?error=${encodeURIComponent(`"${cleanName}" already exists.`)}`);
  }
  res.redirect('/raw-materials');
});

function asArray(v) {
  if (v === undefined) return [];
  return Array.isArray(v) ? v : [v];
}

// One Save for the whole table. Each row's fields are named with its own id
// (name_7, active_7 …) rather than as parallel arrays, so an unticked checkbox
// — which a browser simply doesn't send — can't shift every later row's values
// onto the wrong material.
router.post('/bulk', requirePermission('manage_raw_materials'), (req, res) => {
  const b = req.body;
  const update = db.prepare(
    `UPDATE raw_materials
     SET name = ?, default_cost_per_kg_npr = ?, carbon_pct = ?, nitrogen_pct = ?, moisture_pct = ?, ash_pct = ?,
         notes = ?, category = ?, active = ?, is_default = ?, updated_at = datetime('now')
     WHERE id = ?`
  );
  try {
    db.transaction(() => {
      asArray(b.id).forEach((id) => {
        const f = (field) => b[`${field}_${id}`];
        if (f('name') === undefined) return;
        update.run(
          (f('name') || '').trim(),
          num(f('default_cost_per_kg_npr')),
          num(f('carbon_pct')),
          num(f('nitrogen_pct')),
          num(f('moisture_pct')),
          num(f('ash_pct')),
          str(f('notes')),
          cat(f('category')),
          f('active') ? 1 : 0,
          f('is_default') ? 1 : 0,
          id
        );
      });
    })();
  } catch (e) {
    return res.redirect(`/raw-materials?error=${encodeURIComponent('Two materials cannot share a name.')}`);
  }
  res.redirect('/raw-materials?saved=1');
});

router.post('/:id', requirePermission('manage_raw_materials'), (req, res) => {
  const { name, default_cost_per_kg_npr, carbon_pct, nitrogen_pct, moisture_pct, ash_pct, notes, active, category } = req.body;
  db.prepare(
    `UPDATE raw_materials
     SET name = ?, default_cost_per_kg_npr = ?, carbon_pct = ?, nitrogen_pct = ?, moisture_pct = ?, ash_pct = ?, notes = ?, category = ?, active = ?, updated_at = datetime('now')
     WHERE id = ?`
  ).run(
    (name || '').trim(),
    num(default_cost_per_kg_npr),
    num(carbon_pct),
    num(nitrogen_pct),
    num(moisture_pct),
    num(ash_pct),
    str(notes),
    cat(category),
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
