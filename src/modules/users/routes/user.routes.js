// ===== users/routes/user.routes.js =====
const express = require('express');
const router = express.Router();
const bcrypt = require('bcryptjs');
const { query } = require('../../../config/database');
const { authenticate, checkPermission } = require('../../../middleware/auth');
const { asyncHandler } = require('../../../middleware/errorHandler');

router.use(authenticate);

router.get('/', checkPermission('users','view'), asyncHandler(async (req, res) => {
  const result = await query(`SELECT u.id, u.name, u.email, u.phone, u.is_active, u.last_login, u.created_at, r.name as role_name FROM users u JOIN roles r ON u.role_id = r.id ORDER BY u.created_at DESC`);
  res.json({ success: true, data: result.rows });
}));

router.get('/roles', authenticate, asyncHandler(async (req, res) => {
  const result = await query('SELECT * FROM roles ORDER BY name');
  res.json({ success: true, data: result.rows });
}));

router.post('/', checkPermission('users','create'), asyncHandler(async (req, res) => {
  const { name, email, phone, password, role_id } = req.body;
  const hash = await bcrypt.hash(password, 12);
  const result = await query(
    `INSERT INTO users (name, email, phone, password_hash, role_id) VALUES ($1,$2,$3,$4,$5) RETURNING id, name, email, phone, role_id`,
    [name, email, phone, hash, role_id]
  );
  res.status(201).json({ success: true, data: result.rows[0] });
}));

router.put('/:id', checkPermission('users','edit'), asyncHandler(async (req, res) => {
  const { name, phone, role_id, is_active } = req.body;
  const result = await query(
    'UPDATE users SET name=$1, phone=$2, role_id=$3, is_active=$4 WHERE id=$5 RETURNING id, name, email, phone, role_id, is_active',
    [name, phone, role_id, is_active, req.params.id]
  );
  res.json({ success: true, data: result.rows[0] });
}));

router.delete('/:id', checkPermission('users','delete'), asyncHandler(async (req, res) => {
  await query('UPDATE users SET is_active = FALSE WHERE id = $1', [req.params.id]);
  res.json({ success: true, message: 'User deactivated' });
}));

module.exports = router;
