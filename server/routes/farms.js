const express = require('express');
const db = require('../db');
const { requirePermission, getFarmsForUser } = require('../lib/auth');

const router = express.Router();

// Switch the active farm. Only farms this user has been granted are accepted,
// so a posted farm_id can't be used to reach a workspace they aren't assigned.
// Only same-site paths: "//other-site.com" also starts with "/" but browsers
// treat it as a different website.
function isLocalPath(p) {
  return typeof p === 'string' && p.startsWith('/') && !p.startsWith('//') && !p.startsWith('/\\');
}

router.post('/switch', (req, res) => {
  const allowed = getFarmsForUser(res.locals.currentUser.id);
  const target = allowed.find((f) => String(f.id) === String(req.body.farm_id));
  if (target) req.session.farmId = target.id;
  res.redirect(isLocalPath(req.body.next) ? req.body.next : '/');
});

// Wipe every batch in a Training farm. Deliberately restricted to farms flagged
// is_training — there is no code path here that can clear a real farm, so a
// mis-click or a stale form can't destroy production data. Stage tables, rooms
// and harvests all cascade from batches, so deleting batches clears everything.
router.post('/reset-training', requirePermission('reset_training_data'), (req, res) => {
  const farm = db.prepare('SELECT * FROM farms WHERE id = ?').get(req.body.farm_id);
  if (!farm || !farm.is_training) {
    return res.redirect('/settings/farms?error=' + encodeURIComponent('Only a Training farm can be reset.'));
  }
  // Typed confirmation, so this can't happen from a stray double-submit.
  if ((req.body.confirm || '').trim().toUpperCase() !== 'RESET') {
    return res.redirect('/settings/farms?error=' + encodeURIComponent('Type RESET to confirm wiping the training data.'));
  }
  const info = db.prepare('DELETE FROM batches WHERE farm_id = ?').run(farm.id);
  res.redirect('/settings/farms?wiped=' + info.changes);
});

router.get('/', requirePermission('manage_users_roles'), (req, res) => {
  const farms = db
    .prepare(
      `SELECT farms.*, (SELECT COUNT(*) FROM batches WHERE batches.farm_id = farms.id) AS batchCount
       FROM farms ORDER BY is_training, id`
    )
    .all();
  res.render('farms', {
    farms,
    settingsPage: 'farms',
    error: req.query.error || null,
    wiped: req.query.wiped || null,
  });
});

module.exports = router;
