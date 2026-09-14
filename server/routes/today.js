const express = require('express');
const db = require('../db');
const { ALL_STAGES, stageKeysFor } = require('../lib/stages');
const { daysBetween, todayLocal } = require('../lib/dates');

const router = express.Router();

// The supervisor's home screen, and what the installed phone app opens to.
// Shows only the work this person can actually do right now in the current
// workspace: batches sitting at a stage their role may save, each with one
// button straight to the entry form — no hunting through the dashboard and
// stage tabs on a small screen.
router.get('/', (req, res) => {
  const can = res.locals.can;
  const today = todayLocal();

  const inProgress = db
    .prepare("SELECT * FROM batches WHERE farm_id = ? AND status = 'in_progress' ORDER BY start_date, id")
    .all(req.farmId);

  const tasks = [];
  inProgress.forEach((b) => {
    const meta = ALL_STAGES[b.current_stage];
    if (!meta || !can(meta.permission)) return;
    const task = {
      batch: b,
      stage: meta,
      stageIndex: stageKeysFor(b.batch_type).indexOf(b.current_stage),
      href: meta.path(b.id),
    };

    if (b.current_stage === 'phase1') {
      const p1 = db.prepare('SELECT start_date, bunker_no FROM phase1 WHERE batch_id = ?').get(b.id) || {};
      const last = db
        .prepare('SELECT * FROM phase1_readings WHERE batch_id = ? ORDER BY reading_date DESC, id DESC LIMIT 1')
        .get(b.id);
      const counts = db
        .prepare(
          `SELECT COUNT(*) AS total, SUM(CASE WHEN reading_date = ? THEN 1 ELSE 0 END) AS today
           FROM phase1_readings WHERE batch_id = ?`
        )
        .get(today, b.id);
      Object.assign(task, {
        kind: 'phase1',
        location: p1.bunker_no ? `Bunker ${p1.bunker_no}` : null,
        day: p1.start_date ? daysBetween(p1.start_date, today) + 1 : null,
        last,
        readingCount: counts.total,
        loggedToday: counts.today > 0,
        entryHref: `${meta.path(b.id)}#add-reading`,
      });
    } else if (b.current_stage === 'phase2') {
      const p2 = db.prepare('SELECT fill_date, tunnel_id FROM phase2 WHERE batch_id = ?').get(b.id) || {};
      const last = db
        .prepare('SELECT * FROM phase2_readings WHERE batch_id = ? ORDER BY reading_date DESC, id DESC LIMIT 1')
        .get(b.id);
      const counts = db
        .prepare(
          `SELECT COUNT(*) AS total, SUM(CASE WHEN reading_date = ? THEN 1 ELSE 0 END) AS today
           FROM phase2_readings WHERE batch_id = ?`
        )
        .get(today, b.id);
      Object.assign(task, {
        kind: 'phase2',
        location: p2.tunnel_id ? `Tunnel ${p2.tunnel_id}` : null,
        day: p2.fill_date ? daysBetween(p2.fill_date, today) + 1 : null,
        last,
        readingCount: counts.total,
        loggedToday: counts.today > 0,
        entryHref: `${meta.path(b.id)}#add-reading`,
      });
    } else {
      task.kind = 'stage';
    }
    tasks.push(task);
  });

  // Compost work before growing work, then earliest stage first, so the list
  // reads in the same order the material moves through the farm.
  const deptOrder = { compost: 0, growing: 1 };
  tasks.sort(
    (a, b) =>
      deptOrder[a.stage.dept] - deptOrder[b.stage.dept] ||
      a.stageIndex - b.stageIndex ||
      a.batch.id - b.batch.id
  );

  // Harvest is logged per room, not per batch — pickers work several rooms at
  // once — so it's one card for every occupied room rather than one per batch.
  let harvest = null;
  if (can('edit_harvest')) {
    const rooms = db
      .prepare(
        `SELECT rooms.room_no FROM rooms
         JOIN batches ON batches.id = rooms.batch_id
         WHERE rooms.room_in_date IS NOT NULL AND rooms.room_out_date IS NULL AND batches.farm_id = ?
         ORDER BY rooms.room_no`
      )
      .all(req.farmId);
    if (rooms.length) {
      const picked = db
        .prepare(
          `SELECT COUNT(*) AS entries, COALESCE(SUM(grade_a_kg), 0) AS a, COALESCE(SUM(grade_b_kg), 0) AS b
           FROM room_harvests
           JOIN batches ON batches.id = room_harvests.batch_id
           WHERE room_harvests.harvest_date = ? AND batches.farm_id = ?`
        )
        .get(today, req.farmId);
      harvest = { rooms: rooms.map((r) => r.room_no), picked };
    }
  }

  const canEditAnything = Object.values(ALL_STAGES).some((s) => can(s.permission));

  res.render('today', { tasks, harvest, today, canEditAnything });
});

module.exports = router;
