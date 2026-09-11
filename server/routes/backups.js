const express = require('express');
const { requirePermission } = require('../lib/auth');
const { BACKUP_DIR, KEEP, listBackups, resolveBackupPath, backupNow } = require('../lib/backup');

const router = express.Router();
router.use(requirePermission('manage_backups'));

router.get('/', (req, res) => {
  res.render('backups', {
    backups: listBackups(),
    backupDir: BACKUP_DIR,
    keep: KEEP,
    settingsPage: 'backups',
    error: req.query.error || null,
    created: req.query.created || null,
  });
});

router.post('/run', async (req, res) => {
  try {
    const file = await backupNow('manual');
    res.redirect('/settings/backups?created=' + encodeURIComponent(file));
  } catch (err) {
    res.redirect('/settings/backups?error=' + encodeURIComponent(err.message));
  }
});

router.get('/download/:file', (req, res) => {
  const full = resolveBackupPath(req.params.file);
  if (!full) return res.status(404).render('404');
  res.download(full);
});

module.exports = router;
