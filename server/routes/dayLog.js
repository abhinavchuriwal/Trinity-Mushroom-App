const express = require('express');
const db = require('../db');
const { todayLocal } = require('../lib/dates');
const { advanceStage } = require('../lib/stages');
const { unclaimedDispatches } = require('../lib/handover');
const {
  savePrewetting,
  savePhase1,
  savePhase2,
  saveSpawning,
  saveCasing,
  addCasingItem,
  addRoom,
  saveRoomOut,
  recordDispatch,
  recordReceipt,
} = require('../lib/stageSaves');

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

// The whole yard on one screen, laid out like the paper Daily Bunker & Tunnel
// Log (Form C-2): every bunker and every tunnel, each with the batch that is in
// it. The batch is always picked from a list of batches actually at that stage
// in this workspace — never typed — so a reading can't land on the wrong batch.
function batchesAtStage(farmId, stage) {
  return db
    .prepare(
      `SELECT id, batch_code FROM batches
       WHERE farm_id = ? AND status = 'in_progress' AND current_stage = ?
       ORDER BY batch_code`
    )
    .all(farmId, stage);
}

router.get('/readings', (req, res) => {
  const can = res.locals.can;
  if (!can('edit_phase1') && !can('edit_phase2')) {
    return res.status(403).render('403', { permission: 'edit_phase1 or edit_phase2' });
  }
  const today = todayLocal();
  const date = /^\d{4}-\d{2}-\d{2}$/.test(req.query.date || '') ? req.query.date : today;

  const phase1Batches = batchesAtStage(req.farmId, 'phase1');
  const phase2Batches = batchesAtStage(req.farmId, 'phase2');

  // Which batch is sitting in each bunker / tunnel, so the row comes
  // pre-selected and the supervisor only types the measurements.
  const occupant = (batches, table, column, code) => {
    const match = batches.find((b) => {
      const row = db.prepare(`SELECT ${column} AS loc FROM ${table} WHERE batch_id = ?`).get(b.id);
      return row && row.loc === code;
    });
    return match ? match.id : null;
  };

  const bunkers = can('edit_phase1')
    ? db
        .prepare('SELECT code, name FROM bunkers WHERE active = 1 ORDER BY code')
        .all()
        .map((b) => {
          const batchId = occupant(phase1Batches, 'phase1', 'bunker_no', b.code);
          const logged = db
            .prepare(
              `SELECT phase1_readings.*, batches.batch_code FROM phase1_readings
               JOIN batches ON batches.id = phase1_readings.batch_id
               WHERE phase1_readings.reading_date = ? AND phase1_readings.bunker_no = ? AND batches.farm_id = ?
               ORDER BY phase1_readings.id`
            )
            .all(date, b.code, req.farmId);
          const nextTurn = batchId
            ? (db.prepare('SELECT COALESCE(MAX(turn_number), 0) AS t FROM phase1_readings WHERE batch_id = ?').get(batchId).t || 0) + 1
            : 1;
          return { ...b, batchId, logged, nextTurn };
        })
    : [];

  const tunnels = can('edit_phase2')
    ? db
        .prepare('SELECT code, name FROM tunnels WHERE active = 1 ORDER BY code')
        .all()
        .map((t) => {
          const batchId = occupant(phase2Batches, 'phase2', 'tunnel_id', t.code);
          const logged = batchId
            ? db
                .prepare(
                  `SELECT phase2_readings.*, batches.batch_code FROM phase2_readings
                   JOIN batches ON batches.id = phase2_readings.batch_id
                   WHERE phase2_readings.reading_date = ? AND phase2_readings.batch_id = ?
                   ORDER BY phase2_readings.id`
                )
                .all(date, batchId)
            : [];
          return { ...t, batchId, logged };
        })
    : [];

  res.render('day-readings', {
    date,
    today,
    bunkers,
    tunnels,
    phase1Batches,
    phase2Batches,
    saved: num(req.query.saved) || 0,
  });
});

router.post('/readings', (req, res) => {
  const can = res.locals.can;
  const b = req.body;
  const date = /^\d{4}-\d{2}-\d{2}$/.test(b.reading_date || '') ? b.reading_date : todayLocal();
  const enteredBy = str(b.entered_by);

  // Every row names its kind and its location; a row only saves when a batch is
  // chosen and something was actually measured, so untouched rows stay empty.
  const kinds = asArray(b.kind);
  const locations = asArray(b.location);
  const batchIds = asArray(b.batch_id);
  const turns = asArray(b.turn_number);
  const temps = asArray(b.temp_c);
  const ambients = asArray(b.ambient_temp_c);
  const moistures = asArray(b.moisture_pct);
  const ammoniaLevels = asArray(b.ammonia_level);
  const ammoniaPpms = asArray(b.ammonia_ppm);
  const phs = asArray(b.ph);
  const notes = asArray(b.notes);

  const allowed = {
    bunker: new Set(batchesAtStage(req.farmId, 'phase1').map((x) => x.id)),
    tunnel: new Set(batchesAtStage(req.farmId, 'phase2').map((x) => x.id)),
  };

  const insertPhase1 = db.prepare(
    `INSERT INTO phase1_readings
      (batch_id, turn_number, reading_date, bunker_no, pile_temp_c, ambient_temp_c, moisture_pct, ammonia_level, ph, entered_by, notes)
     VALUES (@batch_id, @turn_number, @reading_date, @bunker_no, @pile_temp_c, @ambient_temp_c, @moisture_pct, @ammonia_level, @ph, @entered_by, @notes)`
  );
  const insertPhase2 = db.prepare(
    `INSERT INTO phase2_readings (batch_id, reading_date, temp_c, ammonia_ppm, entered_by, notes)
     VALUES (@batch_id, @reading_date, @temp_c, @ammonia_ppm, @entered_by, @notes)`
  );

  let saved = 0;
  const save = db.transaction(() => {
    kinds.forEach((kind, i) => {
      const batchId = num(batchIds[i]);
      if (!batchId || !allowed[kind] || !allowed[kind].has(batchId)) return;
      if (kind === 'bunker' && !can('edit_phase1')) return;
      if (kind === 'tunnel' && !can('edit_phase2')) return;

      if (kind === 'bunker') {
        const values = {
          pile_temp_c: num(temps[i]),
          ambient_temp_c: num(ambients[i]),
          moisture_pct: num(moistures[i]),
          ammonia_level: str(ammoniaLevels[i]),
          ph: num(phs[i]),
        };
        const touched = Object.values(values).some((v) => v !== null) || str(notes[i]);
        if (!touched) return;
        insertPhase1.run({
          batch_id: batchId,
          turn_number: num(turns[i]),
          reading_date: date,
          bunker_no: str(locations[i]),
          ...values,
          entered_by: enteredBy,
          notes: str(notes[i]),
        });
        saved += 1;
      } else {
        const temp = num(temps[i]);
        const ppm = num(ammoniaPpms[i]);
        if (temp === null && ppm === null && !str(notes[i])) return;
        insertPhase2.run({
          batch_id: batchId,
          reading_date: date,
          temp_c: temp,
          ammonia_ppm: ppm,
          entered_by: enteredBy,
          notes: str(notes[i]),
        });
        saved += 1;
      }
    });
  });
  save();

  res.redirect(`/day/readings?date=${encodeURIComponent(date)}&saved=${saved}`);
});

// ---- The two batch day sheets: Form C-1 and Form G-1 as screens ----
//
// Each section names its own batch, picked from the batches actually at that
// step in this workspace, and saves on its own. Nothing is typed by hand, and
// the save goes through the same code as that batch's own stage page.
function sectionBatches(farmId, stage) {
  return batchesAtStage(farmId, stage);
}

function batchAt(farmId, stage, batchId) {
  if (!batchId) return null;
  return db
    .prepare("SELECT * FROM batches WHERE id = ? AND farm_id = ? AND status = 'in_progress' AND current_stage = ?")
    .get(batchId, farmId, stage);
}

function occupiedRooms(farmId) {
  return db
    .prepare(
      `SELECT rooms.id, rooms.room_no, rooms.room_in_date, rooms.total_fill_weight_kg,
              batches.id AS batch_id, batches.batch_code
       FROM rooms
       JOIN batches ON batches.id = rooms.batch_id
       WHERE rooms.room_in_date IS NOT NULL AND rooms.room_out_date IS NULL AND batches.farm_id = ?
       ORDER BY rooms.room_no`
    )
    .all(farmId);
}

router.get('/compost', (req, res) => {
  const can = res.locals.can;
  const stages = ['prewetting', 'phase1', 'phase2', 'spawning', 'dispatch'];
  const mine = stages.filter((s) => can(`edit_${s}`));
  if (!mine.length) return res.status(403).render('403', { permission: 'a compost stage' });

  res.render('day-compost', {
    today: todayLocal(),
    mine,
    batches: Object.fromEntries(stages.map((s) => [s, sectionBatches(req.farmId, s)])),
    bunkers: db.prepare('SELECT * FROM bunkers WHERE active = 1 ORDER BY code').all(),
    tunnels: db.prepare('SELECT * FROM tunnels WHERE active = 1 ORDER BY code').all(),
    growingRooms: db.prepare('SELECT * FROM growing_rooms WHERE active = 1 ORDER BY code').all(),
    canCreate: can('edit_prewetting'),
    saved: req.query.saved || null,
  });
});

router.get('/growing', (req, res) => {
  const can = res.locals.can;
  const stages = ['receipt', 'room_in', 'casing', 'room_out'];
  const mine = stages.filter((s) => can(`edit_${s}`));
  if (!mine.length) return res.status(403).render('403', { permission: 'a growing stage' });

  const casingBatches = sectionBatches(req.farmId, 'casing');
  res.render('day-growing', {
    today: todayLocal(),
    mine,
    batches: Object.fromEntries(stages.map((s) => [s, sectionBatches(req.farmId, s)])),
    rooms: occupiedRooms(req.farmId),
    growingRooms: db.prepare('SELECT * FROM growing_rooms WHERE active = 1 ORDER BY code').all(),
    casingMaterials: db
      .prepare("SELECT * FROM raw_materials WHERE active = 1 AND category IN ('casing', 'both') ORDER BY name")
      .all(),
    casingItems: Object.fromEntries(
      casingBatches.map((b) => [b.id, db.prepare('SELECT * FROM casing_items WHERE batch_id = ? ORDER BY id').all(b.id)])
    ),
    unclaimed: can('edit_receipt') ? unclaimedDispatches() : [],
    canCreate: can('edit_receipt'),
    saved: req.query.saved || null,
  });
});

// One handler for every section of both sheets: check the permission, check the
// batch really is at that step in this workspace, save, optionally move it on.
const SECTIONS = {
  prewetting: { permission: 'edit_prewetting', stage: 'prewetting', save: savePrewetting, sheet: 'compost' },
  phase1: { permission: 'edit_phase1', stage: 'phase1', save: savePhase1, sheet: 'compost' },
  phase2: { permission: 'edit_phase2', stage: 'phase2', save: savePhase2, sheet: 'compost' },
  spawning: { permission: 'edit_spawning', stage: 'spawning', save: saveSpawning, sheet: 'compost' },
  dispatch: { permission: 'edit_dispatch', stage: 'dispatch', save: recordDispatch, sheet: 'compost' },
  receipt: { permission: 'edit_receipt', stage: 'receipt', save: recordReceipt, sheet: 'growing' },
  room_in: { permission: 'edit_room_in', stage: 'room_in', save: addRoom, sheet: 'growing' },
  casing: { permission: 'edit_casing', stage: 'casing', save: saveCasing, sheet: 'growing' },
  casing_item: { permission: 'edit_casing', stage: 'casing', save: addCasingItem, sheet: 'growing' },
};

// Room Out is per room, not per batch: the room carries its own batch.
router.post('/section/room_out', (req, res) => {
  if (!res.locals.can('edit_room_out')) return res.status(403).render('403', { permission: 'edit_room_out' });
  const room = occupiedRooms(req.farmId).find((r) => String(r.id) === String(req.body.room_id));
  if (!room) return res.redirect(`/day/growing?saved=${encodeURIComponent('Pick a room first.')}`);
  saveRoomOut(room.batch_id, room.id, req.body);
  if (req.body.advance) advanceStage(room.batch_id, 'room_out');
  res.redirect(`/day/growing?saved=${encodeURIComponent(room.room_no + ' closed out')}`);
});

router.post('/section/:name', (req, res) => {
  const section = SECTIONS[req.params.name];
  if (!section) return res.status(404).render('404');
  if (!res.locals.can(section.permission)) return res.status(403).render('403', { permission: section.permission });

  const batch = batchAt(req.farmId, section.stage, Number(req.body.batch_id));
  const back = `/day/${section.sheet}`;
  if (!batch) return res.redirect(`${back}?saved=${encodeURIComponent('Pick a batch first.')}`);

  section.save(batch.id, req.body);
  if (req.body.advance) advanceStage(batch.id, section.stage);
  res.redirect(`${back}?saved=${encodeURIComponent(batch.batch_code + ' saved')}`);
});

module.exports = router;
