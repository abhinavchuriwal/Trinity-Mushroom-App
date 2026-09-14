const db = require('../db');

let cache = null;

function loadParams() {
  if (!cache) {
    cache = db.prepare('SELECT * FROM qc_parameters').all();
  }
  return cache;
}

function invalidate() {
  cache = null;
}

function getParam(stage, paramKey) {
  return loadParams().find((p) => p.stage === stage && p.param_key === paramKey);
}

function getParamsForStage(stage) {
  return loadParams().filter((p) => p.stage === stage);
}

// Returns { status: 'ok'|'low'|'high'|'na', param } for a numeric value.
function evaluate(stage, paramKey, value) {
  const param = getParam(stage, paramKey);
  if (!param || value === null || value === undefined || value === '') {
    return { status: 'na', param };
  }
  // A parameter with neither bound set has no target to judge against. It must
  // read as 'na', not 'ok' — otherwise a value nobody has set a standard for
  // shows a green OK, implying it passed a check that doesn't exist. Such rows
  // are seeded deliberately, so a grower can fill in a target in QC Settings.
  if (param.min_value === null && param.max_value === null) {
    return { status: 'na', param };
  }
  const v = Number(value);
  if (Number.isNaN(v)) return { status: 'na', param };
  if (param.min_value !== null && v < param.min_value) return { status: 'low', param };
  if (param.max_value !== null && v > param.max_value) return { status: 'high', param };
  return { status: 'ok', param };
}

module.exports = { loadParams, invalidate, getParam, getParamsForStage, evaluate };
