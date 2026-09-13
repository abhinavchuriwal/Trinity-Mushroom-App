const db = require('../db');

function num(v) {
  if (v === undefined || v === null || v === '') return null;
  const n = Number(v);
  return Number.isNaN(n) ? null : n;
}

function str(v) {
  return v === undefined || v === '' ? null : v;
}

function asArray(v) {
  if (v === undefined) return [];
  return Array.isArray(v) ? v : [v];
}

// Generic single-row-per-batch upsert used by every stage's summary form.
function upsert(table, batchId, fields) {
  const existing = db.prepare(`SELECT batch_id FROM ${table} WHERE batch_id = ?`).get(batchId);
  const cols = Object.keys(fields);
  if (existing) {
    const setClause = cols.map((c) => `${c} = @${c}`).join(', ');
    db.prepare(`UPDATE ${table} SET ${setClause}, updated_at = datetime('now') WHERE batch_id = @batch_id`).run({
      ...fields,
      batch_id: batchId,
    });
  } else {
    const colList = ['batch_id', ...cols].join(', ');
    const valList = ['@batch_id', ...cols.map((c) => `@${c}`)].join(', ');
    db.prepare(`INSERT INTO ${table} (${colList}) VALUES (${valList})`).run({
      ...fields,
      batch_id: batchId,
    });
  }
}

// Lightweight batch header (code/status/stage) for the banner shown on every
// stage page — cheap, unlike loadBatch which pulls every stage's full data.
// farmId scopes the lookup so a batch from another farm (e.g. Training data
// while you're in the real farm) can't be reached by typing its URL — callers
// treat "not found" and "not your farm" identically, as a 404.
function getBatchHeader(id, farmId) {
  // batch_type is part of the header: every stage page's tab bar renders the
  // batch's own pipeline from it, and without it a compost or growing batch
  // silently falls back to showing all eight stages of the old single-site one.
  if (farmId === undefined || farmId === null) {
    return db
      .prepare('SELECT id, batch_code, start_date, current_stage, status, farm_id, batch_type FROM batches WHERE id = ?')
      .get(id);
  }
  return db
    .prepare(
      'SELECT id, batch_code, start_date, current_stage, status, farm_id, batch_type FROM batches WHERE id = ? AND farm_id = ?'
    )
    .get(id, farmId);
}

module.exports = { num, str, asArray, upsert, getBatchHeader };
