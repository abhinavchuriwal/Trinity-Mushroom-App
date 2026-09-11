const express = require('express');
const db = require('../db');
const { PERMISSIONS, hashPassword, requirePermission } = require('../lib/auth');

const router = express.Router();
router.use(requirePermission('manage_users_roles'));

function str(v) {
  return v === undefined || v === '' ? null : v;
}

// Counts active users who currently hold a permission (walking their role's
// grants) — used to block an edit that would leave nobody able to manage
// users/roles at all, which would lock the whole farm out of the admin page.
function activeUsersWithPermission(key, excludingUserId) {
  return db
    .prepare(
      `SELECT users.id FROM users
       JOIN role_permissions ON role_permissions.role_id = users.role_id AND role_permissions.permission_key = ?
       WHERE users.active = 1 AND users.id != ?`
    )
    .all(key, excludingUserId || -1).length;
}

function loadRolesWithPermissions() {
  const roles = db.prepare('SELECT * FROM roles ORDER BY is_system DESC, name').all();
  const permRows = db.prepare('SELECT * FROM role_permissions').all();
  return roles.map((role) => ({
    ...role,
    permissions: permRows.filter((p) => p.role_id === role.id).map((p) => p.permission_key),
    userCount: db.prepare('SELECT COUNT(*) c FROM users WHERE role_id = ?').get(role.id).c,
  }));
}

function render(res, error) {
  const farms = db.prepare('SELECT * FROM farms WHERE active = 1 ORDER BY is_training, id').all();
  const grants = db.prepare('SELECT * FROM user_farms').all();
  res.render('admin-users', {
    roles: loadRolesWithPermissions(),
    farms,
    users: db
      .prepare('SELECT users.*, roles.name AS role_name FROM users LEFT JOIN roles ON roles.id = users.role_id ORDER BY users.username')
      .all()
      .map((u) => ({ ...u, farmIds: grants.filter((g) => g.user_id === u.id).map((g) => g.farm_id) })),
    permissionGroups: PERMISSIONS.reduce((groups, p) => {
      (groups[p.group] = groups[p.group] || []).push(p);
      return groups;
    }, {}),
    error: error || null,
    settingsPage: 'users',
  });
}

router.get('/', (req, res) => res.redirect('/admin/users'));
router.get('/users', (req, res) => render(res));

// ---- Roles ----
router.post('/roles', (req, res) => {
  const name = (req.body.name || '').trim();
  const perms = [].concat(req.body.permissions || []);
  if (!name) return render(res, 'Enter a role name.');
  try {
    const roleId = db.prepare('INSERT INTO roles (name) VALUES (?)').run(name).lastInsertRowid;
    const insertPerm = db.prepare('INSERT INTO role_permissions (role_id, permission_key) VALUES (?, ?)');
    perms.forEach((key) => insertPerm.run(roleId, key));
  } catch (e) {
    return render(res, `A role named "${name}" already exists.`);
  }
  res.redirect('/admin/users');
});

router.post('/roles/:id', (req, res) => {
  const role = db.prepare('SELECT * FROM roles WHERE id = ?').get(req.params.id);
  if (!role) return res.redirect('/admin/users');

  // The Admin role is protected: always every permission, name never changes.
  // Without this, an admin could accidentally strip manage_users_roles from
  // Admin and lock the whole farm out of ever managing accounts again.
  if (role.is_system) return res.redirect('/admin/users');

  const name = (req.body.name || '').trim();
  const perms = [].concat(req.body.permissions || []);
  if (!name) return render(res, 'Role name cannot be blank.');

  const wouldOrphanUserMgmt =
    !perms.includes('manage_users_roles') &&
    db.prepare('SELECT permission_key FROM role_permissions WHERE role_id = ? AND permission_key = ?').get(role.id, 'manage_users_roles') &&
    activeUsersWithPermission('manage_users_roles', -1) - db.prepare('SELECT COUNT(*) c FROM users WHERE role_id = ? AND active = 1').get(role.id).c <= 0;
  if (wouldOrphanUserMgmt) {
    return render(res, 'Refusing to remove Manage Users & Roles from this role — no other active user would be able to manage accounts.');
  }

  const tx = db.transaction(() => {
    db.prepare('UPDATE roles SET name = ? WHERE id = ?').run(name, role.id);
    db.prepare('DELETE FROM role_permissions WHERE role_id = ?').run(role.id);
    const insertPerm = db.prepare('INSERT INTO role_permissions (role_id, permission_key) VALUES (?, ?)');
    perms.forEach((key) => insertPerm.run(role.id, key));
  });
  try {
    tx();
  } catch (e) {
    return render(res, `A role named "${name}" already exists.`);
  }
  res.redirect('/admin/users');
});

router.post('/roles/:id/delete', (req, res) => {
  const role = db.prepare('SELECT * FROM roles WHERE id = ?').get(req.params.id);
  if (!role) return res.redirect('/admin/users');
  if (role.is_system) return render(res, 'The Admin role cannot be deleted.');
  const inUse = db.prepare('SELECT COUNT(*) c FROM users WHERE role_id = ?').get(role.id).c;
  if (inUse > 0) return render(res, `Reassign the ${inUse} user(s) with this role before deleting it.`);
  db.prepare('DELETE FROM roles WHERE id = ?').run(role.id);
  res.redirect('/admin/users');
});

// ---- Users ----
router.post('/users', (req, res) => {
  const { full_name, password, role_id } = req.body;
  const username = (req.body.username || '').trim().toLowerCase();
  if (!username) return render(res, 'Enter a username.');
  if (!password || password.length < 6) return render(res, 'Password must be at least 6 characters.');
  const farmIds = [].concat(req.body.farm_ids || []).map(Number).filter(Boolean);
  if (!farmIds.length) return render(res, 'Give the user access to at least one farm.');
  try {
    const create = db.transaction(() => {
      const id = db
        .prepare('INSERT INTO users (username, password_hash, full_name, role_id) VALUES (?, ?, ?, ?)')
        .run(username, hashPassword(password), str(full_name), role_id ? Number(role_id) : null).lastInsertRowid;
      const grant = db.prepare('INSERT INTO user_farms (user_id, farm_id) VALUES (?, ?)');
      farmIds.forEach((fid) => grant.run(id, fid));
    });
    create();
  } catch (e) {
    return render(res, `Username "${username}" already exists.`);
  }
  res.redirect('/admin/users');
});

router.post('/users/:id', (req, res) => {
  const target = db.prepare('SELECT * FROM users WHERE id = ?').get(req.params.id);
  if (!target) return res.redirect('/admin/users');
  const { full_name, password, role_id, active } = req.body;
  const willBeActive = active ? 1 : 0;

  const targetHasUserMgmt = db
    .prepare('SELECT permission_key FROM role_permissions WHERE role_id = ? AND permission_key = ?')
    .get(target.role_id, 'manage_users_roles');
  const newRoleHasUserMgmt = role_id
    ? db.prepare('SELECT permission_key FROM role_permissions WHERE role_id = ? AND permission_key = ?').get(Number(role_id), 'manage_users_roles')
    : null;
  const losingUserMgmt = targetHasUserMgmt && target.active && (!willBeActive || !newRoleHasUserMgmt);
  if (losingUserMgmt && activeUsersWithPermission('manage_users_roles', target.id) === 0) {
    return render(res, 'Refusing — this is the last active user who can manage users & roles.');
  }

  const farmIds = [].concat(req.body.farm_ids || []).map(Number).filter(Boolean);
  if (!farmIds.length) return render(res, 'A user needs access to at least one farm.');

  const save = db.transaction(() => {
    db.prepare(
      `UPDATE users SET full_name = ?, role_id = ?, active = ?${password ? ', password_hash = ?' : ''} WHERE id = ?`
    ).run(
      ...[str(full_name), role_id ? Number(role_id) : null, willBeActive, ...(password ? [hashPassword(password)] : []), target.id]
    );
    db.prepare('DELETE FROM user_farms WHERE user_id = ?').run(target.id);
    const grant = db.prepare('INSERT INTO user_farms (user_id, farm_id) VALUES (?, ?)');
    farmIds.forEach((fid) => grant.run(target.id, fid));
  });
  save();
  res.redirect('/admin/users');
});

router.post('/users/:id/delete', (req, res) => {
  const target = db.prepare('SELECT * FROM users WHERE id = ?').get(req.params.id);
  if (!target) return res.redirect('/admin/users');
  const targetHasUserMgmt = db
    .prepare('SELECT permission_key FROM role_permissions WHERE role_id = ? AND permission_key = ?')
    .get(target.role_id, 'manage_users_roles');
  if (targetHasUserMgmt && target.active && activeUsersWithPermission('manage_users_roles', target.id) === 0) {
    return render(res, 'Refusing to delete — this is the last active user who can manage users & roles.');
  }
  db.prepare('DELETE FROM users WHERE id = ?').run(target.id);
  res.redirect('/admin/users');
});

module.exports = router;
