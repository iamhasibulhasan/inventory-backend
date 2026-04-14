const express = require('express');
const router = express.Router();
const { query } = require('../../../config/database');
const { authenticate, checkPermission } = require('../../../middleware/auth');
const { asyncHandler } = require('../../../middleware/errorHandler');

router.use(authenticate);

router.get('/', checkPermission('suppliers','view'), asyncHandler(async (req, res) => {
  const { search } = req.query;
  let sql = 'SELECT * FROM suppliers WHERE 1=1';
  const params = [];
  if (search) { sql += ` AND (name ILIKE $1 OR email ILIKE $1 OR phone ILIKE $1)`; params.push(`%${search}%`); }
  sql += ' ORDER BY name';
  const result = await query(sql, params);
  res.json({ success: true, data: result.rows });
}));

router.get('/:id', checkPermission('suppliers','view'), asyncHandler(async (req, res) => {
  const [supplier, orders] = await Promise.all([
    query('SELECT * FROM suppliers WHERE id = $1', [req.params.id]),
    query(`SELECT po_number, status, total_amount, order_date FROM purchase_orders WHERE supplier_id = $1 ORDER BY created_at DESC LIMIT 10`, [req.params.id])
  ]);
  if (!supplier.rows[0]) return res.status(404).json({ success: false, message: 'Supplier not found' });
  res.json({ success: true, data: { ...supplier.rows[0], recent_orders: orders.rows } });
}));

router.post('/', asyncHandler(async (req, res) => {
  const { name, contact_person, email, phone, address, city_id, tax_id, payment_terms } = req.body;
  const result = await query(
    `INSERT INTO suppliers (name, contact_person, email, phone, address, city_id, tax_id, payment_terms)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING *`,
    [name, contact_person, email, phone, address, city_id||null, tax_id, payment_terms||30]
  );
  res.status(201).json({ success: true, data: result.rows[0] });
}));

router.put('/:id', asyncHandler(async (req, res) => {
  const { name, contact_person, email, phone, address, city_id, tax_id, payment_terms, is_active } = req.body;
  const result = await query(
    `UPDATE suppliers SET name=$1, contact_person=$2, email=$3, phone=$4, address=$5,
     city_id=$6, tax_id=$7, payment_terms=$8, is_active=$9 WHERE id=$10 RETURNING *`,
    [name, contact_person, email, phone, address, city_id||null, tax_id, payment_terms, is_active, req.params.id]
  );
  res.json({ success: true, data: result.rows[0] });
}));

module.exports = router;
