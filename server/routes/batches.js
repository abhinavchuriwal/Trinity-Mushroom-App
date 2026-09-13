const express = require('express');
const db = require('../db');
const { nepaliFiscalYear } = require('../lib/nepaliFY');
const { daysBetween } = require('../lib/dates');
const { STAGE_META } = require('../lib/stages');
const { num, str, asArray } = require('../lib/batchHelpers');
const { summarizeIntakeItems } = require('../lib/economics');
const { getBatchMetrics } = require('../lib/analytics');
const { requirePermission } = require('../lib/auth');

const router = express.Router();

function resolveMaterial(rawMaterialId, typedName) {
  if (rawMaterialId) {
    const m = db.prepare('SELECT * FROM raw_materials WHERE id = ?').get(rawMaterialId);
    if (m) {
      return {
        name: typedName || m.name,
        carbonStandard: m.carbon_pct,
        nitrogenStandard: m.nitrogen_pct,
        moistureStandard: m.moisture_pct,
        defaultCost: m.default_cost_per_kg_npr,
      };
    }
  }
  return { name: typedName || null, carbonStandard: null, nitrogenStandard: null, moistureStandard: null, defaultCost: null };
}

function loadBatch(id, farmId) {
  const batch =
    farmId === undefined || farmId === null
      ? db.prepare('SELECT * FROM batches WHERE id = ?').get(id)
      : db.prepare('SELECT * FROM batches WHERE id = ? AND farm_id = ?').get(id, farmId);
  if (!batch) return null;
  batch.intake = db.prepare('SELECT * FROM intake WHERE batch_id = ?').get(id) || {};
  batch.intake_items = db.prepare('SELECT * FROM intake_items WHERE batch_id = ? ORDER BY id').all(id);
  batch.prewetting = db.prepare('SELECT * FROM prewetting WHERE batch_id = ?').get(id) || {};
  batch.phase1 = db.prepare('SELECT * FROM phase1 WHERE batch_id = ?').get(id) || {};
  batch.phase1_readings = db.prepare('SELECT * FROM phase1_readings WHERE batch_id = ? ORDER BY reading_date, id').all(id);
  batch.phase2 = db.prepare('SELECT * FROM phase2 WHERE batch_id = ?').get(id) || {};
  batch.phase2_readings = db.prepare('SELECT * FROM phase2_readings WHERE batch_id = ? ORDER BY reading_date, id').all(id);
  batch.spawning = db.prepare('SELECT * FROM spawning WHERE batch_id = ?').get(id) || {};
  batch.casing = db.prepare('SELECT * FROM casing WHERE batch_id = ?').get(id) || {};
  batch.rooms = db.prepare('SELECT * FROM rooms WHERE batch_id = ? ORDER BY room_in_date, id').all(id);
  batch.harvests = db.prepare('SELECT * FROM room_harvests WHERE batch_id = ? ORDER BY harvest_date, id').all(id);
  return batch;
}

// ---- Dashboard ----
router.get('/', (req, res) => {
  const all = db
    .prepare('SELECT * FROM batches WHERE farm_id = ? ORDER BY start_date DESC, id DESC')
    .all(req.farmId)
    .map((b) => ({ ...b, flagCount: getBatchMetrics(b.id).flags.length, fy: nepaliFiscalYear(b.start_date) }));

  // Fiscal year is a filter, not a separate data store — every batch already
  // carries its FY via start_date, so past years stay comparable rather than
  // being locked away in a closed-off "year".
  const fiscalYears = [...new Set(all.map((b) => b.fy).filter(Boolean))].sort().reverse();
  const fy = req.query.fy && fiscalYears.includes(req.query.fy) ? req.query.fy : null;

  // Convenience filter only — not access control. Shows the batches currently
  // sitting in one department's half of the pipeline, so each team can see
  // what's on their plate without scanning every batch.
  const dept = req.query.dept === 'compost' || req.query.dept === 'growing' ? req.query.dept : null;
  const stageDept = Object.fromEntries(STAGE_META.map((s) => [s.key, s.dept]));

  let batches = fy ? all.filter((b) => b.fy === fy) : all;
  if (dept) batches = batches.filter((b) => stageDept[b.current_stage] === dept);

  res.render('dashboard', { batches, fiscalYears, fy, dept });
});

// ---- Live fiscal-year preview (used by the New Batch page as the date changes) ----
router.get('/api/nepali-fy', (req, res) => {
  res.json({ fy: nepaliFiscalYear(req.query.date) });
});

// ---- New batch ----
router.get('/batches/new', (req, res) => {
  const today = new Date().toISOString().slice(0, 10);
  const rawMaterials = db.prepare('SELECT * FROM raw_materials WHERE active = 1 ORDER BY name').all();
  res.render('batch-new', {
    prefix: res.locals.currentFarm.code_prefix,
    today,
    fy: nepaliFiscalYear(today),
    error: null,
    batch_no: '',
    start_date: today,
    notes: '',
    rawMaterials,
  });
});

router.post('/batches', requirePermission('edit_prewetting'), (req, res) => {
  const b = req.body;
  const effectiveDate = b.start_date || new Date().toISOString().slice(0, 10);
  const fy = nepaliFiscalYear(effectiveDate);
  const cleanBatchNo = (b.batch_no || '').trim();

  const rerenderWithError = (error) => {
    const rawMaterials = db.prepare('SELECT * FROM raw_materials WHERE active = 1 ORDER BY name').all();
    return res.render('batch-new', {
      prefix: res.locals.currentFarm.code_prefix,
      today: new Date().toISOString().slice(0, 10),
      fy,
      error,
      batch_no: cleanBatchNo,
      start_date: effectiveDate,
      notes: b.notes || '',
      rawMaterials,
    });
  };

  if (!fy) return rerenderWithError('Could not determine the Nepali fiscal year for that date.');
  if (!cleanBatchNo) return rerenderWithError('Enter a batch number.');

  // The farm's own prefix keeps training batch codes (TRAIN-…) from colliding
  // with real ones (TAPL-…), so the same batch number can be used for practice
  // without ever clashing with production data.
  const batch_code = `${res.locals.currentFarm.code_prefix}-${fy}-${cleanBatchNo}`;
  const dupe = db.prepare('SELECT id FROM batches WHERE batch_code = ?').get(batch_code);
  if (dupe) return rerenderWithError(`Batch ${batch_code} already exists. Choose a different number.`);

  const rawMaterialIds = asArray(b.raw_material_id);
  const materialNames = asArray(b.material_name);
  const qtyKgs = asArray(b.qty_kg);
  const costs = asArray(b.cost_per_kg_npr);
  const carbonActuals = asArray(b.carbon_pct_actual);
  const nitrogenActuals = asArray(b.nitrogen_pct_actual);
  const moistureActuals = asArray(b.moisture_pct_actual);
  const itemNotes = asArray(b.item_notes);

  const items = [];
  for (let i = 0; i < qtyKgs.length; i++) {
    const qty = num(qtyKgs[i]);
    if (!qty) continue;
    const resolved = resolveMaterial(num(rawMaterialIds[i]), str(materialNames[i]));
    if (!resolved.name) continue;
    items.push({
      raw_material_id: num(rawMaterialIds[i]),
      material_name: resolved.name,
      qty_kg: qty,
      cost_per_kg_npr: num(costs[i]) ?? resolved.defaultCost,
      carbon_pct_standard: resolved.carbonStandard,
      nitrogen_pct_standard: resolved.nitrogenStandard,
      carbon_pct_actual: num(carbonActuals[i]),
      nitrogen_pct_actual: num(nitrogenActuals[i]),
      moisture_pct_standard: resolved.moistureStandard,
      moisture_pct_actual: num(moistureActuals[i]),
      notes: str(itemNotes[i]),
    });
  }

  const createBatch = db.transaction(() => {
    const result = db
      .prepare("INSERT INTO batches (batch_code, start_date, current_stage, notes, farm_id) VALUES (?, ?, 'prewetting', ?, ?)")
      .run(batch_code, effectiveDate, str(b.notes), req.farmId);
    const batchId = result.lastInsertRowid;
    const insertItem = db.prepare(`
      INSERT INTO intake_items
        (batch_id, raw_material_id, material_name, qty_kg, cost_per_kg_npr, carbon_pct_standard, nitrogen_pct_standard, carbon_pct_actual, nitrogen_pct_actual, moisture_pct_standard, moisture_pct_actual, notes)
      VALUES (@batch_id, @raw_material_id, @material_name, @qty_kg, @cost_per_kg_npr, @carbon_pct_standard, @nitrogen_pct_standard, @carbon_pct_actual, @nitrogen_pct_actual, @moisture_pct_standard, @moisture_pct_actual, @notes)
    `);
    items.forEach((it) => insertItem.run({ ...it, batch_id: batchId }));
    return batchId;
  });

  const batchId = createBatch();
  res.redirect(`/batches/${batchId}`);
});

// The QC comparison entries key their "stage" by data table (e.g. 'intake'
// for C:N ratio), which doesn't always match a STAGE_META pipeline key since
// Intake was merged into the Pre-Wetting page. This maps each pipeline stage
// to the QC-comparison stage key(s) whose flags should count against it.
const QC_STAGE_MAP = {
  prewetting: ['intake'],
  phase1: ['phase1'],
  phase2: ['phase2'],
  spawning: ['spawning'],
  casing: ['casing'],
};

// ---- Batch overview (hub page linking to every stage page) ----
router.get('/batches/:id', (req, res) => {
  const batch = loadBatch(req.params.id, req.farmId);
  if (!batch) return res.status(404).render('404');

  const intakeSummary = summarizeIntakeItems(batch.intake_items);
  const metrics = getBatchMetrics(req.params.id);

  const roomsSummary = batch.rooms.map((r) => ({
    ...r,
    days: daysBetween(r.room_in_date, r.room_out_date),
  }));
  let totalHarvestA = 0;
  let totalHarvestB = 0;
  batch.harvests.forEach((h) => {
    totalHarvestA += h.grade_a_kg || 0;
    totalHarvestB += h.grade_b_kg || 0;
  });

  const stageStatus = STAGE_META.map((s) => {
    let summary = null;
    let days = null;
    if (s.key === 'prewetting') {
      const recipe = intakeSummary.totalWetKg ? `${intakeSummary.totalWetKg} kg recipe` : null;
      summary = [recipe, batch.prewetting.in_date].filter(Boolean).join(', ') || null;
      days = daysBetween(batch.prewetting.in_date, batch.prewetting.out_date);
    }
    if (s.key === 'phase1') { summary = batch.phase1.start_date || null; days = daysBetween(batch.phase1.start_date, batch.phase1.end_date); }
    if (s.key === 'phase2') { summary = batch.phase2.fill_date || null; days = daysBetween(batch.phase2.fill_date, batch.phase2.end_date); }
    if (s.key === 'spawning') { summary = batch.spawning.spawning_date || null; days = daysBetween(batch.spawning.spawning_date, batch.spawning.spawn_run_end_date); }
    if (s.key === 'casing') { summary = batch.casing.application_date || null; days = daysBetween(batch.casing.application_date, batch.casing.end_date); }
    if (s.key === 'room_in') summary = batch.rooms.length ? `${batch.rooms.length} room(s)` : null;
    if (s.key === 'harvest') summary = batch.harvests.length ? `${(totalHarvestA + totalHarvestB).toFixed(1)} kg harvested` : null;
    if (s.key === 'room_out') {
      const closedCount = batch.rooms.filter((r) => r.room_out_date).length;
      summary = batch.rooms.length ? `${closedCount}/${batch.rooms.length} room(s) closed out` : null;
    }
    const qcKeys = QC_STAGE_MAP[s.key] || [];
    const flagCount = metrics.flags.filter((f) => qcKeys.includes(f.stage)).length;
    return { ...s, summary, days, flagCount };
  });

  res.render('batch-overview', {
    batch,
    currentPage: 'overview',
    stageStatus,
    intakeSummary,
    qcComparison: metrics.qcComparison,
    roomsSummary,
    totalHarvestA,
    totalHarvestB,
    aGradeEfficiency: metrics.aGradeEfficiency,
  });
});

router.post('/batches/:id/delete', requirePermission('delete_batch'), (req, res) => {
  db.prepare('DELETE FROM batches WHERE id = ? AND farm_id = ?').run(req.params.id, req.farmId);
  res.redirect('/');
});

// ---- CSV export ----
router.get('/batches/:id/export.csv', requirePermission('export_data'), (req, res) => {
  const batch = loadBatch(req.params.id, req.farmId);
  if (!batch) return res.status(404).send('Not found');

  const lines = [];
  const pushRow = (obj) => {
    Object.entries(obj).forEach(([k, v]) => lines.push(`${k},${v === null || v === undefined ? '' : String(v).replace(/,/g, ';')}`));
  };
  const csvVal = (v) => (v === null || v === undefined ? '' : String(v).replace(/,/g, ';'));

  const summary = summarizeIntakeItems(batch.intake_items);

  lines.push(`Batch,${batch.batch_code}`);
  lines.push('');
  lines.push('-- Intake --');
  pushRow(batch.intake);
  lines.push('');
  lines.push('-- Raw Material Recipe --');
  lines.push(
    'material_name,qty_kg_wet,cost_per_kg_npr,amount_npr,carbon_pct_standard,nitrogen_pct_standard,carbon_pct_actual,nitrogen_pct_actual,moisture_pct_standard,moisture_pct_actual,qty_kg_dry_est,notes'
  );
  batch.intake_items.forEach((it) => {
    const amount = it.cost_per_kg_npr !== null ? (it.qty_kg * it.cost_per_kg_npr).toFixed(2) : '';
    const moisture = it.moisture_pct_actual ?? it.moisture_pct_standard;
    const dryKg = moisture !== null && moisture !== undefined ? (it.qty_kg * (1 - moisture / 100)).toFixed(1) : '';
    lines.push(
      [
        it.material_name, it.qty_kg, it.cost_per_kg_npr, amount,
        it.carbon_pct_standard, it.nitrogen_pct_standard, it.carbon_pct_actual, it.nitrogen_pct_actual,
        it.moisture_pct_standard, it.moisture_pct_actual, dryKg, it.notes,
      ].map(csvVal).join(',')
    );
  });
  lines.push('');
  lines.push(`Total Wet Weight (kg),${summary.totalWetKg ?? ''}`);
  lines.push(`Total Dry Weight, est. (kg),${summary.totalDryKg ?? ''}`);
  lines.push(`Total Raw Material Cost (NPR),${summary.totalCostNpr !== null ? summary.totalCostNpr.toFixed(2) : ''}`);
  lines.push(`Cost per kg Compost Mix, wet basis (NPR),${summary.costPerKgCompost !== null ? summary.costPerKgCompost.toFixed(2) : ''}`);
  lines.push(`Batch C:N Ratio,${summary.cnRatio !== null ? summary.cnRatio.toFixed(1) + ':1' : ''}`);
  lines.push('');
  lines.push('-- Pre-Wetting --');
  pushRow(batch.prewetting);
  lines.push('');
  lines.push('-- Phase 1 summary --');
  pushRow(batch.phase1);
  lines.push('');
  lines.push('-- Phase 1 readings --');
  lines.push('turn_number,reading_date,bunker_no,pile_temp_c,ambient_temp_c,moisture_pct,ammonia_level,ph,entered_by,notes');
  batch.phase1_readings.forEach((r) => {
    lines.push([r.turn_number, r.reading_date, r.bunker_no, r.pile_temp_c, r.ambient_temp_c, r.moisture_pct, r.ammonia_level, r.ph, r.entered_by, r.notes].map(csvVal).join(','));
  });
  lines.push('');
  lines.push('-- Phase 2 summary --');
  pushRow(batch.phase2);
  lines.push('');
  lines.push('-- Phase 2 readings --');
  lines.push('reading_date,temp_c,ammonia_ppm,entered_by,notes');
  batch.phase2_readings.forEach((r) => {
    lines.push([r.reading_date, r.temp_c, r.ammonia_ppm, r.entered_by, r.notes].map(csvVal).join(','));
  });
  lines.push('');
  lines.push('-- Spawning --');
  pushRow(batch.spawning);
  lines.push('');
  lines.push('-- Casing Soil Preparation --');
  pushRow(batch.casing);
  lines.push('');
  lines.push('-- Rooms (Room In / Room Out) --');
  lines.push('room_no,room_in_date,num_bags,kg_per_bag,total_fill_weight_kg,room_out_date,days_in_room,entered_by,notes');
  batch.rooms.forEach((r) => {
    lines.push([r.room_no, r.room_in_date, r.num_bags, r.kg_per_bag, r.total_fill_weight_kg, r.room_out_date, daysBetween(r.room_in_date, r.room_out_date), r.entered_by, r.notes].map(csvVal).join(','));
  });
  lines.push('');
  lines.push('-- Harvests --');
  lines.push('room_no,harvest_date,grade_a_kg,grade_b_kg,entered_by,notes');
  let totalGradeA = 0;
  batch.harvests.forEach((h) => {
    const room = batch.rooms.find((r) => r.id === h.room_id);
    totalGradeA += h.grade_a_kg || 0;
    lines.push([room ? room.room_no : '', h.harvest_date, h.grade_a_kg, h.grade_b_kg, h.entered_by, h.notes].map(csvVal).join(','));
  });
  const aGradeEfficiency = summary.totalCostNpr ? (totalGradeA / summary.totalCostNpr) * 1000 : null;
  lines.push('');
  lines.push(`A-Grade Efficiency Ratio (kg per NPR 1,000),${aGradeEfficiency !== null ? aGradeEfficiency.toFixed(2) : ''}`);

  res.setHeader('Content-Type', 'text/csv');
  res.setHeader('Content-Disposition', `attachment; filename="${batch.batch_code}.csv"`);
  res.send(lines.join('\n'));
});

module.exports = router;
