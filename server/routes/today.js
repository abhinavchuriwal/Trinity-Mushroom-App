const express = require('express');
const db = require('../db');
const { ALL_STAGES, stagesFor } = require('../lib/stages');
const { daysBetween, todayLocal } = require('../lib/dates');
const { unclaimedDispatches } = require('../lib/handover');

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

  // Compost the compost unit has sent that no growing batch has received yet.
  // A growing batch only exists once someone starts one for that delivery, so
  // without this the growing team's Today would sit empty while compost waits.
  let arriving = null;
  if (res.locals.currentFarm.unit_type === 'growing' && can('edit_receipt')) {
    const deliveries = unclaimedDispatches();
    if (deliveries.length) {
      const waitingBatch = tasks.some((t) => t.stage.key === 'receipt');
      arriving = { deliveries, waitingBatch };
    }
  }

  // Today is laid out as the paper day sheet is: one numbered section per step,
  // in the same order, so a supervisor can type straight down the filled sheet.
  // Sections the person's role can't save are left out entirely. Harvest is
  // unnumbered because it has its own sheet (Form G-2), which keeps the numbers
  // on screen matching the numbers on paper.
  const unitType = res.locals.currentFarm.unit_type || 'full';
  const SHEET = { compost: 'C-1', growing: 'G-1' };
  const sheet = SHEET[unitType] || null;
  const pipeline = stagesFor(unitType);
  const byStage = {};
  tasks.forEach((t) => {
    (byStage[t.stage.key] = byStage[t.stage.key] || []).push(t);
  });

  const sections = [];
  let num = 0;
  const firstStage = pipeline[0];
  if (can(firstStage.permission)) {
    sections.push({
      num: ++num,
      key: 'new_batch',
      label: unitType === 'growing' ? 'Start a Growing Batch' : 'New Batch',
      newBatch: true,
      sheet,
      cards: [],
    });
  }
  pipeline.forEach((stage) => {
    if (!can(stage.permission)) return;
    const cards = byStage[stage.key] || [];
    if (stage.key === 'harvest') {
      sections.push({ key: 'harvest', label: 'Harvest', harvest: true, sheet: 'G-2', cards });
    } else {
      sections.push({ num: ++num, key: stage.key, label: stage.label, sheet, cards });
    }
  });

  const canEditAnything = sections.length > 0;

  res.render('today', { sections, harvest, arriving, today, canEditAnything });
});

module.exports = router;
