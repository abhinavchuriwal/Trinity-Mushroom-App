const path = require('path');
const crypto = require('crypto');
const express = require('express');
const session = require('express-session');
const db = require('./db');
const qc = require('./lib/qc');
const { STAGE_META, stagesFor } = require('./lib/stages');
const { requireAuth } = require('./lib/auth');
const SqliteSessionStore = require('./lib/sqliteSessionStore');
const { todayLocal } = require('./lib/dates');

const app = express();
const PORT = process.env.PORT || 4000;

app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, '..', 'views'));

app.use(express.urlencoded({ extended: true }));
app.use(express.static(path.join(__dirname, '..', 'public')));

// Behind a cloud host's proxy (Railway/Render/etc.), TLS is terminated at the
// edge and this process only ever sees plain HTTP — trust proxy so Express
// reads the platform's X-Forwarded-Proto correctly, which the secure cookie
// flag below depends on.
app.set('trust proxy', 1);

// A random session secret, generated once and kept in the settings table
// (same k/v table QC config already lives in) so it survives restarts —
// regenerating it on every boot would silently log everyone out each time.
let sessionSecretRow = db.prepare("SELECT value FROM settings WHERE key = 'session_secret'").get();
if (!sessionSecretRow) {
  const secret = crypto.randomBytes(32).toString('hex');
  db.prepare("INSERT INTO settings (key, value) VALUES ('session_secret', ?)").run(secret);
  sessionSecretRow = { value: secret };
}

app.use(
  session({
    store: new SqliteSessionStore(),
    secret: sessionSecretRow.value,
    resave: false,
    saveUninitialized: false,
    cookie: {
      maxAge: 30 * 86400000, // 30 days
      // Only require HTTPS for the cookie when actually deployed behind one
      // (NODE_ENV=production, set by the hosting platform) — a plain-HTTP LAN
      // deployment on a local Mac would otherwise never be able to log in.
      secure: process.env.NODE_ENV === 'production',
    },
  })
);

app.use((req, res, next) => {
  res.locals.companyName = 'Trinity Agro Private Limited';
  res.locals.appName = 'Trinity Agro FarmFlow';
  res.locals.currentPath = req.path;
  // Farm-local date; routes that pass their own `today` override this.
  res.locals.today = todayLocal();
  res.locals.qcCell = (stage, key, value) => {
    const { status, param } = qc.evaluate(stage, key, value);
    const unit = param && param.unit ? param.unit : '';
    const displayVal = value === null || value === undefined || value === '' ? '—' : `${value}${unit}`;
    const label = status === 'ok' ? 'OK' : status === 'low' ? 'LOW' : status === 'high' ? 'HIGH' : '';
    const rangeTitle =
      param && (param.min_value !== null || param.max_value !== null)
        ? `Target: ${param.min_value ?? '–'}–${param.max_value ?? '–'}${unit}`
        : '';
    if (status === 'na') return `<span class="qc-cell">${displayVal}</span>`;
    return `<span class="qc-cell qc-${status}" title="${rangeTitle}">${displayVal} <b>${label}</b></span>`;
  };
  res.locals.npr = (v) => {
    if (v === null || v === undefined || v === '') return '—';
    return 'NPR ' + Number(v).toLocaleString('en-IN', { maximumFractionDigits: 2 });
  };
  res.locals.qcParam = qc.getParam;
  res.locals.v = (val) => (val === null || val === undefined ? '' : val);
  res.locals.daysLabel = (days) => (days === null || days === undefined ? '—' : `${days} day${days === 1 ? '' : 's'}`);
  res.locals.STAGE_META = STAGE_META;
  res.locals.stagesFor = stagesFor;
  // Renders <option>s for a master-data dropdown (growing rooms/tunnels/bunkers).
  // If currentValue doesn't match any active code — e.g. a batch recorded before
  // that code existed, or before farm master data was set up at all — it's kept
  // as an extra selected option so an old batch's real recorded value is never
  // silently blanked out by adding this dropdown.
  res.locals.optionsFor = (items, currentValue) => {
    let html = '<option value="">— Select —</option>';
    let found = false;
    (items || []).forEach((it) => {
      const selected = it.code === currentValue;
      if (selected) found = true;
      html += `<option value="${it.code}" ${selected ? 'selected' : ''}>${it.code}${it.name ? ' — ' + it.name : ''}</option>`;
    });
    if (currentValue && !found) {
      html += `<option value="${currentValue}" selected>${currentValue} (not in master list)</option>`;
    }
    return html;
  };
  next();
});

// /login, /setup, /logout must be reachable before auth is required.
app.use('/', require('./routes/auth'));

app.use(requireAuth);

app.use('/today', require('./routes/today'));
app.use('/', require('./routes/batches'));
app.use('/', require('./routes/stages'));
app.use('/', require('./routes/rooms'));
app.use('/', require('./routes/handover'));
app.use('/harvest-log', require('./routes/harvestLog'));
app.use('/settings', require('./routes/settings'));
app.use('/raw-materials', require('./routes/rawMaterials'));
app.use('/farm-master', require('./routes/farmMaster'));
app.use('/reports', require('./routes/reports'));
app.use('/admin', require('./routes/admin'));
app.use('/farm', require('./routes/farms'));
app.use('/settings/farms', require('./routes/farms'));
app.use('/settings/backups', require('./routes/backups'));

app.use((req, res) => {
  res.status(404).render('404');
});

app.listen(PORT, () => {
  console.log(`Trinity Agro FarmFlow running at http://localhost:${PORT}`);
  require('./lib/backup').start();
});
