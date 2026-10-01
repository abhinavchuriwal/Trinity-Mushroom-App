const db = require('../db');
const { num, str, upsert } = require('./batchHelpers');
const { todayLocal } = require('./dates');
const { buildSpecSnapshot, costShareFor } = require('./handover');

// One place where each stage's fields are written, so a batch's own stage page
// and the day sheets (which enter the same stages for several batches at once)
// can never drift apart.
//
// Only fields the form actually posted are written. A stage page posts all of
// its fields, so it behaves exactly as before; a day sheet that shows a subset
// (say only the lab results) leaves everything else untouched instead of
// blanking it.
function fieldsFrom(body, map) {
  const out = {};
  Object.entries(map).forEach(([column, [key, convert]]) => {
    if (Object.prototype.hasOwnProperty.call(body, key)) out[column] = convert(body[key]);
  });
  return out;
}

function saveIfAny(table, batchId, fields) {
  if (!Object.keys(fields).length) return;
  upsert(table, batchId, fields);
}

function savePrewetting(batchId, b) {
  saveIfAny('prewetting', batchId, fieldsFrom(b, {
    in_date: ['in_date', str],
    out_date: ['out_date', str],
    entered_by: ['entered_by', str],
    notes: ['notes', str],
  }));
}

function savePhase1(batchId, b) {
  saveIfAny('phase1', batchId, fieldsFrom(b, {
    start_date: ['start_date', str],
    end_date: ['end_date', str],
    bunker_no: ['bunker_no', str],
    num_turns_planned: ['num_turns_planned', num],
    end_cn_ratio: ['end_cn_ratio', num],
    end_nitrogen_pct: ['end_nitrogen_pct', num],
    end_ash_pct: ['end_ash_pct', num],
    notes: ['notes', str],
  }));
}

function savePhase2(batchId, b) {
  saveIfAny('phase2', batchId, fieldsFrom(b, {
    tunnel_id: ['tunnel_id', str],
    fill_date: ['fill_date', str],
    end_date: ['end_date', str],
    pasteurization_date: ['pasteurization_date', str],
    pasteurization_temp_c: ['pasteurization_temp_c', num],
    pasteurization_duration_hrs: ['pasteurization_duration_hrs', num],
    conditioning_date: ['conditioning_date', str],
    conditioning_temp_c: ['conditioning_temp_c', num],
    notes: ['notes', str],
  }));
}

// Spawning also carries the finished-compost checks: they are judged on the
// compost as it is spawned, but belong to the Phase II record the dispatch spec
// sheet is built from.
function saveSpawning(batchId, b) {
  const spawning = fieldsFrom(b, {
    spawning_date: ['spawning_date', str],
    spawn_run_end_date: ['spawn_run_end_date', str],
    spawn_strain: ['spawn_strain', str],
    spawn_rate_pct: ['spawn_rate_pct', num],
    spawning_method: ['spawning_method', str],
    compost_temp_c: ['compost_temp_c', num],
    room_id: ['room_id', str],
    num_bags: ['num_bags', num],
    kg_per_bag: ['kg_per_bag', num],
    entered_by: ['entered_by', str],
    notes: ['notes', str],
  });
  if ('num_bags' in spawning || 'kg_per_bag' in spawning) {
    const numBags = num(b.num_bags);
    const kgPerBag = num(b.kg_per_bag);
    spawning.fill_weight_kg = numBags !== null && kgPerBag !== null ? numBags * kgPerBag : null;
  }
  saveIfAny('spawning', batchId, spawning);
  saveIfAny('phase2', batchId, fieldsFrom(b, {
    final_cn_ratio: ['final_cn_ratio', num],
    final_nitrogen_pct: ['final_nitrogen_pct', num],
    final_ash_pct: ['final_ash_pct', num],
    final_moisture_pct: ['final_moisture_pct', num],
    ammonia_cleared: ['ammonia_cleared', str],
    compost_color: ['compost_color', str],
    compost_texture: ['compost_texture', str],
    compost_smell: ['compost_smell', str],
  }));
}

function saveCasing(batchId, b) {
  saveIfAny('casing', batchId, fieldsFrom(b, {
    prep_date: ['prep_date', str],
    pasteurized: ['pasteurized', str],
    ph: ['ph', num],
    moisture_pct: ['moisture_pct', num],
    application_date: ['application_date', str],
    end_date: ['end_date', str],
    layer_thickness_in: ['layer_thickness_in', num],
    room_id: ['room_id', str],
    entered_by: ['entered_by', str],
    notes: ['notes', str],
  }));
}

// Total mix weight is the sum of the lines, never typed.
function syncCasingQuantity(batchId) {
  const total = db
    .prepare('SELECT COALESCE(SUM(qty_kg), 0) AS kg, COUNT(*) AS n FROM casing_items WHERE batch_id = ?')
    .get(batchId);
  if (!total.n) return;
  upsert('casing', batchId, { quantity_kg: total.kg });
}

// Cost per kg defaults to the material's standard but is stored per line, so
// changing the master later never rewrites what a past batch paid.
function addCasingItem(batchId, b) {
  const qty = num(b.qty_kg);
  const material = b.raw_material_id ? db.prepare('SELECT * FROM raw_materials WHERE id = ?').get(b.raw_material_id) : null;
  const name = str(b.material_name) || (material ? material.name : null);
  if (!qty || !name) return false;
  db.prepare(
    `INSERT INTO casing_items (batch_id, raw_material_id, material_name, qty_kg, cost_per_kg_npr, notes)
     VALUES (@batch_id, @raw_material_id, @material_name, @qty_kg, @cost_per_kg_npr, @notes)`
  ).run({
    batch_id: batchId,
    raw_material_id: material ? material.id : null,
    material_name: name,
    qty_kg: qty,
    cost_per_kg_npr: num(b.cost_per_kg_npr) ?? (material ? material.default_cost_per_kg_npr : null),
    notes: str(b.notes),
  });
  syncCasingQuantity(batchId);
  return true;
}

function addRoom(batchId, b) {
  if (!str(b.room_no)) return false;
  db.prepare(
    `INSERT INTO rooms (batch_id, room_no, room_in_date, entered_by, notes)
     VALUES (@batch_id, @room_no, @room_in_date, @entered_by, @notes)`
  ).run({
    batch_id: batchId,
    room_no: str(b.room_no),
    room_in_date: str(b.room_in_date) || todayLocal(),
    entered_by: str(b.entered_by),
    notes: str(b.notes),
  });
  return true;
}

function saveRoomOut(batchId, roomId, b) {
  db.prepare(
    "UPDATE rooms SET room_out_date = ?, total_fill_weight_kg = ?, updated_at = datetime('now') WHERE id = ? AND batch_id = ?"
  ).run(str(b.room_out_date) || todayLocal(), num(b.compost_fill_weight_kg), roomId, batchId);
}

// A delivery freezes this batch's compost spec and carries its share of the
// batch's raw material cost, by weight.
function recordDispatch(batchId, b) {
  const qty = num(b.qty_kg);
  if (!qty) return false;
  const external = b.destination_type === 'external';
  db.prepare(
    `INSERT INTO compost_dispatches
       (compost_batch_id, dispatch_date, qty_kg, destination_type, buyer_name, spec_snapshot, cost_share_npr, entered_by, notes)
     VALUES (@compost_batch_id, @dispatch_date, @qty_kg, @destination_type, @buyer_name, @spec_snapshot, @cost_share_npr, @entered_by, @notes)`
  ).run({
    compost_batch_id: batchId,
    dispatch_date: str(b.dispatch_date) || todayLocal(),
    qty_kg: qty,
    destination_type: external ? 'external' : 'internal',
    buyer_name: external ? str(b.buyer_name) : null,
    spec_snapshot: JSON.stringify(buildSpecSnapshot(batchId)),
    cost_share_npr: costShareFor(batchId, qty),
    entered_by: str(b.entered_by),
    notes: str(b.notes),
  });
  return true;
}

// Claims an unclaimed internal delivery for this growing batch. Guarded on
// growing_batch_id still being null so two batches can't claim the same one.
function recordReceipt(batchId, b) {
  const claimed = db
    .prepare(
      `UPDATE compost_dispatches
         SET growing_batch_id = ?, receipt_date = ?, received_qty_kg = ?
       WHERE id = ? AND destination_type = 'internal' AND growing_batch_id IS NULL`
    )
    .run(batchId, str(b.receipt_date) || todayLocal(), num(b.received_qty_kg), num(b.dispatch_id));
  return claimed.changes > 0;
}

module.exports = {
  savePrewetting,
  savePhase1,
  savePhase2,
  saveSpawning,
  saveCasing,
  syncCasingQuantity,
  addCasingItem,
  addRoom,
  saveRoomOut,
  recordDispatch,
  recordReceipt,
};
