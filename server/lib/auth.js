const bcrypt = require('bcryptjs');
const db = require('../db');
const { PERMISSIONS } = require('./permissions');

function hashPassword(plain) {
  return bcrypt.hashSync(plain, 10);
}

function verifyPassword(plain, hash) {
  return bcrypt.compareSync(plain, hash);
}

function getUserWithPermissions(userId) {
  const user = db.prepare('SELECT * FROM users WHERE id = ? AND active = 1').get(userId);
  if (!user) return null;
  const perms = db
    .prepare('SELECT permission_key FROM role_permissions WHERE role_id = ?')
    .all(user.role_id)
    .map((r) => r.permission_key);
  const roleName = user.role_id ? (db.prepare('SELECT name FROM roles WHERE id = ?').get(user.role_id) || {}).name : null;
  return { ...user, permissions: perms, roleName };
}

// Farms this user may switch between. Ordered real-farm-first so the default
// landing farm is never the Training one.
function getFarmsForUser(userId) {
  return db
    .prepare(
      `SELECT farms.* FROM farms
       JOIN user_farms ON user_farms.farm_id = farms.id
       WHERE user_farms.user_id = ? AND farms.active = 1
       ORDER BY farms.is_training, farms.id`
    )
    .all(userId);
}

// Every request needs a logged-in, active user (enforced globally in app.js
// except for /login, /setup, and static assets). Loads res.locals.currentUser
// and res.locals.can(key) so views can freely show/hide nav links and actions.
function requireAuth(req, res, next) {
  const userId = req.session && req.session.userId;
  const user = userId ? getUserWithPermissions(userId) : null;
  if (!user) {
    req.session.userId = null;
    const next_ = encodeURIComponent(req.originalUrl);
    return res.redirect(`/login?next=${next_}`);
  }
  res.locals.currentUser = user;
  res.locals.can = (key) => user.permissions.includes(key);

  // Resolve which farm this request operates on. The session remembers the
  // choice, but it's re-validated against the user's grants every request so
  // revoking a farm takes effect immediately rather than at next login.
  const farms = getFarmsForUser(user.id);
  if (!farms.length) {
    return res.status(403).render('403', { permission: 'access to any farm (ask an Admin to assign one)' });
  }
  const chosen = farms.find((f) => f.id === req.session.farmId) || farms[0];
  req.session.farmId = chosen.id;
  req.farmId = chosen.id;
  res.locals.currentFarm = chosen;
  res.locals.allowedFarms = farms;
  next();
}

// Gate one route behind a specific permission key. Assumes requireAuth has
// already run (res.locals.currentUser set); a missing permission renders a
// plain 403 rather than redirecting, so the user isn't bounced back to a page
// they were legitimately looking at.
function requirePermission(key) {
  return (req, res, next) => {
    if (res.locals.can && res.locals.can(key)) return next();
    res.status(403).render('403', { permission: key });
  };
}

module.exports = {
  PERMISSIONS,
  hashPassword,
  verifyPassword,
  getUserWithPermissions,
  getFarmsForUser,
  requireAuth,
  requirePermission,
};
