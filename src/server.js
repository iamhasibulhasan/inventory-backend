require('dotenv').config();
const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const morgan = require('morgan');
const rateLimit = require('express-rate-limit');

const app = express();
const PORT = process.env.PORT || 5000;

app.use(helmet());
app.use(cors({ origin: process.env.FRONTEND_URL || 'http://localhost:3000', credentials: true }));
app.use(morgan('combined'));
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true }));
app.use('/api/', rateLimit({ windowMs: 15 * 60 * 1000, max: 500 }));

// ---- Routes ----
app.use('/api/auth',           require('./modules/auth/routes/auth.routes'));
app.use('/api/users',          require('./modules/users/routes/user.routes'));
app.use('/api/role-permissions', require('./modules/role-permissions/routes/role-permissions.routes'));
app.use('/api/location',       require('./modules/location/routes/location.routes'));
app.use('/api/suppliers',      require('./modules/suppliers/routes/supplier.routes'));
app.use('/api/commercial',     require('./modules/commercial/routes/commercial.routes'));
app.use('/api/purchase-requisitions', require('./modules/purchase/routes/purchase.routes'));
app.use('/api/purchase-orders', require('./modules/purchase/routes/po.routes'));
app.use('/api/inbound',        require('./modules/inbound/routes/inbound.routes'));
app.use('/api/product-stack',  require('./modules/product-stack/routes/product-stack.routes'));
app.use('/api/stock-overview', require('./modules/stock-overview/routes/stock-overview.routes'));
app.use('/api/outbound',       require('./modules/outbound/routes/outbound.routes'));
app.use('/api/packaging',      require('./modules/packaging/routes/packaging.routes'));
app.use('/api/damage',         require('./modules/damage/routes/damage.routes'));
app.use('/api/warehouse',      require('./modules/warehouse-settings/routes/warehouse.routes'));
app.use('/api/dashboard',      require('./modules/dashboard/routes/dashboard.routes'));

app.get('/health', (req, res) => res.json({ status: 'ok', version: '2.0', timestamp: new Date() }));
app.use(require('./middleware/errorHandler').errorHandler);

app.listen(PORT, () => {
  console.log(`\n🚀 Inventory API v2.0 running on port ${PORT}`);
  console.log(`📦 Environment: ${process.env.NODE_ENV || 'development'}\n`);
});

module.exports = app;
