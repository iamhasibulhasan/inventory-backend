// ============================================================
// AUTH MODULE
// ============================================================

// --- services/auth.service.js ---
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const { query } = require('../../../config/database');

const login = async (email, password) => {
  const result = await query(
    `SELECT u.*, r.name as role_name FROM users u JOIN roles r ON u.role_id = r.id WHERE u.email = $1`,
    [email]
  );
  const user = result.rows[0];
  if (!user) throw { statusCode: 401, message: 'Invalid credentials' };
  if (!user.is_active) throw { statusCode: 403, message: 'Account is deactivated' };

  const valid = await bcrypt.compare(password, user.password_hash);
  if (!valid) throw { statusCode: 401, message: 'Invalid credentials' };

  // Get permissions
  const permsResult = await query(
    `SELECT p.menu_key, p.menu_label, p.parent_key, p.icon, p.sort_order,
rp.can_view, rp.can_create, rp.can_edit, rp.can_delete
FROM role_permissions rp
JOIN permissions p ON rp.permission_id = p.id WHERE rp.role_id = $1`,
    [user.role_id]
  );

  const token = jwt.sign(
    { userId: user.id, email: user.email, role: user.role_name },
    process.env.JWT_SECRET || 'inventory_secret_2025',
    { expiresIn: '8h' }
  );

  await query('UPDATE users SET last_login = NOW() WHERE id = $1', [user.id]);

  return {
    token,
    user: {
      id: user.id,
      name: user.name,
      email: user.email,
      phone: user.phone,
      role: user.role_name,
      avatar_url: user.avatar_url,
      permissions: permsResult.rows
    }
  };
};

const changePassword = async (userId, oldPassword, newPassword) => {
  const result = await query('SELECT password_hash FROM users WHERE id = $1', [userId]);
  const valid = await bcrypt.compare(oldPassword, result.rows[0].password_hash);
  if (!valid) throw { statusCode: 400, message: 'Current password is incorrect' };
  const hash = await bcrypt.hash(newPassword, 12);
  await query('UPDATE users SET password_hash = $1 WHERE id = $2', [hash, userId]);
  return { message: 'Password updated successfully' };
};

module.exports = { login, changePassword };
