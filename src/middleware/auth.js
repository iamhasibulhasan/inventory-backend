const jwt = require('jsonwebtoken');
const { query } = require('../config/database');

const authenticate = async (req, res, next) => {
  try {
    const authHeader = req.headers.authorization;
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      return res.status(401).json({ success: false, message: 'No token provided' });
    }
    const token = authHeader.split(' ')[1];
    const decoded = jwt.verify(token, process.env.JWT_SECRET || 'inventory_secret_2025');
    const result = await query(
      `SELECT u.id, u.name, u.email, u.role_id, r.name as role_name, u.is_active
       FROM users u JOIN roles r ON u.role_id = r.id WHERE u.id = $1`,
      [decoded.userId]
    );
    if (!result.rows[0] || !result.rows[0].is_active) {
      return res.status(401).json({ success: false, message: 'User not found or inactive' });
    }
    req.user = result.rows[0];
    next();
  } catch (error) {
    return res.status(401).json({ success: false, message: 'Invalid or expired token' });
  }
};

const authorize = (...roles) => (req, res, next) => {
  if (!roles.includes(req.user.role_name)) {
    return res.status(403).json({ success: false, message: 'Access denied' });
  }
  next();
};

const checkPermission = (menuKey, action = 'can_view') => async (req, res, next) => {
  try {
    // Admin always has access
    if (req.user.role_name === 'admin') return next();
    const actionCol = action.startsWith('can_') ? action : `can_${action}`;
    const result = await query(
      `SELECT rp.${actionCol} FROM role_permissions rp
       JOIN permissions p ON rp.permission_id = p.id
       WHERE rp.role_id = $1 AND p.menu_key = $2`,
      [req.user.role_id, menuKey]
    );
    if (result.rows.length === 0 || !result.rows[0][actionCol]) {
      return res.status(403).json({ success: false, message: 'Permission denied' });
    }
    next();
  } catch (error) {
    next(error);
  }
};

module.exports = { authenticate, authorize, checkPermission };
