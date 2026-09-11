const express = require('express');
const db = require('../db');
const { daysBetween } = require('../lib/dates');
const { getBatchHeader, num, str } = require('../lib/batchHelpers');
const { advanceStage, nextStagePath } = require('../lib/stages');
const { getBatchMetrics, getAllBatchMetrics } = require('../lib/analytics');
const { generateAnalysis } = require('../lib/analysis');
const { requirePermission } = require('../lib/auth');

const router = express.Router();

// ---- Room In ----
router.get('/batches/:id/rooms', (req, res) => {
  const batch = getBatchHeader(req.params.id, req.farmId);
  if (!batch) return res.status(404).render('404');
  const rooms = db.prepare('SELECT * FROM rooms WHERE batch_id = ? ORDER BY room_in_date, id').all(req.params.id);
  const growingRooms = db.prepare('SELECT * FROM growing_rooms WHERE active = 1 ORDER BY code').all();
  res.render('stages/room-in', { batch, rooms, growingRooms, currentPage: 'room_in', readOnly: !res.locals.can('edit_room_in') });
});

router.post('/batches/:id/rooms', requirePermission('edit_room_in'), (req, res) => {
  const id = req.params.id;
  const b = req.body;
  if (!str(b.room_no)) return res.redirect(`/batches/${id}/rooms`);

  db.prepare(
    `INSERT INTO rooms (batch_id, room_no, room_in_date, entered_by, notes)
     VALUES (@batch_id, @room_no, @room_in_date, @entered_by, @notes)`
  ).run({
    batch_id: id,
    room_no: str(b.room_no),
    room_in_date: str(b.room_in_date),
    entered_by: str(b.entered_by),
    notes: str(b.notes),
  });
  res.redirect(`/batches/${id}/rooms`);
});

router.post('/batches/:id/rooms/:roomId', requirePermission('edit_room_in'), (req, res) => {
  const { id, roomId } = req.params;
  const b = req.body;
  db.prepare(
    `UPDATE rooms SET room_no = ?, room_in_date = ?, entered_by = ?, notes = ?, updated_at = datetime('now')
     WHERE id = ? AND batch_id = ?`
  ).run(str(b.room_no), str(b.room_in_date), str(b.entered_by), str(b.notes), roomId, id);
  res.redirect(`/batches/${id}/rooms`);
});

router.post('/batches/:id/rooms/:roomId/delete', requirePermission('edit_room_in'), (req, res) => {
  db.prepare('DELETE FROM rooms WHERE id = ? AND batch_id = ?').run(req.params.roomId, req.params.id);
  res.redirect(`/batches/${req.params.id}/rooms`);
});

router.post('/batches/:id/rooms-advance', requirePermission('edit_room_in'), (req, res) => {
  const id = req.params.id;
  advanceStage(id, 'room_in');
  res.redirect(nextStagePath('room_in', id));
});

// ---- Harvest ----
router.get('/batches/:id/harvest', (req, res) => {
  const batch = getBatchHeader(req.params.id, req.farmId);
  if (!batch) return res.status(404).render('404');
  const rooms = db.prepare('SELECT * FROM rooms WHERE batch_id = ? ORDER BY room_in_date, id').all(req.params.id);
  const harvests = db.prepare('SELECT * FROM room_harvests WHERE batch_id = ? ORDER BY harvest_date, id').all(req.params.id);

  const roomsWithHarvests = rooms.map((room) => {
    const roomHarvests = harvests.filter((h) => h.room_id === room.id);
    const gradeA = roomHarvests.reduce((s, h) => s + (h.grade_a_kg || 0), 0);
    const gradeB = roomHarvests.reduce((s, h) => s + (h.grade_b_kg || 0), 0);
    return { ...room, harvests: roomHarvests, gradeA, gradeB };
  });

  res.render('stages/harvest', { batch, rooms: roomsWithHarvests, currentPage: 'harvest', readOnly: !res.locals.can('edit_harvest') });
});

router.post('/batches/:id/rooms/:roomId/harvests', requirePermission('edit_harvest'), (req, res) => {
  const { id, roomId } = req.params;
  const b = req.body;
  if (!str(b.harvest_date)) return res.redirect(`/batches/${id}/harvest`);
  db.prepare(
    `INSERT INTO room_harvests (room_id, batch_id, harvest_date, grade_a_kg, grade_b_kg, entered_by, notes)
     VALUES (@room_id, @batch_id, @harvest_date, @grade_a_kg, @grade_b_kg, @entered_by, @notes)`
  ).run({
    room_id: roomId,
    batch_id: id,
    harvest_date: str(b.harvest_date),
    grade_a_kg: num(b.grade_a_kg),
    grade_b_kg: num(b.grade_b_kg),
    entered_by: str(b.entered_by),
    notes: str(b.notes),
  });
  res.redirect(`/batches/${id}/harvest`);
});

router.post('/batches/:id/harvests/:harvestId/delete', requirePermission('edit_harvest'), (req, res) => {
  db.prepare('DELETE FROM room_harvests WHERE id = ? AND batch_id = ?').run(req.params.harvestId, req.params.id);
  res.redirect(`/batches/${req.params.id}/harvest`);
});

router.post('/batches/:id/harvest-advance', requirePermission('edit_harvest'), (req, res) => {
  const id = req.params.id;
  advanceStage(id, 'harvest');
  res.redirect(nextStagePath('harvest', id));
});

// ---- Room Out ----
router.get('/batches/:id/room-out', (req, res) => {
  const batch = getBatchHeader(req.params.id, req.farmId);
  if (!batch) return res.status(404).render('404');
  const rooms = db.prepare('SELECT * FROM rooms WHERE batch_id = ? ORDER BY room_in_date, id').all(req.params.id);
  const harvests = db.prepare('SELECT * FROM room_harvests WHERE batch_id = ? ORDER BY harvest_date, id').all(req.params.id);
  const spawning = db.prepare('SELECT fill_weight_kg FROM spawning WHERE batch_id = ?').get(req.params.id) || {};
  const batchMetrics = getBatchMetrics(req.params.id);

  // Allocate the batch's total recipe cost across rooms proportionally to
  // each room's share of total fill weight, falling back to the full batch
  // cost when there's only one room (or weights aren't set on any room yet).
  const totalRoomWeight = rooms.reduce((s, r) => s + (r.total_fill_weight_kg || 0), 0);

  const roomsWithSummary = rooms.map((room) => {
    const roomHarvests = harvests.filter((h) => h.room_id === room.id);
    const gradeA = roomHarvests.reduce((s, h) => s + (h.grade_a_kg || 0), 0);
    const gradeB = roomHarvests.reduce((s, h) => s + (h.grade_b_kg || 0), 0);
    const compostKg = room.total_fill_weight_kg || (rooms.length === 1 ? spawning.fill_weight_kg : null) || null;
    const yieldPct = compostKg ? ((gradeA + gradeB) / compostKg) * 100 : null;
    const aGradeYieldPct = compostKg ? (gradeA / compostKg) * 100 : null;
    const allocatedCost =
      batchMetrics.totalCost !== null
        ? rooms.length === 1
          ? batchMetrics.totalCost
          : totalRoomWeight > 0 && room.total_fill_weight_kg
          ? batchMetrics.totalCost * (room.total_fill_weight_kg / totalRoomWeight)
          : null
        : null;
    const aGradeEfficiency = allocatedCost ? (gradeA / allocatedCost) * 1000 : null;
    return {
      ...room,
      harvests: roomHarvests,
      gradeA,
      gradeB,
      compostKg,
      yieldPct,
      aGradeYieldPct,
      allocatedCost,
      aGradeEfficiency,
      days: daysBetween(room.room_in_date, room.room_out_date),
    };
  });

  res.render('stages/room-out', {
    batch,
    rooms: roomsWithSummary,
    suggestedCompostKg: spawning.fill_weight_kg || null,
    currentPage: 'room_out',
    readOnly: !res.locals.can('edit_room_out'),
  });
});

router.post('/batches/:id/rooms/:roomId/roomout', requirePermission('edit_room_out'), (req, res) => {
  const { id, roomId } = req.params;
  db.prepare(
    "UPDATE rooms SET room_out_date = ?, total_fill_weight_kg = ?, updated_at = datetime('now') WHERE id = ? AND batch_id = ?"
  ).run(str(req.body.room_out_date), num(req.body.compost_fill_weight_kg), roomId, id);
  res.redirect(`/batches/${id}/room-out`);
});

// AI/rule-based performance analysis for one room, generated on demand
// (avoids an API call on every page load).
router.get('/batches/:id/rooms/:roomId/analysis', async (req, res) => {
  const { id, roomId } = req.params;
  const room = db.prepare('SELECT * FROM rooms WHERE id = ? AND batch_id = ?').get(roomId, id);
  if (!room) return res.status(404).json({ error: 'Room not found' });

  const harvests = db.prepare('SELECT * FROM room_harvests WHERE room_id = ?').all(roomId);
  const gradeA = harvests.reduce((s, h) => s + (h.grade_a_kg || 0), 0);
  const gradeB = harvests.reduce((s, h) => s + (h.grade_b_kg || 0), 0);
  const compostKg = room.total_fill_weight_kg || null;
  const roomContext = {
    room_no: room.room_no,
    yieldPct: compostKg ? ((gradeA + gradeB) / compostKg) * 100 : null,
    aGradeYieldPct: compostKg ? (gradeA / compostKg) * 100 : null,
  };

  const metrics = getBatchMetrics(id);
  const allMetrics = getAllBatchMetrics(req.farmId);
  try {
    const analysis = await generateAnalysis(metrics, allMetrics, roomContext);
    res.json(analysis);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.post('/batches/:id/room-out-complete', requirePermission('edit_room_out'), (req, res) => {
  const id = req.params.id;
  advanceStage(id, 'room_out');
  res.redirect(`/batches/${id}`);
});

module.exports = router;
