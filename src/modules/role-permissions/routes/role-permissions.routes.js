const express = require('express');
const router = express.Router();
const { query } = require('../../../config/database');
const { authenticate, authorize } = require('../../../middleware/auth');
const { asyncHandler } = require('../../../middleware/errorHandler');

router.use(authenticate);

// GET all permissions (menu tree)
router.get('/permissions', asyncHandler(async (req, res) => {
  const result = await query(
    `SELECT * FROM permissions ORDER BY COALESCE(parent_key,''), sort_order`
  );
  res.json({ success: true, data: result.rows });
}));

// GET role permissions
router.get('/roles', asyncHandler(async (req, res) => {
  const result = await query(
    `SELECT r.*, 
      (SELECT COUNT(*) FROM role_permissions WHERE role_id = r.id) as permission_count
     FROM roles r ORDER BY r.created_at`
  );
  res.json({ success: true, data: result.rows });
}));

router.get('/roles/:roleId', asyncHandler(async (req, res) => {
  const [role, perms] = await Promise.all([
    query('SELECT * FROM roles WHERE id = $1', [req.params.roleId]),
    query(
      `SELECT rp.*, p.menu_key, p.menu_label, p.parent_key, p.icon, p.sort_order
       FROM role_permissions rp
       JOIN permissions p ON rp.permission_id = p.id
       WHERE rp.role_id = $1
       ORDER BY p.sort_order`,
      [req.params.roleId]
    )
  ]);
  if (!role.rows[0]) return res.status(404).json({ success: false, message: 'Role not found' });
  res.json({ success: true, data: { ...role.rows[0], permissions: perms.rows } });
}));

// GET current user's permissions
router.get('/my-permissions', asyncHandler(async (req, res) => {
  const result = await query(
    `SELECT p.menu_key, p.menu_label, p.parent_key, p.icon, p.sort_order,
       rp.can_view, rp.can_create, rp.can_edit, rp.can_delete
     FROM role_permissions rp
     JOIN permissions p ON rp.permission_id = p.id
     WHERE rp.role_id = $1
     ORDER BY p.sort_order`,
    [req.user.role_id]
  );
  res.json({ success: true, data: result.rows });
}));

// PUT update role permissions (bulk)
router.put('/roles/:roleId', authorize('admin'), asyncHandler(async (req, res) => {
  const { permissions } = req.body; // [{permission_id, can_view, can_create, can_edit, can_delete}]
  // Delete existing
  await query('DELETE FROM role_permissions WHERE role_id = $1', [req.params.roleId]);
  // Re-insert
  for (const p of permissions) {
    await query(
      `INSERT INTO role_permissions (role_id, permission_id, can_view, can_create, can_edit, can_delete)
       VALUES ($1,$2,$3,$4,$5,$6)`,
      [req.params.roleId, p.permission_id, p.can_view||true, p.can_create||false, p.can_edit||false, p.can_delete||false]
    );
  }
  res.json({ success: true, message: 'Role permissions updated' });
}));

// POST create role
router.post('/roles', authorize('admin'), asyncHandler(async (req, res) => {
  const { name, description } = req.body;
  const result = await query(
    'INSERT INTO roles (name, description) VALUES ($1,$2) RETURNING *',
    [name, description]
  );
  res.status(201).json({ success: true, data: result.rows[0] });
}));

module.exports = router;
