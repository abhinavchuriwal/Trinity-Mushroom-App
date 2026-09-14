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

// Fast cross-batch harvest entry: on any given day, pickers may be harvesting
// several rooms at once, each potentially belonging to a different batch. This
// page skips navigating into each batch's own Harvest page — just pick the
// room (from every room currently occupied, across all in-progress batches)
// and log A/B grade kg.
router.get('/', (req, res) => {
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

  const today = todayLocal();
  const todayEntries = db
    .prepare(
      `SELECT room_harvests.*, rooms.room_no, batches.batch_code
       FROM room_harvests
       JOIN rooms ON rooms.id = room_harvests.room_id
       JOIN batches ON batches.id = room_harvests.batch_id
       WHERE room_harvests.harvest_date = ? AND batches.farm_id = ?
       ORDER BY room_harvests.id DESC`
    )
    .all(today, req.farmId);

  // Echo back the pick just saved, so someone logging on a phone gets a clear
  // confirmation of what went in without scrolling down to today's list.
  const saved = req.query.saved
    ? db
        .prepare(
          `SELECT room_harvests.*, rooms.room_no FROM room_harvests
           JOIN rooms ON rooms.id = room_harvests.room_id
           JOIN batches ON batches.id = room_harvests.batch_id
           WHERE room_harvests.id = ? AND batches.farm_id = ?`
        )
        .get(req.query.saved, req.farmId) || null
    : null;

  res.render('harvest-log', { activeRooms, todayEntries, today, saved, error: req.query.error || null });
});

router.post('/', requirePermission('edit_harvest'), (req, res) => {
  const b = req.body;
  const room = db
    .prepare(
      `SELECT rooms.* FROM rooms
       JOIN batches ON batches.id = rooms.batch_id
       WHERE rooms.id = ? AND rooms.room_out_date IS NULL AND batches.farm_id = ?`
    )
    .get(b.room_id, req.farmId);
  if (!room) {
    return res.redirect(`/harvest-log?error=${encodeURIComponent('Pick a room that is currently occupied.')}`);
  }
  const info = db.prepare(
    `INSERT INTO room_harvests (room_id, batch_id, harvest_date, grade_a_kg, grade_b_kg, flush_number, entered_by, notes)
     VALUES (@room_id, @batch_id, @harvest_date, @grade_a_kg, @grade_b_kg, @flush_number, @entered_by, @notes)`
  ).run({
    room_id: room.id,
    batch_id: room.batch_id,
    harvest_date: str(b.harvest_date) || todayLocal(),
    grade_a_kg: num(b.grade_a_kg),
    grade_b_kg: num(b.grade_b_kg),
    flush_number: num(b.flush_number),
    entered_by: str(b.entered_by),
    notes: str(b.notes),
  });
  res.redirect(`/harvest-log?saved=${info.lastInsertRowid}`);
});

router.post('/:harvestId/delete', requirePermission('edit_harvest'), (req, res) => {
  db.prepare(
    `DELETE FROM room_harvests
     WHERE id = ? AND batch_id IN (SELECT id FROM batches WHERE farm_id = ?)`
  ).run(req.params.harvestId, req.farmId);
  res.redirect('/harvest-log');
});

module.exports = router;
