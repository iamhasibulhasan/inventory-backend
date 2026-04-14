const express = require('express');
const router = express.Router();
const Joi = require('joi');
const authService = require('../services/auth.service');
const { authenticate } = require('../../../middleware/auth');
const { asyncHandler } = require('../../../middleware/errorHandler');

const loginSchema = Joi.object({
  email: Joi.string().email().required(),
  password: Joi.string().min(6).required()
});

// POST /api/auth/login
router.post('/login', asyncHandler(async (req, res) => {
  const { error, value } = loginSchema.validate(req.body);
  if (error) return res.status(400).json({ success: false, message: error.details[0].message });
  const data = await authService.login(value.email, value.password);
  res.json({ success: true, ...data });
}));

// GET /api/auth/me
router.get('/me', authenticate, asyncHandler(async (req, res) => {
  res.json({ success: true, user: req.user });
}));

// POST /api/auth/change-password
router.post('/change-password', authenticate, asyncHandler(async (req, res) => {
  const { oldPassword, newPassword } = req.body;
  const result = await authService.changePassword(req.user.id, oldPassword, newPassword);
  res.json({ success: true, ...result });
}));

// POST /api/auth/logout
router.post('/logout', authenticate, (req, res) => {
  res.json({ success: true, message: 'Logged out successfully' });
});

module.exports = router;
