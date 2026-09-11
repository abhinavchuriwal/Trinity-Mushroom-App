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
  const v = Number(value);
  if (Number.isNaN(v)) return { status: 'na', param };
  if (param.min_value !== null && v < param.min_value) return { status: 'low', param };
  if (param.max_value !== null && v > param.max_value) return { status: 'high', param };
  return { status: 'ok', param };
}

module.exports = { loadParams, invalidate, getParam, getParamsForStage, evaluate };
