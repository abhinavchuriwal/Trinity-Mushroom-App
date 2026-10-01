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

  // Today is the four day sheets, in the same shape as the paper ones. A
  // supervisor only sees their own department's sheets: C-1 and C-2 for the
  // compost side, G-1 and G-2 for growing. Admin and Farm Manager hold every
  // stage permission, so they see all four.
  const COMPOST_STAGES = ['prewetting', 'phase1', 'phase2', 'spawning', 'dispatch'];
  const GROWING_STAGES = ['receipt', 'room_in', 'casing', 'room_out'];
  const canAny = (stages) => stages.some((key) => can(ALL_STAGES[key].permission));

  const countAt = (stage) =>
    db
      .prepare("SELECT COUNT(*) AS n FROM batches WHERE farm_id = ? AND status = 'in_progress' AND current_stage = ?")
      .get(req.farmId, stage).n;

  const waitingFor = (stages) =>
    stages
      .filter((key) => can(ALL_STAGES[key].permission))
      .map((key) => ({ label: ALL_STAGES[key].label, count: countAt(key) }))
      .filter((x) => x.count);

  const forms = [];

  if (canAny(COMPOST_STAGES)) {
    forms.push({
      code: 'C-1',
      name: 'Compost Day Sheet',
      blurb: 'New batch, pre-wetting, Phase I, Phase II, spawning and dispatch — the once-per-batch steps.',
      href: '/day/compost',
      dept: 'compost',
      waiting: waitingFor(COMPOST_STAGES),
    });
  }

  if (can('edit_phase1') || can('edit_phase2')) {
    const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;
    const places = [];
    if (can('edit_phase1')) places.push(plural(db.prepare('SELECT COUNT(*) AS n FROM bunkers WHERE active = 1').get().n, 'bunker'));
    if (can('edit_phase2')) places.push(plural(db.prepare('SELECT COUNT(*) AS n FROM tunnels WHERE active = 1').get().n, 'tunnel'));
    const loggedToday =
      db
        .prepare(
          `SELECT COUNT(*) AS n FROM phase1_readings
           JOIN batches ON batches.id = phase1_readings.batch_id
           WHERE reading_date = ? AND batches.farm_id = ?`
        )
        .get(today, req.farmId).n +
      db
        .prepare(
          `SELECT COUNT(*) AS n FROM phase2_readings
           JOIN batches ON batches.id = phase2_readings.batch_id
           WHERE reading_date = ? AND batches.farm_id = ?`
        )
        .get(today, req.farmId).n;
    forms.push({
      code: 'C-2',
      name: 'Daily Bunker & Tunnel Log',
      blurb: 'Today’s readings: compost temperature, moisture, pH and ammonia, bunker by bunker and tunnel by tunnel.',
      href: '/day/readings',
      dept: 'compost',
      note: places.join(' · '),
      done: loggedToday ? `${loggedToday} logged today` : null,
    });
  }

  if (canAny(GROWING_STAGES)) {
    const deliveries = can('edit_receipt') && res.locals.currentFarm.unit_type === 'growing' ? unclaimedDispatches().length : 0;
    forms.push({
      code: 'G-1',
      name: 'Growing Day Sheet',
      blurb: 'New batch and compost receipt, room in, casing preparation and application, room out.',
      href: '/day/growing',
      dept: 'growing',
      waiting: waitingFor(GROWING_STAGES),
      note: deliveries ? `${deliveries} compost deliver${deliveries === 1 ? 'y' : 'ies'} waiting to be received` : null,
    });
  }

  if (can('edit_harvest')) {
    const rooms = db
      .prepare(
        `SELECT COUNT(*) AS n FROM rooms
         JOIN batches ON batches.id = rooms.batch_id
         WHERE rooms.room_in_date IS NOT NULL AND rooms.room_out_date IS NULL AND batches.farm_id = ?`
      )
      .get(req.farmId).n;
    const picked = db
      .prepare(
        `SELECT COALESCE(SUM(grade_a_kg), 0) + COALESCE(SUM(grade_b_kg), 0) AS kg FROM room_harvests
         JOIN batches ON batches.id = room_harvests.batch_id
         WHERE harvest_date = ? AND batches.farm_id = ?`
      )
      .get(today, req.farmId).kg;
    forms.push({
      code: 'G-2',
      name: 'Daily Harvest',
      blurb: 'Today’s picks, room by room: flush, A grade and B grade.',
      href: '/harvest-log',
      dept: 'growing',
      note: rooms ? `${rooms} room${rooms === 1 ? '' : 's'} in crop` : 'No room is in crop',
      done: picked ? `${picked.toFixed(1)} kg picked today` : null,
    });
  }

  res.render('today', { forms, tasks, harvest, arriving, today, canEditAnything: forms.length > 0 });
});

module.exports = router;
