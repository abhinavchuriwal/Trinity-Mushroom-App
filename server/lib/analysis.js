const { avg } = require('./analytics');

// Short plain-language notes on why each parameter matters for yield, used to
// make the rule-based analysis actually explain something instead of just
// restating numbers.
const CONTEXT_NOTES = {
  'intake.cn_ratio':
    'C:N ratio governs nitrogen availability for mycelium growth — too high (excess carbon) slows colonization, too low can cause ammonia buildup and contamination risk',
  'phase1.pile_temp_c':
    'Phase I peak temperature drives pathogen/weed-seed kill and microbial selectivity — too low risks incomplete pasteurization, too high can kill beneficial organisms',
  'phase1.moisture_pct': 'Phase I moisture affects microbial activity — too dry limits it, too wet causes anaerobic/compaction problems',
  'phase1.ph': 'Phase I pH affects microbial selectivity going into Phase II',
  'phase2.pasteurization_temp_c': 'Pasteurization temperature must be hot enough to kill competitors without killing the compost\'s own beneficial biology',
  'phase2.pasteurization_duration_hrs': 'Pasteurization duration works together with temperature — too short under-treats, too long over-treats the substrate',
  'phase2.temp_c': 'Conditioning temperature drives ammonia off-gassing and development of selective microorganisms',
  'phase2.ammonia_ppm': 'Residual ammonia is toxic to spawn — high levels delay or inhibit colonization',
  'phase2.final_moisture_pct': 'Moisture entering spawning needs to be in range for good, even colonization',
  'spawning.compost_temp_c': 'Compost must be cooled into range before spawning, or heat can stress/kill the spawn',
  'spawning.spawn_rate_pct': 'Spawn rate affects colonization speed and how well the spawn out-competes contaminants',
  'casing.ph': 'Casing pH strongly influences pinning',
  'casing.moisture_pct': 'Casing moisture is the water reserve mushrooms draw on during flushes',
  'casing.layer_thickness_cm': 'Casing layer thickness affects water reserve and pinning uniformity',
  'casing.pasteurization_temp_c': 'Casing pasteurization controls competitor/pest organisms in the casing material',
};

function fmtNum(n, digits = 1) {
  return n === null || n === undefined ? '—' : Number(n).toFixed(digits);
}

// Deterministic, explainable analysis: compares this batch/room's yield to
// the average of other completed batches, and lists every QC parameter that
// fell outside its configured range along with why that parameter matters.
function buildRuleBasedAnalysis(metrics, allMetrics, roomContext) {
  const lines = [];
  const others = (allMetrics || []).filter((m) => m.batch.id !== metrics.batch.id && m.yieldPct !== null);
  const avgYield = avg(others.map((m) => m.yieldPct));

  const yieldPct = roomContext ? roomContext.yieldPct : metrics.yieldPct;
  if (yieldPct !== null) {
    if (avgYield !== null) {
      const diff = yieldPct - avgYield;
      const compareWord = diff >= 5 ? 'above' : diff <= -5 ? 'below' : 'close to';
      lines.push(
        `Yield was ${fmtNum(yieldPct)}%, ${compareWord} the ${fmtNum(avgYield)}% average across your other ${others.length} completed batch${others.length === 1 ? '' : 'es'} (${diff >= 0 ? '+' : ''}${fmtNum(diff)} pts).`
      );
    } else {
      lines.push(`Yield was ${fmtNum(yieldPct)}%. Not enough completed batches yet to compare against an average — this will get more useful as you log more.`);
    }
  } else {
    lines.push('Yield could not be calculated — enter a compost fill weight for this room to see it.');
  }

  if (metrics.flags.length) {
    lines.push('');
    lines.push(`${metrics.flags.length} parameter${metrics.flags.length === 1 ? '' : 's'} fell outside the configured QC range for this batch:`);
    metrics.flags.forEach((f) => {
      const dir = f.status === 'low' ? 'below' : 'above';
      const target = f.status === 'low' ? f.min : f.max;
      const note = CONTEXT_NOTES[`${f.stage}.${f.param}`];
      lines.push(`- ${f.label}: ${fmtNum(f.value, f.unit === '' ? 1 : 1)}${f.unit} (${dir} target of ${fmtNum(target)}${f.unit}).${note ? ' ' + note + '.' : ''}`);
    });
  } else {
    lines.push('');
    lines.push('Every tracked parameter for this batch stayed within its configured QC range.');
  }

  if (metrics.totalCost !== null || metrics.aGradeEfficiency !== null) {
    lines.push('');
    const parts = [];
    if (metrics.totalCost !== null) parts.push(`raw material cost NPR ${fmtNum(metrics.totalCost, 0)}`);
    if (metrics.aGradeEfficiency !== null) parts.push(`A-Grade Efficiency Ratio ${fmtNum(metrics.aGradeEfficiency, 2)} kg per NPR 1,000 spent`);
    lines.push(parts.join(', ') + '.');
  }

  lines.push('');
  if (metrics.flags.length && yieldPct !== null && avgYield !== null && yieldPct < avgYield) {
    lines.push(
      `Suggestion: start with ${metrics.flags[0].label} on the next batch — it's out of range and is one of the more direct levers on yield. Recalibrate the QC target range in Settings first if you believe the current range doesn't match your local conditions.`
    );
  } else if (metrics.flags.length) {
    lines.push('Suggestion: worth tightening the flagged parameters even though yield held up this time — they add risk on the next batch.');
  } else if (avgYield !== null && yieldPct !== null && yieldPct >= avgYield) {
    lines.push('This batch\'s recipe and process parameters are a good reference point for repeating.');
  }

  return lines.join('\n');
}

async function callClaude(metrics, allMetrics, roomContext, ruleText) {
  if (!process.env.ANTHROPIC_API_KEY) return null;
  let Anthropic;
  try {
    Anthropic = require('@anthropic-ai/sdk');
  } catch {
    return null;
  }

  const client = new Anthropic();
  const others = (allMetrics || []).filter((m) => m.batch.id !== metrics.batch.id && m.yieldPct !== null);
  const avgYield = avg(others.map((m) => m.yieldPct));

  const dataSummary = {
    batch_code: metrics.batch.batch_code,
    room: roomContext ? roomContext.room_no : undefined,
    yield_pct: roomContext ? roomContext.yieldPct : metrics.yieldPct,
    a_grade_yield_pct: roomContext ? roomContext.aGradeYieldPct : metrics.aGradeYieldPct,
    fleet_average_yield_pct: avgYield,
    completed_batches_compared: others.length,
    cn_ratio: metrics.intake.cnRatio,
    phase1_avg_pile_temp_c: metrics.phase1AvgTemp,
    phase1_avg_moisture_pct: metrics.phase1AvgMoisture,
    phase1_avg_ph: metrics.phase1AvgPh,
    phase2_pasteurization_temp_c: metrics.phase2.pasteurization_temp_c,
    phase2_pasteurization_duration_hrs: metrics.phase2.pasteurization_duration_hrs,
    phase2_avg_conditioning_temp_c: metrics.phase2AvgTemp,
    phase2_final_moisture_pct: metrics.phase2.final_moisture_pct,
    spawn_rate_pct: metrics.spawning.spawn_rate_pct,
    spawning_compost_temp_c: metrics.spawning.compost_temp_c,
    casing_ph: metrics.casing.ph,
    casing_moisture_pct: metrics.casing.moisture_pct,
    out_of_qc_range: metrics.flags.map((f) => `${f.label}: ${f.value}${f.unit} (target ${f.min}-${f.max}${f.unit})`),
    total_cost_npr: metrics.totalCost,
    a_grade_efficiency_ratio_kg_per_1000_npr: metrics.aGradeEfficiency,
  };

  try {
    const response = await client.messages.create({
      model: 'claude-opus-5',
      max_tokens: 1024,
      messages: [
        {
          role: 'user',
          content:
            `You are advising a button mushroom (Agaricus bisporus) compost/spawning farm manager in Nepal on a specific batch's performance. ` +
            `Here is the structured data for this batch/room, plus a rule-based draft analysis for reference:\n\n` +
            `DATA:\n${JSON.stringify(dataSummary, null, 2)}\n\n` +
            `RULE-BASED DRAFT:\n${ruleText}\n\n` +
            `Write a short (120-180 words), specific, practical analysis in plain English: what likely went right or wrong for yield, ` +
            `grounded in the actual numbers given (cite specific values), and 1-3 concrete suggestions for the next batch. ` +
            `Do not restate every number — focus on what's most likely to move yield. No headers, no markdown, plain prose paragraphs.`,
        },
      ],
    });
    const textBlock = response.content.find((b) => b.type === 'text');
    return textBlock ? textBlock.text.trim() : null;
  } catch (err) {
    console.error('Claude analysis call failed, falling back to rule-based analysis:', err.message);
    return null;
  }
}

// Returns { source: 'ai'|'rules', text }. Always succeeds — falls back to the
// deterministic rule-based analysis if no API key is configured or the API
// call fails for any reason.
async function generateAnalysis(metrics, allMetrics, roomContext) {
  const ruleText = buildRuleBasedAnalysis(metrics, allMetrics, roomContext);
  const aiText = await callClaude(metrics, allMetrics, roomContext, ruleText);
  if (aiText) return { source: 'ai', text: aiText };
  return { source: 'rules', text: ruleText };
}

const FLEET_PARAM_DEFS = [
  { key: 'intake.cn_ratio', label: 'C:N ratio', get: (m) => m.intake.cnRatio },
  { key: 'phase1.pile_temp_c', label: 'Phase I pile temp', get: (m) => m.phase1AvgTemp },
  { key: 'phase1.moisture_pct', label: 'Phase I moisture', get: (m) => m.phase1AvgMoisture },
  { key: 'phase1.ph', label: 'Phase I pH', get: (m) => m.phase1AvgPh },
  { key: 'phase2.pasteurization_temp_c', label: 'Pasteurization temp', get: (m) => m.phase2.pasteurization_temp_c },
  { key: 'phase2.temp_c', label: 'Conditioning temp', get: (m) => m.phase2AvgTemp },
  { key: 'phase2.final_moisture_pct', label: 'Final moisture', get: (m) => m.phase2.final_moisture_pct },
  { key: 'spawning.spawn_rate_pct', label: 'Spawn rate', get: (m) => m.spawning.spawn_rate_pct },
  { key: 'spawning.compost_temp_c', label: 'Compost temp at spawning', get: (m) => m.spawning.compost_temp_c },
  { key: 'casing.ph', label: 'Casing pH', get: (m) => m.casing.ph },
  { key: 'casing.moisture_pct', label: 'Casing moisture', get: (m) => m.casing.moisture_pct },
];

// Deterministic cross-batch comparison: best vs. worst yield, and for each
// tracked parameter, the average yield of batches that stayed in its QC
// range vs. batches that didn't — a simple, honest stand-in for correlation.
function buildFleetRuleAnalysis(allMetrics) {
  const withYield = (allMetrics || []).filter((m) => m.yieldPct !== null);
  if (withYield.length < 2) {
    return 'Not enough completed batches with yield data yet to compare. Log Room Out data (compost fill weight + harvest) for at least two batches to unlock comparison insights.';
  }

  const sorted = [...withYield].sort((a, b) => b.yieldPct - a.yieldPct);
  const best = sorted[0];
  const worst = sorted[sorted.length - 1];
  const avgYield = avg(withYield.map((m) => m.yieldPct));

  const describe = (m) =>
    `C:N ${fmtNum(m.intake.cnRatio)}:1, Phase I avg temp ${fmtNum(m.phase1AvgTemp)}°C, spawn rate ${fmtNum(m.spawning.spawn_rate_pct)}%, casing pH ${fmtNum(m.casing.ph)}. ` +
    `Flags: ${m.flags.length ? m.flags.map((f) => f.label).join(', ') : 'none'}.`;

  const lines = [];
  lines.push(`Average yield across ${withYield.length} completed batches: ${fmtNum(avgYield)}%.`);
  lines.push('');
  lines.push(`Best: ${best.batch.batch_code} at ${fmtNum(best.yieldPct)}% yield. ${describe(best)}`);
  if (worst.batch.id !== best.batch.id) {
    lines.push(`Worst: ${worst.batch.batch_code} at ${fmtNum(worst.yieldPct)}% yield. ${describe(worst)}`);
  }

  const correlationLines = [];
  FLEET_PARAM_DEFS.forEach((pd) => {
    const inRange = withYield.filter((m) => pd.get(m) !== null && !m.flags.some((f) => `${f.stage}.${f.param}` === pd.key));
    const outRange = withYield.filter((m) => m.flags.some((f) => `${f.stage}.${f.param}` === pd.key));
    if (inRange.length && outRange.length) {
      const avgIn = avg(inRange.map((m) => m.yieldPct));
      const avgOut = avg(outRange.map((m) => m.yieldPct));
      const diff = avgIn - avgOut;
      if (Math.abs(diff) >= 3) {
        correlationLines.push(
          `- ${pd.label}: batches within target averaged ${fmtNum(avgIn)}% yield vs ${fmtNum(avgOut)}% when out of range (${diff >= 0 ? '+' : ''}${fmtNum(diff)} pts, n=${inRange.length} vs n=${outRange.length}).`
        );
      }
    }
  });
  if (correlationLines.length) {
    lines.push('');
    lines.push('Parameters where staying in range tracked with higher yield:');
    lines.push(...correlationLines);
  }

  return lines.join('\n');
}

async function callClaudeFleet(allMetrics, ruleText) {
  if (!process.env.ANTHROPIC_API_KEY) return null;
  let Anthropic;
  try {
    Anthropic = require('@anthropic-ai/sdk');
  } catch {
    return null;
  }
  const client = new Anthropic();
  const withYield = (allMetrics || []).filter((m) => m.yieldPct !== null);
  const summary = withYield.map((m) => ({
    batch_code: m.batch.batch_code,
    yield_pct: m.yieldPct,
    a_grade_yield_pct: m.aGradeYieldPct,
    cn_ratio: m.intake.cnRatio,
    phase1_avg_pile_temp_c: m.phase1AvgTemp,
    phase2_pasteurization_temp_c: m.phase2.pasteurization_temp_c,
    spawn_rate_pct: m.spawning.spawn_rate_pct,
    casing_ph: m.casing.ph,
    out_of_qc_range: m.flags.map((f) => f.label),
    a_grade_efficiency_ratio_kg_per_1000_npr: m.aGradeEfficiency,
  }));

  try {
    const response = await client.messages.create({
      model: 'claude-opus-5',
      max_tokens: 1024,
      messages: [
        {
          role: 'user',
          content:
            `You are advising a button mushroom (Agaricus bisporus) compost/spawning farm manager in Nepal, comparing performance across their completed batches. ` +
            `Here is per-batch data plus a rule-based draft comparison:\n\n` +
            `BATCHES:\n${JSON.stringify(summary, null, 2)}\n\n` +
            `RULE-BASED DRAFT:\n${ruleText}\n\n` +
            `Write a short (150-220 words), specific, practical comparison in plain English: what process differences most likely explain the yield gap between the best and worst batches, ` +
            `citing actual figures, and 2-4 concrete, prioritized recommendations for future batches. No headers, no markdown, plain prose paragraphs.`,
        },
      ],
    });
    const textBlock = response.content.find((b) => b.type === 'text');
    return textBlock ? textBlock.text.trim() : null;
  } catch (err) {
    console.error('Claude fleet analysis call failed, falling back to rule-based analysis:', err.message);
    return null;
  }
}

async function generateFleetAnalysis(allMetrics) {
  const ruleText = buildFleetRuleAnalysis(allMetrics);
  const aiText = await callClaudeFleet(allMetrics, ruleText);
  if (aiText) return { source: 'ai', text: aiText };
  return { source: 'rules', text: ruleText };
}

module.exports = { generateAnalysis, generateFleetAnalysis, buildRuleBasedAnalysis, buildFleetRuleAnalysis };
