const db = require('./../db');
const { getBatchMetrics } = require('./analytics');

// The compost spec that travels with a delivery — the growing unit's only
// window into how that compost was made. Frozen as JSON at dispatch rather than
// read live from the compost batch, for two reasons: the two units are separate
// workspaces and the growing side has no access to the other's records, and the
// spec should describe the compost as it left, not as the compost batch's rows
// happen to read months later.
function buildSpecSnapshot(compostBatchId) {
  const m = getBatchMetrics(compostBatchId);
  if (!m) return null;
  return {
    batch_code: m.batch.batch_code,
    start_date: m.batch.start_date,
    // The measured finished-compost figures come first because they're what a
    // grower needs: the state of the compost actually being delivered. The
    // recipe C:N is the calculated *starting* point, ~15 points higher by
    // design, and is kept only as context under its own unambiguous name.
    final_cn_ratio: m.phase2.final_cn_ratio ?? null,
    final_nitrogen_pct: m.phase2.final_nitrogen_pct ?? null,
    final_ash_pct: m.phase2.final_ash_pct ?? null,
    dry_matter_loss_pct: m.dryMatterLoss ? m.dryMatterLoss.total : null,
    recipe_cn_ratio: m.intake.cnRatio,
    recipe_ash_pct: m.intake.ashPct,
    recipe_wet_kg: m.intake.totalWetKg,
    recipe_dry_kg: m.intake.totalDryKg,
    phase1_avg_temp_c: m.phase1AvgTemp,
    phase1_avg_moisture_pct: m.phase1AvgMoisture,
    phase1_avg_ph: m.phase1AvgPh,
    phase2_pasteurization_temp_c: m.phase2.pasteurization_temp_c ?? null,
    phase2_pasteurization_duration_hrs: m.phase2.pasteurization_duration_hrs ?? null,
    phase2_avg_conditioning_temp_c: m.phase2AvgTemp,
    phase2_avg_ammonia_ppm: m.phase2AvgAmmonia,
    phase2_final_moisture_pct: m.phase2.final_moisture_pct ?? null,
    ammonia_cleared: m.phase2.ammonia_cleared ?? null,
    spawning_date: m.spawning.spawning_date ?? null,
    spawn_run_end_date: m.spawning.spawn_run_end_date ?? null,
    spawn_strain: m.spawning.spawn_strain ?? null,
    spawn_rate_pct: m.spawning.spawn_rate_pct ?? null,
    compost_temp_at_spawning_c: m.spawning.compost_temp_c ?? null,
    total_fill_weight_kg: m.spawning.fill_weight_kg ?? null,
    qc_flags: m.flags.map((f) => ({ label: f.label, status: f.status, value: f.value, min: f.min, max: f.max, unit: f.unit })),
  };
}

// A delivery's share of what the compost cost to make, by weight. Without this
// the growing unit has no cost basis at all once the units are split, and the
// A-Grade Efficiency Ratio stops meaning anything.
//
// Falls back to the compost actually dispatched so far when the batch has no
// recorded fill weight — better a share across known deliveries than silently
// attributing the whole batch cost to the first one out of the gate.
function costShareFor(compostBatchId, qtyKg, excludeDispatchId) {
  const m = getBatchMetrics(compostBatchId);
  if (!m || m.totalCost === null || !qtyKg) return null;

  const producedKg = m.spawning.fill_weight_kg || null;
  if (producedKg) return (m.totalCost * qtyKg) / producedKg;

  const otherKg = db
    .prepare('SELECT COALESCE(SUM(qty_kg), 0) AS kg FROM compost_dispatches WHERE compost_batch_id = ? AND id != ?')
    .get(compostBatchId, excludeDispatchId || -1).kg;
  const basis = otherKg + qtyKg;
  return basis > 0 ? (m.totalCost * qtyKg) / basis : null;
}

function dispatchesForCompostBatch(compostBatchId) {
  return db
    .prepare('SELECT * FROM compost_dispatches WHERE compost_batch_id = ? ORDER BY dispatch_date, id')
    .all(compostBatchId);
}

// Deliveries feeding a growing batch, with the spec parsed back out.
function receiptsForGrowingBatch(growingBatchId) {
  return db
    .prepare('SELECT * FROM compost_dispatches WHERE growing_batch_id = ? ORDER BY dispatch_date, id')
    .all(growingBatchId)
    .map((d) => ({ ...d, spec: parseSpec(d.spec_snapshot) }));
}

// Dispatches that have left the compost unit but haven't been claimed by a
// growing batch yet — what the growing unit picks from when starting a batch.
function unclaimedDispatches() {
  return db
    .prepare(
      `SELECT * FROM compost_dispatches
       WHERE destination_type = 'internal' AND growing_batch_id IS NULL
       ORDER BY dispatch_date DESC, id DESC`
    )
    .all()
    .map((d) => ({ ...d, spec: parseSpec(d.spec_snapshot) }));
}

function parseSpec(json) {
  if (!json) return null;
  try {
    return JSON.parse(json);
  } catch (_) {
    return null;
  }
}

// compostCostForGrowingBatch / compostKgForGrowingBatch live in analytics.js
// rather than here: analytics needs them, this module needs analytics for the
// spec snapshot, and putting them here would make the two require each other.

module.exports = {
  buildSpecSnapshot,
  costShareFor,
  dispatchesForCompostBatch,
  receiptsForGrowingBatch,
  unclaimedDispatches,
  parseSpec,
};
