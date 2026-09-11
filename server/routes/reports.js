const express = require('express');
const { getAllBatchMetrics } = require('../lib/analytics');
const { generateFleetAnalysis } = require('../lib/analysis');
const { requirePermission } = require('../lib/auth');
const { nepaliFiscalYear } = require('../lib/nepaliFY');

const router = express.Router();

const SORTERS = {
  batch_code: (m) => m.batch.batch_code,
  start_date: (m) => m.batch.start_date || '',
  days: (m) => m.totalDays ?? -1,
  cn_ratio: (m) => m.intake.cnRatio ?? -1,
  cost: (m) => m.totalCost ?? -1,
  compost_kg: (m) => m.totalCompostKg ?? -1,
  harvest_kg: (m) => m.totalHarvestKg ?? -1,
  yield_pct: (m) => m.yieldPct ?? -1,
  a_grade_pct: (m) => m.aGradeYieldPct ?? -1,
  efficiency: (m) => m.aGradeEfficiency ?? -1,
  flags: (m) => m.flags.length,
};

function sortMetrics(metrics, sort, dir) {
  const getter = SORTERS[sort] || SORTERS.start_date;
  const sorted = [...metrics].sort((a, b) => {
    const av = getter(a);
    const bv = getter(b);
    if (av < bv) return -1;
    if (av > bv) return 1;
    return 0;
  });
  return dir === 'asc' ? sorted : sorted.reverse();
}

function summarize(metrics) {
  const withYield = metrics.filter((m) => m.yieldPct !== null);
  const withAGrade = metrics.filter((m) => m.aGradeYieldPct !== null);
  const withEfficiency = metrics.filter((m) => m.aGradeEfficiency !== null);
  const avgOf = (rows, pick) => (rows.length ? rows.reduce((s, m) => s + pick(m), 0) / rows.length : null);
  return {
    batchCount: metrics.length,
    avgYield: avgOf(withYield, (m) => m.yieldPct),
    avgAGradeYield: avgOf(withAGrade, (m) => m.aGradeYieldPct),
    totalCost: metrics.reduce((s, m) => s + (m.totalCost || 0), 0) || null,
    totalHarvestKg: metrics.reduce((s, m) => s + (m.totalHarvestKg || 0), 0) || null,
    avgEfficiency: avgOf(withEfficiency, (m) => m.aGradeEfficiency),
    totalFlags: metrics.reduce((s, m) => s + m.flags.length, 0),
  };
}

router.get('/', (req, res) => {
  const allMetrics = getAllBatchMetrics(req.farmId).map((m) => ({ ...m, fy: nepaliFiscalYear(m.batch.start_date) }));
  const sort = req.query.sort || 'start_date';
  const dir = req.query.dir === 'asc' ? 'asc' : 'desc';

  const fiscalYears = [...new Set(allMetrics.map((m) => m.fy).filter(Boolean))].sort().reverse();
  const fy = req.query.fy && fiscalYears.includes(req.query.fy) ? req.query.fy : null;
  const scoped = fy ? allMetrics.filter((m) => m.fy === fy) : allMetrics;

  // Year-over-year: the same summary computed per fiscal year, newest first.
  // This is why FY is a filter rather than a separate data store — every year
  // stays queryable side by side instead of being closed off.
  const byFiscalYear = fiscalYears.map((y) => ({ fy: y, ...summarize(allMetrics.filter((m) => m.fy === y)) }));

  res.render('reports', {
    metrics: sortMetrics(scoped, sort, dir),
    sort,
    dir,
    fleetSummary: summarize(scoped),
    fiscalYears,
    fy,
    byFiscalYear,
  });
});

router.get('/analysis', async (req, res) => {
  try {
    const allMetrics = getAllBatchMetrics(req.farmId);
    const analysis = await generateFleetAnalysis(allMetrics);
    res.json(analysis);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.get('/export.csv', requirePermission('export_data'), (req, res) => {
  const allMetrics = getAllBatchMetrics(req.farmId);
  const csvVal = (v) => (v === null || v === undefined ? '' : String(v).replace(/,/g, ';'));
  const round = (v, d = 1) => (v === null || v === undefined ? null : Number(v.toFixed(d)));

  const header = [
    'batch_code', 'status', 'start_date', 'total_days', 'cn_ratio',
    'total_cost_npr', 'compost_kg', 'harvest_kg', 'grade_a_kg', 'grade_b_kg',
    'yield_pct', 'a_grade_yield_pct', 'a_grade_efficiency_ratio_kg_per_1000_npr',
    'phase1_avg_pile_temp_c', 'phase1_avg_moisture_pct', 'phase1_avg_ph',
    'phase2_pasteurization_temp_c', 'phase2_avg_conditioning_temp_c', 'phase2_final_moisture_pct',
    'spawn_rate_pct', 'spawning_compost_temp_c', 'casing_ph', 'casing_moisture_pct',
    'qc_flags_count', 'qc_flags',
  ];

  const lines = [header.join(',')];
  allMetrics.forEach((m) => {
    lines.push(
      [
        m.batch.batch_code, m.batch.status, m.batch.start_date, m.totalDays, round(m.intake.cnRatio),
        round(m.totalCost, 2), round(m.totalCompostKg), round(m.totalHarvestKg), round(m.totalGradeA), round(m.totalGradeB),
        round(m.yieldPct), round(m.aGradeYieldPct), round(m.aGradeEfficiency, 2),
        round(m.phase1AvgTemp), round(m.phase1AvgMoisture), round(m.phase1AvgPh),
        round(m.phase2.pasteurization_temp_c), round(m.phase2AvgTemp), round(m.phase2.final_moisture_pct),
        round(m.spawning.spawn_rate_pct), round(m.spawning.compost_temp_c), round(m.casing.ph), round(m.casing.moisture_pct),
        m.flags.length, m.flags.map((f) => f.label).join('; '),
      ]
        .map(csvVal)
        .join(',')
    );
  });

  res.setHeader('Content-Type', 'text/csv');
  res.setHeader('Content-Disposition', 'attachment; filename="trinity-agro-batch-report.csv"');
  res.send(lines.join('\n'));
});

module.exports = router;
