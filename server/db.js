const path = require('path');
const os = require('os');
const fs = require('fs');
const Database = require('better-sqlite3');

// The database file must NOT live inside a cloud-synced folder (OneDrive, Dropbox,
// Google Drive, etc). Those services intercept file stat/lock calls in ways that
// corrupt or crash SQLite's WAL mode. The app code can live in a synced folder;
// the live .db file lives in the OS's local application-data directory instead.
const dataDir =
  process.env.TRINITY_DATA_DIR ||
  path.join(os.homedir(), 'Library', 'Application Support', 'TrinityAgroBatchTracker');
if (!fs.existsSync(dataDir)) fs.mkdirSync(dataDir, { recursive: true });

const db = new Database(path.join(dataDir, 'trinity-agro.db'));
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

db.exec(`
CREATE TABLE IF NOT EXISTS batches (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  batch_code TEXT UNIQUE NOT NULL,
  start_date TEXT NOT NULL,
  current_stage TEXT NOT NULL DEFAULT 'prewetting',
  status TEXT NOT NULL DEFAULT 'in_progress',
  notes TEXT,
  created_at TEXT DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS intake (
  batch_id INTEGER PRIMARY KEY REFERENCES batches(id) ON DELETE CASCADE,
  date TEXT,
  entered_by TEXT,
  notes TEXT,
  updated_at TEXT DEFAULT (datetime('now'))
);

-- Master list of raw materials with a default NPR cost/kg and dry-basis Carbon/
-- Nitrogen % used to compute batch C:N ratio. Calibrate these to local Nepal
-- sourcing; they are starting points only.
CREATE TABLE IF NOT EXISTS raw_materials (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT UNIQUE NOT NULL,
  default_cost_per_kg_npr REAL,
  carbon_pct REAL,
  nitrogen_pct REAL,
  moisture_pct REAL,
  notes TEXT,
  active INTEGER NOT NULL DEFAULT 1,
  created_at TEXT DEFAULT (datetime('now')),
  updated_at TEXT DEFAULT (datetime('now'))
);

-- Line items for a batch's raw material recipe. qty_kg is the WET, as-weighed
-- delivery weight — Carbon%/Nitrogen%/Moisture% are all dry-basis, so the C:N
-- calculation must convert to dry matter (qty_kg * (1 - moisture%/100)) before
-- weighting; using qty_kg directly overstates C and N whenever moisture varies
-- between ingredients (it did, for years, before moisture tracking existed).
-- Cost and the "standard" values are snapshotted at entry time (copied from
-- raw_materials when selected, but editable) so a later edit or deletion of the
-- master material never changes a past batch's recorded figures. The _actual
-- columns hold delivery-specific tested/weighed values when known; calculations
-- use actual when present, standard otherwise.
CREATE TABLE IF NOT EXISTS intake_items (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  batch_id INTEGER NOT NULL REFERENCES batches(id) ON DELETE CASCADE,
  raw_material_id INTEGER REFERENCES raw_materials(id) ON DELETE SET NULL,
  material_name TEXT NOT NULL,
  qty_kg REAL NOT NULL,
  cost_per_kg_npr REAL,
  carbon_pct_standard REAL,
  nitrogen_pct_standard REAL,
  carbon_pct_actual REAL,
  nitrogen_pct_actual REAL,
  moisture_pct_standard REAL,
  moisture_pct_actual REAL,
  notes TEXT,
  created_at TEXT DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS prewetting (
  batch_id INTEGER PRIMARY KEY REFERENCES batches(id) ON DELETE CASCADE,
  in_date TEXT,
  out_date TEXT,
  entered_by TEXT,
  notes TEXT,
  updated_at TEXT DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS phase1 (
  batch_id INTEGER PRIMARY KEY REFERENCES batches(id) ON DELETE CASCADE,
  start_date TEXT,
  end_date TEXT,
  bunker_no TEXT,
  num_turns_planned INTEGER,
  notes TEXT,
  updated_at TEXT DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS phase1_readings (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  batch_id INTEGER NOT NULL REFERENCES batches(id) ON DELETE CASCADE,
  turn_number INTEGER,
  reading_date TEXT NOT NULL,
  bunker_no TEXT,
  pile_temp_c REAL,
  ambient_temp_c REAL,
  moisture_pct REAL,
  ammonia_level TEXT,
  ph REAL,
  entered_by TEXT,
  notes TEXT,
  created_at TEXT DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS phase2 (
  batch_id INTEGER PRIMARY KEY REFERENCES batches(id) ON DELETE CASCADE,
  tunnel_id TEXT,
  fill_date TEXT,
  end_date TEXT,
  pasteurization_date TEXT,
  pasteurization_temp_c REAL,
  pasteurization_duration_hrs REAL,
  final_moisture_pct REAL,
  compost_color TEXT,
  compost_texture TEXT,
  compost_smell TEXT,
  ammonia_cleared TEXT,
  notes TEXT,
  updated_at TEXT DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS phase2_readings (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  batch_id INTEGER NOT NULL REFERENCES batches(id) ON DELETE CASCADE,
  reading_date TEXT NOT NULL,
  temp_c REAL,
  ammonia_ppm REAL,
  entered_by TEXT,
  notes TEXT,
  created_at TEXT DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS spawning (
  batch_id INTEGER PRIMARY KEY REFERENCES batches(id) ON DELETE CASCADE,
  spawning_date TEXT,
  spawn_run_end_date TEXT,
  spawn_strain TEXT,
  spawn_rate_pct REAL,
  spawning_method TEXT,
  compost_temp_c REAL,
  room_id TEXT,
  num_bags INTEGER,
  kg_per_bag REAL,
  fill_weight_kg REAL,
  entered_by TEXT,
  notes TEXT,
  updated_at TEXT DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS casing (
  batch_id INTEGER PRIMARY KEY REFERENCES batches(id) ON DELETE CASCADE,
  prep_date TEXT,
  casing_material TEXT,
  quantity_kg REAL,
  chalk_kg REAL,
  ph REAL,
  moisture_pct REAL,
  pasteurized TEXT,
  pasteurization_temp_c REAL,
  pasteurization_duration_hrs REAL,
  application_date TEXT,
  end_date TEXT,
  layer_thickness_cm REAL,
  room_id TEXT,
  entered_by TEXT,
  notes TEXT,
  updated_at TEXT DEFAULT (datetime('now'))
);

-- Room In: one row per growing room a batch's spawned/cased material is moved
-- into. total_fill_weight_kg is recomputed (bags x kg_per_bag) on every save.
-- room_out_date is set later from the Room Out page when that room is cleared.
CREATE TABLE IF NOT EXISTS rooms (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  batch_id INTEGER NOT NULL REFERENCES batches(id) ON DELETE CASCADE,
  room_no TEXT NOT NULL,
  room_in_date TEXT,
  num_bags INTEGER,
  kg_per_bag REAL,
  total_fill_weight_kg REAL,
  room_out_date TEXT,
  entered_by TEXT,
  notes TEXT,
  created_at TEXT DEFAULT (datetime('now')),
  updated_at TEXT DEFAULT (datetime('now'))
);

-- Room Out: harvest picks logged against a room, potentially several over the
-- cropping cycle (mushrooms are picked in flushes, not all at once).
CREATE TABLE IF NOT EXISTS room_harvests (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  room_id INTEGER NOT NULL REFERENCES rooms(id) ON DELETE CASCADE,
  batch_id INTEGER NOT NULL REFERENCES batches(id) ON DELETE CASCADE,
  harvest_date TEXT NOT NULL,
  grade_a_kg REAL,
  grade_b_kg REAL,
  price_per_kg_a_npr REAL,
  price_per_kg_b_npr REAL,
  flush_number INTEGER,
  entered_by TEXT,
  notes TEXT,
  created_at TEXT DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS qc_parameters (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  stage TEXT NOT NULL,
  param_key TEXT NOT NULL,
  label TEXT NOT NULL,
  unit TEXT,
  min_value REAL,
  max_value REAL,
  UNIQUE(stage, param_key)
);

CREATE TABLE IF NOT EXISTS settings (
  key TEXT PRIMARY KEY,
  value TEXT
);

-- Farm master data: the fixed physical inventory of growing rooms, Phase II
-- tunnels, and Phase I bunkers. Codes (e.g. GR1, T1, B1) are what every stage
-- page's dropdown offers; deactivating one here keeps it selectable on batches
-- that already recorded it, it just drops out of the dropdown for new entries.
CREATE TABLE IF NOT EXISTS growing_rooms (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  code TEXT UNIQUE NOT NULL,
  name TEXT,
  notes TEXT,
  active INTEGER NOT NULL DEFAULT 1,
  created_at TEXT DEFAULT (datetime('now')),
  updated_at TEXT DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS tunnels (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  code TEXT UNIQUE NOT NULL,
  name TEXT,
  notes TEXT,
  active INTEGER NOT NULL DEFAULT 1,
  created_at TEXT DEFAULT (datetime('now')),
  updated_at TEXT DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS bunkers (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  code TEXT UNIQUE NOT NULL,
  name TEXT,
  notes TEXT,
  active INTEGER NOT NULL DEFAULT 1,
  created_at TEXT DEFAULT (datetime('now')),
  updated_at TEXT DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS roles (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT UNIQUE NOT NULL,
  is_system INTEGER NOT NULL DEFAULT 0,
  created_at TEXT DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS role_permissions (
  role_id INTEGER NOT NULL REFERENCES roles(id) ON DELETE CASCADE,
  permission_key TEXT NOT NULL,
  PRIMARY KEY (role_id, permission_key)
);

CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  username TEXT UNIQUE NOT NULL,
  password_hash TEXT NOT NULL,
  full_name TEXT,
  role_id INTEGER REFERENCES roles(id),
  active INTEGER NOT NULL DEFAULT 1,
  created_at TEXT DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS sessions (
  sid TEXT PRIMARY KEY,
  sess TEXT NOT NULL,
  expires INTEGER
);

-- A "farm" is a workspace that batches belong to. Two are seeded: the real
-- farm, and a Training farm for practice data that must never mix into real
-- reports. Master data (rooms/tunnels/bunkers/raw materials/QC ranges) is
-- deliberately NOT farm-scoped — trainees practising against the real room
-- codes and real QC ranges is the point. code_prefix keeps training batch
-- codes from colliding with real ones (TAPL-… vs TRAIN-…).
CREATE TABLE IF NOT EXISTS farms (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT UNIQUE NOT NULL,
  code_prefix TEXT NOT NULL,
  is_training INTEGER NOT NULL DEFAULT 0,
  active INTEGER NOT NULL DEFAULT 1,
  created_at TEXT DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS user_farms (
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  farm_id INTEGER NOT NULL REFERENCES farms(id) ON DELETE CASCADE,
  PRIMARY KEY (user_id, farm_id)
);
`);

// Migrate an existing intake_items table (created before the actual-vs-standard
// C/N split existed) in place, preserving all recorded rows.
const intakeItemsCols = db.prepare('PRAGMA table_info(intake_items)').all().map((c) => c.name);
if (intakeItemsCols.includes('carbon_pct') && !intakeItemsCols.includes('carbon_pct_standard')) {
  db.exec('ALTER TABLE intake_items RENAME COLUMN carbon_pct TO carbon_pct_standard');
}
if (intakeItemsCols.includes('nitrogen_pct') && !intakeItemsCols.includes('nitrogen_pct_standard')) {
  db.exec('ALTER TABLE intake_items RENAME COLUMN nitrogen_pct TO nitrogen_pct_standard');
}
const intakeItemsColsAfter = db.prepare('PRAGMA table_info(intake_items)').all().map((c) => c.name);
if (!intakeItemsColsAfter.includes('carbon_pct_actual')) {
  db.exec('ALTER TABLE intake_items ADD COLUMN carbon_pct_actual REAL');
}
if (!intakeItemsColsAfter.includes('nitrogen_pct_actual')) {
  db.exec('ALTER TABLE intake_items ADD COLUMN nitrogen_pct_actual REAL');
}
if (!intakeItemsColsAfter.includes('moisture_pct_standard')) {
  db.exec('ALTER TABLE intake_items ADD COLUMN moisture_pct_standard REAL');
}
if (!intakeItemsColsAfter.includes('moisture_pct_actual')) {
  db.exec('ALTER TABLE intake_items ADD COLUMN moisture_pct_actual REAL');
}

const rawMaterialsCols = db.prepare('PRAGMA table_info(raw_materials)').all().map((c) => c.name);
if (!rawMaterialsCols.includes('moisture_pct')) {
  db.exec('ALTER TABLE raw_materials ADD COLUMN moisture_pct REAL');
}

// Which flush a pick came from (1st/2nd/3rd), recorded by hand at entry time.
// Left null on entries made before this existed, and on any pick where the
// picker didn't say — the yield totals never depend on it.
const roomHarvestsCols = db.prepare('PRAGMA table_info(room_harvests)').all().map((c) => c.name);
if (!roomHarvestsCols.includes('flush_number')) {
  db.exec('ALTER TABLE room_harvests ADD COLUMN flush_number INTEGER');
}

const spawningCols = db.prepare('PRAGMA table_info(spawning)').all().map((c) => c.name);
if (!spawningCols.includes('spawn_run_end_date')) {
  db.exec('ALTER TABLE spawning ADD COLUMN spawn_run_end_date TEXT');
}
if (!spawningCols.includes('num_bags')) {
  db.exec('ALTER TABLE spawning ADD COLUMN num_bags INTEGER');
}
if (!spawningCols.includes('kg_per_bag')) {
  db.exec('ALTER TABLE spawning ADD COLUMN kg_per_bag REAL');
}

const casingCols = db.prepare('PRAGMA table_info(casing)').all().map((c) => c.name);
if (!casingCols.includes('end_date')) {
  db.exec('ALTER TABLE casing ADD COLUMN end_date TEXT');
}

// Phase I moved from outdoor windrow piles (measured by length/width/height)
// to indoor bunker composting. The old pile_length_m/pile_width_m/pile_height_m
// columns are left in place (harmless, historical) rather than dropped; a
// bunker_no column is added to both the batch summary and each turn reading
// so bunker assignment can be tracked and can change turn to turn.
const phase1Cols = db.prepare('PRAGMA table_info(phase1)').all().map((c) => c.name);
if (!phase1Cols.includes('bunker_no')) {
  db.exec('ALTER TABLE phase1 ADD COLUMN bunker_no TEXT');
}
const phase1ReadingsCols = db.prepare('PRAGMA table_info(phase1_readings)').all().map((c) => c.name);
if (!phase1ReadingsCols.includes('bunker_no')) {
  db.exec('ALTER TABLE phase1_readings ADD COLUMN bunker_no TEXT');
}
db.prepare(
  "UPDATE qc_parameters SET label = 'Compost temperature (bunker)' WHERE stage = 'phase1' AND param_key = 'pile_temp_c' AND label = 'Pile temperature'"
).run();

// Seed the two starting farms and back-fill every existing batch onto the real
// farm. Guarded on an empty farms table so renaming the farm later sticks.
if (db.prepare('SELECT COUNT(*) c FROM farms').get().c === 0) {
  db.prepare("INSERT INTO farms (name, code_prefix, is_training) VALUES ('Trinity Agro (Main Farm)', 'TAPL', 0)").run();
  db.prepare("INSERT INTO farms (name, code_prefix, is_training) VALUES ('Training / Practice', 'TRAIN', 1)").run();
}

const batchCols = db.prepare('PRAGMA table_info(batches)').all().map((c) => c.name);
if (!batchCols.includes('farm_id')) {
  db.exec('ALTER TABLE batches ADD COLUMN farm_id INTEGER REFERENCES farms(id)');
}
// Any batch recorded before farms existed belongs to the real farm.
const mainFarm = db.prepare('SELECT id FROM farms WHERE is_training = 0 ORDER BY id LIMIT 1').get();
if (mainFarm) {
  db.prepare('UPDATE batches SET farm_id = ? WHERE farm_id IS NULL').run(mainFarm.id);
}

// Existing users predate per-farm access; grant them every farm so nobody is
// locked out by the upgrade. New users are assigned farms in the admin UI.
const usersMissingFarms = db
  .prepare('SELECT id FROM users WHERE id NOT IN (SELECT DISTINCT user_id FROM user_farms)')
  .all();
if (usersMissingFarms.length) {
  const allFarms = db.prepare('SELECT id FROM farms').all();
  const grantFarm = db.prepare('INSERT OR IGNORE INTO user_farms (user_id, farm_id) VALUES (?, ?)');
  const grantAll = db.transaction(() => {
    usersMissingFarms.forEach((u) => allFarms.forEach((f) => grantFarm.run(u.id, f.id)));
  });
  grantAll();
}

// The 'intake' stage was merged into 'prewetting' (raw material recipe entry
// now happens only at batch creation). Any batch still parked at the old
// 'intake' stage moves forward to 'prewetting' so it matches the new pipeline.
db.prepare("UPDATE batches SET current_stage = 'prewetting' WHERE current_stage = 'intake'").run();

// Seed default QC parameters (industry-typical starting ranges for button mushroom
// compost/casing production). Uses INSERT OR IGNORE keyed on (stage, param_key) so
// re-running this on an existing database adds any newly-introduced parameters
// without touching ranges the grower has already calibrated via the Settings page.
const insertParam = db.prepare(`
  INSERT OR IGNORE INTO qc_parameters (stage, param_key, label, unit, min_value, max_value)
  VALUES (@stage, @param_key, @label, @unit, @min_value, @max_value)
`);
const defaultParams = [
  { stage: 'intake', param_key: 'cn_ratio', label: 'C:N Ratio (batch)', unit: ':1', min_value: 25, max_value: 35 },
  { stage: 'phase1', param_key: 'pile_temp_c', label: 'Compost temperature (bunker)', unit: '°C', min_value: 55, max_value: 70 },
  { stage: 'phase1', param_key: 'moisture_pct', label: 'Moisture', unit: '%', min_value: 68, max_value: 74 },
  { stage: 'phase1', param_key: 'ph', label: 'pH', unit: '', min_value: 7.5, max_value: 8.5 },
  { stage: 'phase2', param_key: 'pasteurization_temp_c', label: 'Pasteurization temperature', unit: '°C', min_value: 58, max_value: 62 },
  { stage: 'phase2', param_key: 'pasteurization_duration_hrs', label: 'Pasteurization duration', unit: 'hrs', min_value: 2, max_value: 4 },
  { stage: 'phase2', param_key: 'temp_c', label: 'Conditioning temperature', unit: '°C', min_value: 45, max_value: 50 },
  { stage: 'phase2', param_key: 'ammonia_ppm', label: 'Ammonia', unit: 'ppm', min_value: 0, max_value: 10 },
  { stage: 'phase2', param_key: 'final_moisture_pct', label: 'Final moisture', unit: '%', min_value: 68, max_value: 72 },
  { stage: 'spawning', param_key: 'compost_temp_c', label: 'Compost temp at spawning', unit: '°C', min_value: 24, max_value: 28 },
  { stage: 'spawning', param_key: 'spawn_rate_pct', label: 'Spawn rate', unit: '%', min_value: 0.5, max_value: 1.0 },
  { stage: 'casing', param_key: 'ph', label: 'Casing pH', unit: '', min_value: 7.5, max_value: 8.0 },
  { stage: 'casing', param_key: 'moisture_pct', label: 'Casing moisture', unit: '%', min_value: 60, max_value: 70 },
  { stage: 'casing', param_key: 'layer_thickness_cm', label: 'Layer thickness', unit: 'cm', min_value: 3, max_value: 5 },
  { stage: 'casing', param_key: 'pasteurization_temp_c', label: 'Casing pasteurization temp', unit: '°C', min_value: 60, max_value: 65 },
];
const seedParams = db.transaction((rows) => rows.forEach((r) => insertParam.run(r)));
seedParams(defaultParams);

// The old fixed intake fields (straw moisture as a single QC param) were replaced
// by the per-material raw material recipe + computed batch C:N ratio above.
db.prepare("DELETE FROM qc_parameters WHERE stage = 'intake' AND param_key = 'straw_moisture_pct'").run();

// Seed a starter set of common South Asian mushroom-compost raw materials with
// literature-typical dry-basis Carbon/Nitrogen %. Cost/kg is left blank on
// purpose — Nepal pricing varies by supplier/season and should be entered
// locally, not assumed. Everything here is editable/deletable in Raw Materials.
const insertMaterial = db.prepare(`
  INSERT OR IGNORE INTO raw_materials (name, default_cost_per_kg_npr, carbon_pct, nitrogen_pct, moisture_pct, notes)
  VALUES (@name, @default_cost_per_kg_npr, @carbon_pct, @nitrogen_pct, @moisture_pct, @notes)
`);
const defaultMaterials = [
  { name: 'Paddy (Rice) Straw', default_cost_per_kg_npr: null, carbon_pct: 42, nitrogen_pct: 0.6, moisture_pct: 12, notes: 'Typical C:N ~70:1, moisture ~12% air-dried — calibrate to local supply' },
  { name: 'Wheat Straw', default_cost_per_kg_npr: null, carbon_pct: 46, nitrogen_pct: 0.5, moisture_pct: 12, notes: 'Typical C:N ~90:1, moisture ~12% air-dried — calibrate to local supply' },
  { name: 'Chicken Manure / Poultry Litter', default_cost_per_kg_npr: null, carbon_pct: 32, nitrogen_pct: 3.5, moisture_pct: 40, notes: 'Typical C:N ~9:1. Moisture varies a lot by bird age, diet, litter type and barn conditions — always enter the actual moisture (and actual C/N if tested) for each delivery rather than relying on this default. If gypsum was mixed in at storage to bind ammonia, enter Gypsum as its own recipe line for its actual weight rather than folding it into this material’s weight — gypsum contributes no carbon or nitrogen, so lumping it in overstates this delivery’s C and N.' },
  { name: 'Wheat Bran', default_cost_per_kg_npr: null, carbon_pct: 40, nitrogen_pct: 2.5, moisture_pct: 10, notes: 'Typical C:N ~16:1, moisture ~10% — calibrate to local supply' },
  { name: 'Urea', default_cost_per_kg_npr: null, carbon_pct: 0, nitrogen_pct: 46, moisture_pct: 0.5, notes: 'Pure nitrogen source, no carbon contribution, negligible moisture' },
  { name: 'Gypsum', default_cost_per_kg_npr: null, carbon_pct: 0, nitrogen_pct: 0, moisture_pct: 3, notes: 'Structural/pH/ammonia-binding additive — no C or N contribution. Enter as its own recipe line with its own actual weight whenever it’s mixed into stored manure, rather than lumping its weight into the manure line.' },
];
const seedMaterials = db.transaction((rows) => rows.forEach((r) => insertMaterial.run(r)));
seedMaterials(defaultMaterials);

// Back-fill moisture_pct on the seeded materials above for databases created
// before this column existed — INSERT OR IGNORE only helps brand-new rows, and
// this never touches a value the grower has already calibrated themselves.
const backfillMoisture = db.prepare('UPDATE raw_materials SET moisture_pct = ? WHERE name = ? AND moisture_pct IS NULL');
const backfillMoistureAll = db.transaction((rows) => rows.forEach((r) => backfillMoisture.run(r.moisture_pct, r.name)));
backfillMoistureAll(defaultMaterials);

// Seed the starting roles exactly once, the first time this database has no
// roles at all — unlike qc_parameters/raw_materials above, this does NOT use
// INSERT OR IGNORE on every boot: role_permissions rows an admin has since
// unchecked in the Users & Roles page must stay removed, not get silently
// resurrected by the next server restart just because they're still in this
// defaults list. Once a role exists, it and its permissions are owned by the
// admin UI from then on.
const ALL_PERMISSIONS = require('./lib/permissions').PERMISSIONS.map((p) => p.key);
if (db.prepare('SELECT COUNT(*) c FROM roles').get().c === 0) {
  const seedRoles = db.transaction(() => {
    const insertRole = db.prepare('INSERT INTO roles (name, is_system) VALUES (?, ?)');
    const insertPerm = db.prepare('INSERT INTO role_permissions (role_id, permission_key) VALUES (?, ?)');
    const grant = (roleId, keys) => keys.forEach((k) => insertPerm.run(roleId, k));

    const adminId = insertRole.run('Admin', 1).lastInsertRowid;
    grant(adminId, ALL_PERMISSIONS);

    const managerId = insertRole.run('Farm Manager', 0).lastInsertRowid;
    grant(managerId, ALL_PERMISSIONS.filter((k) => k !== 'manage_users_roles'));

    const dataEntryId = insertRole.run('Data Entry Operator', 0).lastInsertRowid;
    grant(dataEntryId, [
      'edit_prewetting', 'edit_phase1', 'edit_phase2', 'edit_spawning',
      'edit_casing', 'edit_room_in', 'edit_harvest', 'edit_room_out',
      'use_ai_knowledge',
    ]);

    const compostId = insertRole.run('Compost Department', 0).lastInsertRowid;
    grant(compostId, ['edit_prewetting', 'edit_phase1', 'edit_phase2', 'edit_spawning', 'use_ai_knowledge']);

    const growingId = insertRole.run('Growing Department', 0).lastInsertRowid;
    grant(growingId, ['edit_casing', 'edit_room_in', 'edit_harvest', 'edit_room_out', 'use_ai_knowledge']);
  });
  seedRoles();
}

// The Admin role is defined as "every permission, always" and the admin UI
// refuses to edit it — so re-assert that on every boot. Without this, any
// permission added in a later version would silently never reach Admin, since
// the seed above only runs on a brand-new database.
const adminRoleRow = db.prepare('SELECT id FROM roles WHERE is_system = 1').get();
if (adminRoleRow) {
  const grantAdmin = db.prepare('INSERT OR IGNORE INTO role_permissions (role_id, permission_key) VALUES (?, ?)');
  const syncAdmin = db.transaction(() => ALL_PERMISSIONS.forEach((k) => grantAdmin.run(adminRoleRow.id, k)));
  syncAdmin();
}

// Where the live .db file lives — exported so the backup helper writes its
// snapshots alongside it rather than re-deriving the path.
db.dataDir = dataDir;

module.exports = db;
