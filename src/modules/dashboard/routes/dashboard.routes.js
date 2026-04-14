// ===== dashboard/routes/dashboard.routes.js =====
const express = require('express');
const router = express.Router();
const dashboardService = require('../services/dashboard.service');
const { authenticate, checkPermission } = require('../../../middleware/auth');
const { asyncHandler } = require('../../../middleware/errorHandler');

router.use(authenticate);

router.get('/', asyncHandler(async (req, res) => {
  const days = parseInt(req.query.days) || 30;
  const data = await dashboardService.getAnalytics(days);
  res.json({ success: true, data });
}));

router.get('/stock-summary', asyncHandler(async (req, res) => {
  const data = await dashboardService.getStockSummary();
  res.json({ success: true, data });
}));

module.exports = router;
