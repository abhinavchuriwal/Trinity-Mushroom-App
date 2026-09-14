const db = require('../db');
const qc = require('./qc');
const { daysBetween, todayLocal } = require('./dates');
const { summarizeIntakeItems } = require('./economics');

// A growing-unit batch doesn't make its own compost — it receives deliveries
// from the compost unit, which carry both the weight and a share of what that
// compost cost to produce. These two read that across, and live here rather
// than in lib/handover.js only because handover.js needs getBatchMetrics from
// this file; putting them there would make the two modules require each other.
function compostCostForGrowingBatch(batchId) {
  const row = db
    .prepare('SELECT COALESCE(SUM(cost_share_npr), 0) AS cost, COUNT(*) AS n FROM compost_dispatches WHERE growing_batch_id = ?')
    .get(batchId);
  return row.n > 0 && row.cost > 0 ? row.cost : null;
}

function compostKgForGrowingBatch(batchId) {
  const row = db
    .prepare(
      `SELECT COALESCE(SUM(COALESCE(received_qty_kg, qty_kg)), 0) AS kg, COUNT(*) AS n
       FROM compost_dispatches WHERE growing_batch_id = ?`
    )
    .get(batchId);
  return row.n > 0 && row.kg > 0 ? row.kg : null;
}

function avg(nums) {
  const valid = nums.filter((n) => n !== null && n !== undefined && !Number.isNaN(n));
  if (!valid.length) return null;
  return valid.reduce((a, b) => a + b, 0) / valid.length;
}

// Evaluates one tracked parameter against its configured QC range. Returns
// null only when there's no QC range configured for this stage/param at all
// (nothing to compare against). Otherwise always returns a row — status is
// 'na' when no value has been entered yet, so callers can render a full
// "standard vs actual" table, not just the out-of-range flags.
function evaluateParam(stage, paramKey, value, contextLabel) {
  const param = qc.getParam(stage, paramKey);
  if (!param) return null;
  const { status } = qc.evaluate(stage, paramKey, value);
  return {
    stage,
    param: paramKey,
    label: contextLabel || param.label || paramKey,
    value: value === undefined ? null : value,
    status,
    min: param.min_value,
    max: param.max_value,
    unit: param.unit || '',
  };
}

// Full metrics bundle for one batch: recipe/cost, per-stage averages + a full
// standard-vs-actual QC comparison, room/harvest totals, yield %, and the
// A-Grade Efficiency Ratio. Shared by the Room Out page (per-room view), the
// Batch Overview page, and the Reports page (cross-batch comparison).
function getBatchMetrics(batchId) {
  const batch = db.prepare('SELECT * FROM batches WHERE id = ?').get(batchId);
  if (!batch) return null;

  const intakeItems = db.prepare('SELECT * FROM intake_items WHERE batch_id = ?').all(batchId);
  const intake = summarizeIntakeItems(intakeItems);

  const prewetting = db.prepare('SELECT * FROM prewetting WHERE batch_id = ?').get(batchId) || {};
  const phase1 = db.prepare('SELECT * FROM phase1 WHERE batch_id = ?').get(batchId) || {};
  const phase1Readings = db.prepare('SELECT * FROM phase1_readings WHERE batch_id = ?').all(batchId);
  const phase2 = db.prepare('SELECT * FROM phase2 WHERE batch_id = ?').get(batchId) || {};
  const phase2Readings = db.prepare('SELECT * FROM phase2_readings WHERE batch_id = ?').all(batchId);
  const spawning = db.prepare('SELECT * FROM spawning WHERE batch_id = ?').get(batchId) || {};
  const casing = db.prepare('SELECT * FROM casing WHERE batch_id = ?').get(batchId) || {};
  const rooms = db.prepare('SELECT * FROM rooms WHERE batch_id = ?').all(batchId);
  const harvests = db.prepare('SELECT * FROM room_harvests WHERE batch_id = ?').all(batchId);

  const phase1AvgTemp = avg(phase1Readings.map((r) => r.pile_temp_c));
  const phase1AvgMoisture = avg(phase1Readings.map((r) => r.moisture_pct));
  const phase1AvgPh = avg(phase1Readings.map((r) => r.ph));
  const phase2AvgTemp = avg(phase2Readings.map((r) => r.temp_c));
  const phase2AvgAmmonia = avg(phase2Readings.map((r) => r.ammonia_ppm));

  // Every QC-tracked parameter for this batch, standard vs. actual, whether
  // or not it's currently out of range (status can be 'ok' | 'low' | 'high' | 'na').
  const qcComparison = [
    evaluateParam('intake', 'cn_ratio', intake.cnRatio, 'Recipe C:N (calculated)'),
    evaluateParam('intake', 'ash_pct', intake.ashPct, 'Recipe ash (calculated)'),
    evaluateParam('phase1', 'pile_temp_c', phase1AvgTemp, 'Phase I avg pile temp'),
    evaluateParam('phase1', 'moisture_pct', phase1AvgMoisture, 'Phase I avg moisture'),
    evaluateParam('phase1', 'ph', phase1AvgPh, 'Phase I avg pH'),
    evaluateParam('phase1', 'end_cn_ratio', phase1.end_cn_ratio, 'C:N at end of Phase I (measured)'),
    evaluateParam('phase1', 'end_nitrogen_pct', phase1.end_nitrogen_pct, 'Nitrogen at end of Phase I (measured)'),
    evaluateParam('phase1', 'end_ash_pct', phase1.end_ash_pct, 'Ash at end of Phase I (measured)'),
    evaluateParam('phase2', 'pasteurization_temp_c', phase2.pasteurization_temp_c, 'Pasteurization temp'),
    evaluateParam('phase2', 'pasteurization_duration_hrs', phase2.pasteurization_duration_hrs, 'Pasteurization duration'),
    evaluateParam('phase2', 'temp_c', phase2AvgTemp, 'Phase II avg conditioning temp'),
    evaluateParam('phase2', 'ammonia_ppm', phase2AvgAmmonia, 'Phase II avg ammonia'),
    evaluateParam('phase2', 'final_moisture_pct', phase2.final_moisture_pct, 'Final moisture'),
    evaluateParam('phase2', 'final_cn_ratio', phase2.final_cn_ratio, 'C:N at end of Phase II (measured)'),
    evaluateParam('phase2', 'final_nitrogen_pct', phase2.final_nitrogen_pct, 'Nitrogen at end of Phase II (measured)'),
    evaluateParam('phase2', 'final_ash_pct', phase2.final_ash_pct, 'Ash at end of Phase II (measured)'),
    evaluateParam('spawning', 'compost_temp_c', spawning.compost_temp_c, 'Compost temp at spawning'),
    evaluateParam('spawning', 'spawn_rate_pct', spawning.spawn_rate_pct, 'Spawn rate'),
    evaluateParam('casing', 'ph', casing.ph, 'Casing pH'),
    evaluateParam('casing', 'moisture_pct', casing.moisture_pct, 'Casing moisture'),
    evaluateParam('casing', 'layer_thickness_cm', casing.layer_thickness_cm, 'Casing layer thickness'),
    evaluateParam('casing', 'pasteurization_temp_c', casing.pasteurization_temp_c, 'Casing pasteurization temp'),
  ].filter(Boolean);

  const flags = qcComparison.filter((f) => f.status === 'low' || f.status === 'high');

  // Dry matter loss — the reason ash is worth measuring at all. Minerals don't
  // burn off, so while microbes consume organic matter the ash fraction rises,
  // and the rise gives how much dry matter was lost:
  //   loss = 1 − (ash before ÷ ash after)
  // It shows composting intensity per phase: too little lost means composting
  // ran short, too much means it was over-worked and yield potential spent.
  //
  // The Phase I → II figure uses two lab measurements and is the reliable one.
  // Anything starting from the recipe begins at a calculated ash built from
  // literature defaults unless actual values were entered, so it's indicative.
  // A negative result is physically impossible — ash can't fall — and points at
  // a sampling or data-entry problem rather than a real outcome.
  const dmLoss = (before, after) => (before > 0 && after > 0 ? (1 - before / after) * 100 : null);
  const dryMatterLoss = {
    phase1: dmLoss(intake.ashPct, phase1.end_ash_pct),
    phase2: dmLoss(phase1.end_ash_pct, phase2.final_ash_pct),
    total: dmLoss(intake.ashPct, phase2.final_ash_pct),
  };

  // Compost weight: sum of each room's own fill weight where set, else fall
  // back to the batch-wide spawning fill weight (the common single-room case).
  // A growing-unit batch has no spawning of its own — its compost arrived as a
  // delivery — so it falls back to what was received instead.
  const roomsWithWeight = rooms.filter((r) => r.total_fill_weight_kg);
  const totalCompostKg = roomsWithWeight.length
    ? roomsWithWeight.reduce((s, r) => s + r.total_fill_weight_kg, 0)
    : spawning.fill_weight_kg || compostKgForGrowingBatch(batchId) || null;

  let totalGradeA = 0;
  let totalGradeB = 0;
  harvests.forEach((h) => {
    totalGradeA += h.grade_a_kg || 0;
    totalGradeB += h.grade_b_kg || 0;
  });
  const totalHarvestKg = totalGradeA + totalGradeB;
  const yieldPct = totalCompostKg ? (totalHarvestKg / totalCompostKg) * 100 : null;
  const aGradeYieldPct = totalCompostKg ? (totalGradeA / totalCompostKg) * 100 : null;

  // A-Grade Efficiency Ratio: kg of A-grade mushroom produced per NPR 1,000 of
  // compost cost. Higher is better — more premium output per rupee.
  //
  // Where that cost comes from depends on the batch: a full-pipeline batch made
  // its own compost, so it's the recipe cost. A growing-unit batch bought its
  // compost in, so it's the cost carried across on the deliveries it received —
  // otherwise the split would leave every growing batch with no cost basis and
  // the ratio would silently go blank.
  const totalCost = intake.totalCostNpr ?? compostCostForGrowingBatch(batchId);
  const aGradeEfficiency = totalCost ? (totalGradeA / totalCost) * 1000 : null;

  const lastRoomOut = rooms.map((r) => r.room_out_date).filter(Boolean).sort().pop() || null;
  const totalDays = daysBetween(batch.start_date, lastRoomOut || todayLocal());

  return {
    batch,
    intake,
    prewetting,
    phase1,
    phase1AvgTemp,
    phase1AvgMoisture,
    phase1AvgPh,
    phase1Days: daysBetween(phase1.start_date, phase1.end_date),
    phase2,
    phase2AvgTemp,
    phase2AvgAmmonia,
    phase2Days: daysBetween(phase2.fill_date, phase2.end_date),
    spawning,
    spawningDays: daysBetween(spawning.spawning_date, spawning.spawn_run_end_date),
    casing,
    casingDays: daysBetween(casing.application_date, casing.end_date),
    rooms,
    harvests,
    totalCompostKg,
    totalGradeA,
    totalGradeB,
    totalHarvestKg,
    yieldPct,
    aGradeYieldPct,
    totalCost,
    aGradeEfficiency,
    totalDays,
    qcComparison,
    flags,
    dryMatterLoss,
  };
}

// farmId scopes cross-batch reporting to one workspace, so Training practice
// data never lands in the real farm's fleet comparison or its averages.
function getAllBatchMetrics(farmId) {
  const rows =
    farmId === undefined || farmId === null
      ? db.prepare('SELECT id FROM batches ORDER BY start_date').all()
      : db.prepare('SELECT id FROM batches WHERE farm_id = ? ORDER BY start_date').all(farmId);
  return rows.map((b) => getBatchMetrics(b.id));
}

module.exports = {
  getBatchMetrics,
  getAllBatchMetrics,
  avg,
  evaluateParam,
  compostCostForGrowingBatch,
  compostKgForGrowingBatch,
};
