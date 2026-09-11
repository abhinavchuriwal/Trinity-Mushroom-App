const db = require('../db');

// Single source of truth for the batch pipeline: order, display label, and the
// page each stage lives on. Every route file and view shares this.
// `dept` splits the pipeline between the Compost and Growing departments, and
// `permission` is the key that gates *saving* that stage. Viewing any stage is
// open to every logged-in user (full traceability — compost staff can see how
// their compost actually yielded); only editing is departmental.
const STAGE_META = [
  { key: 'prewetting', label: 'Pre-Wetting', dept: 'compost', permission: 'edit_prewetting', path: (id) => `/batches/${id}/prewetting` },
  { key: 'phase1', label: 'Phase I Composting', dept: 'compost', permission: 'edit_phase1', path: (id) => `/batches/${id}/phase1` },
  { key: 'phase2', label: 'Phase II (Pasteurization/Conditioning)', dept: 'compost', permission: 'edit_phase2', path: (id) => `/batches/${id}/phase2` },
  { key: 'spawning', label: 'Spawning', dept: 'compost', permission: 'edit_spawning', path: (id) => `/batches/${id}/spawning` },
  { key: 'casing', label: 'Casing Soil Preparation', dept: 'growing', permission: 'edit_casing', path: (id) => `/batches/${id}/casing` },
  { key: 'room_in', label: 'Room In', dept: 'growing', permission: 'edit_room_in', path: (id) => `/batches/${id}/rooms` },
  { key: 'harvest', label: 'Harvest', dept: 'growing', permission: 'edit_harvest', path: (id) => `/batches/${id}/harvest` },
  { key: 'room_out', label: 'Room Out', dept: 'growing', permission: 'edit_room_out', path: (id) => `/batches/${id}/room-out` },
];

const DEPT_LABELS = { compost: 'Compost Dept', growing: 'Growing Dept' };

const STAGES = STAGE_META.map((s) => s.key);
const STAGE_LABELS = Object.fromEntries(STAGE_META.map((s) => [s.key, s.label]));

function stagePath(key, batchId) {
  const meta = STAGE_META.find((s) => s.key === key);
  return meta ? meta.path(batchId) : `/batches/${batchId}`;
}

function nextStagePath(fromStage, batchId) {
  const idx = STAGES.indexOf(fromStage);
  if (idx === -1 || idx + 1 >= STAGES.length) return `/batches/${batchId}`;
  return stagePath(STAGES[idx + 1], batchId);
}

// Advances current_stage if this stage is at or ahead of where the batch
// currently is. Marks the batch fully completed once the final stage advances.
function advanceStage(batchId, fromStage) {
  const idx = STAGES.indexOf(fromStage);
  const batch = db.prepare('SELECT current_stage FROM batches WHERE id = ?').get(batchId);
  if (STAGES.indexOf(batch.current_stage) > idx) return;
  if (idx + 1 < STAGES.length) {
    db.prepare('UPDATE batches SET current_stage = ? WHERE id = ?').run(STAGES[idx + 1], batchId);
  } else {
    db.prepare("UPDATE batches SET current_stage = ?, status = 'completed' WHERE id = ?").run(fromStage, batchId);
  }
}

module.exports = { STAGE_META, STAGES, STAGE_LABELS, DEPT_LABELS, stagePath, nextStagePath, advanceStage };
