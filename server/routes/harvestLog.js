const express = require('express');
const db = require('../db');
const { requirePermission } = require('../lib/auth');
const { todayLocal } = require('../lib/dates');

const router = express.Router();

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

// The Daily Harvest Sheet (Form G-2) on screen: every room currently in crop,
// one line each, filled in and saved in one go. The room list comes from the
// rooms that are actually occupied and each line's batch is fixed by its room,
// so a pick can never be logged against the wrong room or batch.
router.get('/', (req, res) => {
  const today = todayLocal();
  const date = /^\d{4}-\d{2}-\d{2}$/.test(req.query.date || '') ? req.query.date : today;

  const activeRooms = db
    .prepare(
      `SELECT rooms.id, rooms.room_no, rooms.room_in_date, batches.batch_code, batches.id AS batch_id
       FROM rooms
       JOIN batches ON batches.id = rooms.batch_id
       WHERE rooms.room_in_date IS NOT NULL AND rooms.room_out_date IS NULL
         AND batches.farm_id = ?
       ORDER BY rooms.room_no`
    )
    .all(req.farmId);

  const entries = db
    .prepare(
      `SELECT room_harvests.*, rooms.room_no, batches.batch_code
       FROM room_harvests
       JOIN rooms ON rooms.id = room_harvests.room_id
       JOIN batches ON batches.id = room_harvests.batch_id
       WHERE room_harvests.harvest_date = ? AND batches.farm_id = ?
       ORDER BY rooms.room_no, room_harvests.id`
    )
    .all(date, req.farmId);

  // What each room already has on this date, shown on its line so a second
  // visit to the page doesn't double-log a pick.
  const loggedByRoom = {};
  entries.forEach((e) => {
    (loggedByRoom[e.room_id] = loggedByRoom[e.room_id] || []).push(e);
  });

  const totals = entries.reduce(
    (acc, e) => ({ a: acc.a + (e.grade_a_kg || 0), b: acc.b + (e.grade_b_kg || 0) }),
    { a: 0, b: 0 }
  );

  res.render('harvest-log', {
    activeRooms,
    entries,
    loggedByRoom,
    totals,
    today,
    date,
    saved: num(req.query.saved) || 0,
    error: req.query.error || null,
  });
});

router.post('/', requirePermission('edit_harvest'), (req, res) => {
  const b = req.body;
  const date = /^\d{4}-\d{2}-\d{2}$/.test(b.harvest_date || '') ? b.harvest_date : todayLocal();
  const enteredBy = str(b.entered_by);
  const roomIds = asArray(b.room_id);
  const flushes = asArray(b.flush_number);
  const aKgs = asArray(b.grade_a_kg);
  const bKgs = asArray(b.grade_b_kg);
  const notes = asArray(b.notes);

  // Only rooms that are genuinely occupied in this workspace can take a pick,
  // and the batch comes from the room rather than from the form.
  const occupied = new Map(
    db
      .prepare(
        `SELECT rooms.id, rooms.batch_id FROM rooms
         JOIN batches ON batches.id = rooms.batch_id
         WHERE rooms.room_in_date IS NOT NULL AND rooms.room_out_date IS NULL AND batches.farm_id = ?`
      )
      .all(req.farmId)
      .map((r) => [String(r.id), r.batch_id])
  );

  const insert = db.prepare(
    `INSERT INTO room_harvests (room_id, batch_id, harvest_date, grade_a_kg, grade_b_kg, flush_number, entered_by, notes)
     VALUES (@room_id, @batch_id, @harvest_date, @grade_a_kg, @grade_b_kg, @flush_number, @entered_by, @notes)`
  );

  let saved = 0;
  db.transaction(() => {
    roomIds.forEach((roomId, i) => {
      const batchId = occupied.get(String(roomId));
      if (!batchId) return;
      const a = num(aKgs[i]);
      const bGrade = num(bKgs[i]);
      if (a === null && bGrade === null) return;
      insert.run({
        room_id: Number(roomId),
        batch_id: batchId,
        harvest_date: date,
        grade_a_kg: a,
        grade_b_kg: bGrade,
        flush_number: num(flushes[i]),
        entered_by: enteredBy,
        notes: str(notes[i]),
      });
      saved += 1;
    });
  })();

  res.redirect(`/harvest-log?date=${encodeURIComponent(date)}&saved=${saved}`);
});

router.post('/:harvestId/delete', requirePermission('edit_harvest'), (req, res) => {
  db.prepare(
    `DELETE FROM room_harvests
     WHERE id = ? AND batch_id IN (SELECT id FROM batches WHERE farm_id = ?)`
  ).run(req.params.harvestId, req.farmId);
  res.redirect(`/harvest-log?date=${encodeURIComponent(req.body.date || todayLocal())}`);
});

module.exports = router;
