const db = require('../db');

// Single source of truth for the batch pipelines: order, display label, and the
// page each stage lives on. Every route file and view shares this.
//
// `dept` splits stages between the Compost and Growing departments, and
// `permission` is the key that gates *saving* that stage.
//
// There are three pipelines because the compost unit and the growing unit can
// be run as separate operations on separate sites:
//   full    — the original end-to-end pipeline, for the single-site workspace
//             that predates the split. Kept so historical batches stay readable
//             exactly as they were recorded.
//   compost — ends at Dispatch, when the compost leaves the site.
//   growing — starts at Receipt, when compost arrives.
const ALL_STAGES = {
  prewetting: { key: 'prewetting', label: 'Pre-Wetting', dept: 'compost', permission: 'edit_prewetting', path: (id) => `/batches/${id}/prewetting` },
  phase1: { key: 'phase1', label: 'Phase I Composting', dept: 'compost', permission: 'edit_phase1', path: (id) => `/batches/${id}/phase1` },
  phase2: { key: 'phase2', label: 'Phase II (Pasteurization/Conditioning)', dept: 'compost', permission: 'edit_phase2', path: (id) => `/batches/${id}/phase2` },
  spawning: { key: 'spawning', label: 'Spawning', dept: 'compost', permission: 'edit_spawning', path: (id) => `/batches/${id}/spawning` },
  dispatch: { key: 'dispatch', label: 'Dispatch', dept: 'compost', permission: 'edit_dispatch', path: (id) => `/batches/${id}/dispatch` },
  receipt: { key: 'receipt', label: 'Compost Receipt', dept: 'growing', permission: 'edit_receipt', path: (id) => `/batches/${id}/receipt` },
  casing: { key: 'casing', label: 'Casing Soil Preparation', dept: 'growing', permission: 'edit_casing', path: (id) => `/batches/${id}/casing` },
  room_in: { key: 'room_in', label: 'Room In', dept: 'growing', permission: 'edit_room_in', path: (id) => `/batches/${id}/rooms` },
  harvest: { key: 'harvest', label: 'Harvest', dept: 'growing', permission: 'edit_harvest', path: (id) => `/batches/${id}/harvest` },
  room_out: { key: 'room_out', label: 'Room Out', dept: 'growing', permission: 'edit_room_out', path: (id) => `/batches/${id}/room-out` },
};

const PIPELINES = {
  full: ['prewetting', 'phase1', 'phase2', 'spawning', 'casing', 'room_in', 'harvest', 'room_out'],
  compost: ['prewetting', 'phase1', 'phase2', 'spawning', 'dispatch'],
  growing: ['receipt', 'casing', 'room_in', 'harvest', 'room_out'],
};

const UNIT_LABELS = { full: 'Full pipeline', compost: 'Compost Unit', growing: 'Growing Unit' };
const DEPT_LABELS = { compost: 'Compost Dept', growing: 'Growing Dept' };

function stagesFor(batchType) {
  return (PIPELINES[batchType] || PIPELINES.full).map((key) => ALL_STAGES[key]);
}

function stageKeysFor(batchType) {
  return PIPELINES[batchType] || PIPELINES.full;
}

// The original export, still the full pipeline — used where a view needs every
// stage that exists rather than one batch's own pipeline.
const STAGE_META = stagesFor('full');
const STAGES = PIPELINES.full;
const STAGE_LABELS = Object.fromEntries(Object.values(ALL_STAGES).map((s) => [s.key, s.label]));

function stagePath(key, batchId) {
  const meta = ALL_STAGES[key];
  return meta ? meta.path(batchId) : `/batches/${batchId}`;
}

function batchType(batchId) {
  const row = db.prepare('SELECT batch_type FROM batches WHERE id = ?').get(batchId);
  return (row && row.batch_type) || 'full';
}

function nextStagePath(fromStage, batchId) {
  const keys = stageKeysFor(batchType(batchId));
  const idx = keys.indexOf(fromStage);
  if (idx === -1 || idx + 1 >= keys.length) return `/batches/${batchId}`;
  return stagePath(keys[idx + 1], batchId);
}

// Advances current_stage if this stage is at or ahead of where the batch
// currently is. Marks the batch fully completed once the final stage advances.
// Which stage counts as "final" depends on the batch's own pipeline — a compost
// batch is finished once dispatched, not once someone has harvested mushrooms.
function advanceStage(batchId, fromStage) {
  const keys = stageKeysFor(batchType(batchId));
  const idx = keys.indexOf(fromStage);
  if (idx === -1) return;
  const batch = db.prepare('SELECT current_stage FROM batches WHERE id = ?').get(batchId);
  if (keys.indexOf(batch.current_stage) > idx) return;
  if (idx + 1 < keys.length) {
    db.prepare('UPDATE batches SET current_stage = ? WHERE id = ?').run(keys[idx + 1], batchId);
  } else {
    db.prepare("UPDATE batches SET current_stage = ?, status = 'completed' WHERE id = ?").run(fromStage, batchId);
  }
}

module.exports = {
  ALL_STAGES,
  PIPELINES,
  STAGE_META,
  STAGES,
  STAGE_LABELS,
  DEPT_LABELS,
  UNIT_LABELS,
  stagesFor,
  stageKeysFor,
  stagePath,
  nextStagePath,
  advanceStage,
};
