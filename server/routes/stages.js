const express = require('express');
const db = require('../db');
const qc = require('../lib/qc');
const { lineChart } = require('../lib/chart');
const { daysBetween, todayLocal } = require('../lib/dates');
const { getBatchHeader, num, str, upsert } = require('../lib/batchHelpers');
const { advanceStage, nextStagePath, STAGE_META } = require('../lib/stages');
const { summarizeIntakeItems } = require('../lib/economics');
const { getBatchMetrics } = require('../lib/analytics');
const { requirePermission } = require('../lib/auth');

const router = express.Router();

function render(res, view, batchId, extra, farmId) {
  const batch = getBatchHeader(batchId, farmId);
  if (!batch) return res.status(404).render('404');
  const currentPage = view.split('/')[1];
  // Anyone may look at any stage; only the owning department may save. The
  // server enforces that on the POST routes — this just stops the page from
  // offering controls that would bounce with a 403.
  const meta = STAGE_META.find((s) => s.key === currentPage);
  const readOnly = !!(meta && meta.permission && !res.locals.can(meta.permission));
  res.render(view, { batch, currentPage, readOnly, stageMeta: meta, ...extra });
}

// ---- Pre-Wetting (also shows the recipe entered at batch creation — the
// separate Intake page/stage was merged in here; no more adding recipe lines
// after creation, only viewing/deleting a mistaken entry) ----
router.get('/batches/:id/prewetting', (req, res) => {
  const row = db.prepare('SELECT * FROM prewetting WHERE batch_id = ?').get(req.params.id) || {};
  const intakeItems = db.prepare('SELECT * FROM intake_items WHERE batch_id = ? ORDER BY id').all(req.params.id);
  const intakeSummary = summarizeIntakeItems(intakeItems);
  render(res, 'stages/prewetting', req.params.id, {
    row,
    intakeItems,
    intakeSummary,
    days: daysBetween(row.in_date, row.out_date),
  }, req.farmId);
});

router.post('/batches/:id/prewetting', requirePermission('edit_prewetting'), (req, res) => {
  const id = req.params.id;
  const b = req.body;
  upsert('prewetting', id, {
    in_date: str(b.in_date),
    out_date: str(b.out_date),
    entered_by: str(b.entered_by),
    notes: str(b.notes),
  });
  if (b.advance) return void (advanceStage(id, 'prewetting'), res.redirect(nextStagePath('prewetting', id)));
  res.redirect(`/batches/${id}/prewetting`);
});

router.post('/batches/:id/intake/items/:itemId/delete', requirePermission('edit_prewetting'), (req, res) => {
  db.prepare('DELETE FROM intake_items WHERE id = ? AND batch_id = ?').run(req.params.itemId, req.params.id);
  res.redirect(`/batches/${req.params.id}/prewetting`);
});

// ---- Phase 1 ----
router.get('/batches/:id/phase1', (req, res) => {
  const row = db.prepare('SELECT * FROM phase1 WHERE batch_id = ?').get(req.params.id) || {};
  const readings = db.prepare('SELECT * FROM phase1_readings WHERE batch_id = ? ORDER BY reading_date, id').all(req.params.id);
  const tempParam = qc.getParam('phase1', 'pile_temp_c');
  const chart = lineChart(
    readings.map((r) => ({ x: r.reading_date, y: r.pile_temp_c })),
    { unit: '°C', band: tempParam ? { min: tempParam.min_value, max: tempParam.max_value } : null }
  );
  const bunkers = db.prepare('SELECT * FROM bunkers WHERE active = 1 ORDER BY code').all();
  const dryMatterLoss = (getBatchMetrics(req.params.id) || {}).dryMatterLoss || null;
  render(res, 'stages/phase1', req.params.id, { row, readings, chart, bunkers, dryMatterLoss, saved: req.query.saved === 'reading', days: daysBetween(row.start_date, row.end_date) }, req.farmId);
});

router.post('/batches/:id/phase1', requirePermission('edit_phase1'), (req, res) => {
  const id = req.params.id;
  const b = req.body;
  upsert('phase1', id, {
    start_date: str(b.start_date),
    end_date: str(b.end_date),
    bunker_no: str(b.bunker_no),
    num_turns_planned: num(b.num_turns_planned),
    end_cn_ratio: num(b.end_cn_ratio),
    end_nitrogen_pct: num(b.end_nitrogen_pct),
    end_ash_pct: num(b.end_ash_pct),
    notes: str(b.notes),
  });
  if (b.advance) return void (advanceStage(id, 'phase1'), res.redirect(nextStagePath('phase1', id)));
  res.redirect(`/batches/${id}/phase1`);
});

router.post('/batches/:id/phase1/readings', requirePermission('edit_phase1'), (req, res) => {
  const id = req.params.id;
  const b = req.body;
  db.prepare(
    `INSERT INTO phase1_readings
      (batch_id, turn_number, reading_date, bunker_no, pile_temp_c, ambient_temp_c, moisture_pct, ammonia_level, ph, entered_by, notes)
     VALUES (@batch_id, @turn_number, @reading_date, @bunker_no, @pile_temp_c, @ambient_temp_c, @moisture_pct, @ammonia_level, @ph, @entered_by, @notes)`
  ).run({
    batch_id: id,
    turn_number: num(b.turn_number),
    reading_date: str(b.reading_date) || todayLocal(),
    bunker_no: str(b.bunker_no),
    pile_temp_c: num(b.pile_temp_c),
    ambient_temp_c: num(b.ambient_temp_c),
    moisture_pct: num(b.moisture_pct),
    ammonia_level: str(b.ammonia_level),
    ph: num(b.ph),
    entered_by: str(b.entered_by),
    notes: str(b.notes),
  });
  res.redirect(`/batches/${id}/phase1?saved=reading#add-reading`);
});

router.post('/batches/:id/phase1/readings/:readingId/delete', requirePermission('edit_phase1'), (req, res) => {
  db.prepare('DELETE FROM phase1_readings WHERE id = ? AND batch_id = ?').run(req.params.readingId, req.params.id);
  res.redirect(`/batches/${req.params.id}/phase1`);
});

// ---- Phase 2 ----
router.get('/batches/:id/phase2', (req, res) => {
  const row = db.prepare('SELECT * FROM phase2 WHERE batch_id = ?').get(req.params.id) || {};
  const readings = db.prepare('SELECT * FROM phase2_readings WHERE batch_id = ? ORDER BY reading_date, id').all(req.params.id);
  const tempParam = qc.getParam('phase2', 'temp_c');
  const chart = lineChart(
    readings.map((r) => ({ x: r.reading_date, y: r.temp_c })),
    { unit: '°C', band: tempParam ? { min: tempParam.min_value, max: tempParam.max_value } : null }
  );
  const tunnels = db.prepare('SELECT * FROM tunnels WHERE active = 1 ORDER BY code').all();
  const dryMatterLoss = (getBatchMetrics(req.params.id) || {}).dryMatterLoss || null;
  render(res, 'stages/phase2', req.params.id, { row, readings, chart, tunnels, dryMatterLoss, saved: req.query.saved === 'reading', days: daysBetween(row.fill_date, row.end_date) }, req.farmId);
});

router.post('/batches/:id/phase2', requirePermission('edit_phase2'), (req, res) => {
  const id = req.params.id;
  const b = req.body;
  upsert('phase2', id, {
    tunnel_id: str(b.tunnel_id),
    fill_date: str(b.fill_date),
    end_date: str(b.end_date),
    pasteurization_date: str(b.pasteurization_date),
    pasteurization_temp_c: num(b.pasteurization_temp_c),
    pasteurization_duration_hrs: num(b.pasteurization_duration_hrs),
    final_moisture_pct: num(b.final_moisture_pct),
    final_cn_ratio: num(b.final_cn_ratio),
    final_nitrogen_pct: num(b.final_nitrogen_pct),
    final_ash_pct: num(b.final_ash_pct),
    compost_color: str(b.compost_color),
    compost_texture: str(b.compost_texture),
    compost_smell: str(b.compost_smell),
    ammonia_cleared: str(b.ammonia_cleared),
    notes: str(b.notes),
  });
  if (b.advance) return void (advanceStage(id, 'phase2'), res.redirect(nextStagePath('phase2', id)));
  res.redirect(`/batches/${id}/phase2`);
});

router.post('/batches/:id/phase2/readings', requirePermission('edit_phase2'), (req, res) => {
  const id = req.params.id;
  const b = req.body;
  db.prepare(
    `INSERT INTO phase2_readings (batch_id, reading_date, temp_c, ammonia_ppm, entered_by, notes)
     VALUES (@batch_id, @reading_date, @temp_c, @ammonia_ppm, @entered_by, @notes)`
  ).run({
    batch_id: id,
    reading_date: str(b.reading_date) || todayLocal(),
    temp_c: num(b.temp_c),
    ammonia_ppm: num(b.ammonia_ppm),
    entered_by: str(b.entered_by),
    notes: str(b.notes),
  });
  res.redirect(`/batches/${id}/phase2?saved=reading#add-reading`);
});

router.post('/batches/:id/phase2/readings/:readingId/delete', requirePermission('edit_phase2'), (req, res) => {
  db.prepare('DELETE FROM phase2_readings WHERE id = ? AND batch_id = ?').run(req.params.readingId, req.params.id);
  res.redirect(`/batches/${req.params.id}/phase2`);
});

// ---- Spawning ----
router.get('/batches/:id/spawning', (req, res) => {
  const row = db.prepare('SELECT * FROM spawning WHERE batch_id = ?').get(req.params.id) || {};
  const growingRooms = db.prepare('SELECT * FROM growing_rooms WHERE active = 1 ORDER BY code').all();
  render(res, 'stages/spawning', req.params.id, { row, growingRooms, days: daysBetween(row.spawning_date, row.spawn_run_end_date) }, req.farmId);
});

router.post('/batches/:id/spawning', requirePermission('edit_spawning'), (req, res) => {
  const id = req.params.id;
  const b = req.body;
  const numBags = num(b.num_bags);
  const kgPerBag = num(b.kg_per_bag);
  upsert('spawning', id, {
    spawning_date: str(b.spawning_date),
    spawn_run_end_date: str(b.spawn_run_end_date),
    spawn_strain: str(b.spawn_strain),
    spawn_rate_pct: num(b.spawn_rate_pct),
    spawning_method: str(b.spawning_method),
    compost_temp_c: num(b.compost_temp_c),
    room_id: str(b.room_id),
    num_bags: numBags,
    kg_per_bag: kgPerBag,
    fill_weight_kg: numBags !== null && kgPerBag !== null ? numBags * kgPerBag : null,
    entered_by: str(b.entered_by),
    notes: str(b.notes),
  });
  if (b.advance) return void (advanceStage(id, 'spawning'), res.redirect(nextStagePath('spawning', id)));
  res.redirect(`/batches/${id}/spawning`);
});

// ---- Casing Soil Preparation ----
router.get('/batches/:id/casing', (req, res) => {
  const row = db.prepare('SELECT * FROM casing WHERE batch_id = ?').get(req.params.id) || {};
  const growingRooms = db.prepare('SELECT * FROM growing_rooms WHERE active = 1 ORDER BY code').all();
  render(res, 'stages/casing', req.params.id, { row, growingRooms, days: daysBetween(row.application_date, row.end_date) }, req.farmId);
});

router.post('/batches/:id/casing', requirePermission('edit_casing'), (req, res) => {
  const id = req.params.id;
  const b = req.body;
  upsert('casing', id, {
    prep_date: str(b.prep_date),
    casing_material: str(b.casing_material),
    quantity_kg: num(b.quantity_kg),
    chalk_kg: num(b.chalk_kg),
    ph: num(b.ph),
    moisture_pct: num(b.moisture_pct),
    pasteurized: str(b.pasteurized),
    pasteurization_temp_c: num(b.pasteurization_temp_c),
    pasteurization_duration_hrs: num(b.pasteurization_duration_hrs),
    application_date: str(b.application_date),
    layer_thickness_cm: num(b.layer_thickness_cm),
    room_id: str(b.room_id),
    end_date: str(b.end_date),
    entered_by: str(b.entered_by),
    notes: str(b.notes),
  });
  if (b.advance) return void (advanceStage(id, 'casing'), res.redirect(nextStagePath('casing', id)));
  res.redirect(`/batches/${id}/casing`);
});

module.exports = router;
