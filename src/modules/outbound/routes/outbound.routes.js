const express = require('express');
const router = express.Router();
const { query, getClient } = require('../../../config/database');
const { authenticate } = require('../../../middleware/auth');
const { asyncHandler } = require('../../../middleware/errorHandler');

router.use(authenticate);
const genOrder = () => `ORD-${Date.now().toString().slice(-8)}`;

router.get('/', asyncHandler(async (req, res) => {
  const { status, source, page=1, limit=20 } = req.query;
  const offset = (page-1)*limit;
  let conditions = ['1=1'];
  const params = [];
  let i = 1;
  if (status) { conditions.push(`o.status=$${i++}`); params.push(status); }
  if (source) { conditions.push(`o.order_source=$${i++}`); params.push(source); }
  const where = conditions.join(' AND ');
  const [data, count] = await Promise.all([
    query(
      `SELECT o.*, c.name as customer_name, c.phone as customer_phone, s.name as store_name,
        (SELECT COUNT(*) FROM order_items WHERE order_id=o.id) as item_count
       FROM orders o LEFT JOIN customers c ON o.customer_id=c.id LEFT JOIN stores s ON o.store_id=s.id
       WHERE ${where} ORDER BY o.created_at DESC LIMIT $${i} OFFSET $${i+1}`,
      [...params, limit, offset]
    ),
    query(`SELECT COUNT(*) FROM orders o WHERE ${where}`, params)
  ]);
  res.json({ success: true, data: data.rows, total: parseInt(count.rows[0].count) });
}));

router.get('/stats', asyncHandler(async (req, res) => {
  const result = await query(
    `SELECT
      COUNT(*) FILTER (WHERE status='pending') as pending,
      COUNT(*) FILTER (WHERE status='approved') as approved,
      COUNT(*) FILTER (WHERE status='packaging') as packaging,
      COUNT(*) FILTER (WHERE status='processing') as processing,
      COUNT(*) FILTER (WHERE status='shipped') as shipped,
      COUNT(*) FILTER (WHERE status='delivered') as delivered,
      COUNT(*) FILTER (WHERE status='cancelled') as cancelled,
      COUNT(*) FILTER (WHERE order_source='marketplace') as marketplace,
      COUNT(*) FILTER (WHERE order_source='ecommerce') as ecommerce,
      COUNT(*) FILTER (WHERE order_source='manual') as manual
     FROM orders WHERE created_at >= NOW() - INTERVAL '30 days'`
  );
  res.json({ success: true, data: result.rows[0] });
}));

router.get('/customers', asyncHandler(async (req, res) => {
  const { search } = req.query;
  let sql = 'SELECT * FROM customers WHERE is_active=TRUE';
  const params = [];
  if (search) { sql += ` AND (name ILIKE $1 OR phone ILIKE $1)`; params.push(`%${search}%`); }
  sql += ' ORDER BY name LIMIT 50';
  const result = await query(sql, params);
  res.json({ success: true, data: result.rows });
}));

router.get('/:id', asyncHandler(async (req, res) => {
  const [order, items] = await Promise.all([
    query(
      `SELECT o.*, c.name as customer_name, c.email as customer_email, c.phone as customer_phone,
        c.address as customer_address, s.name as store_name
       FROM orders o LEFT JOIN customers c ON o.customer_id=c.id LEFT JOIN stores s ON o.store_id=s.id WHERE o.id=$1`,
      [req.params.id]
    ),
    query(
      `SELECT oi.*, p.name as product_name, p.sku, pv.sku as variant_sku, b.code as bin_code
       FROM order_items oi JOIN products p ON oi.product_id=p.id
       LEFT JOIN product_variants pv ON oi.variant_id=pv.id LEFT JOIN bins b ON oi.bin_id=b.id
       WHERE oi.order_id=$1`, [req.params.id]
    )
  ]);
  if (!order.rows[0]) return res.status(404).json({ success: false, message: 'Order not found' });
  res.json({ success: true, data: { ...order.rows[0], items: items.rows } });
}));

router.post('/', asyncHandler(async (req, res) => {
  const { customer_id, customer, order_source, channel, store_id, items,
          payment_method, shipping_address, notes, shipping_charge } = req.body;
  const client = await getClient();
  try {
    await client.query('BEGIN');
    let custId = customer_id;
    if (!custId && customer) {
      const c = await client.query(
        'INSERT INTO customers (name,email,phone,address) VALUES ($1,$2,$3,$4) RETURNING id',
        [customer.name, customer.email, customer.phone, customer.address]
      );
      custId = c.rows[0].id;
    }
    let subtotal = 0;
    for (const item of items) {
      subtotal += item.unit_price * item.quantity * (1-(item.discount_percent||0)/100);
    }
    const total = subtotal + (shipping_charge||0);
    const order = await client.query(
      `INSERT INTO orders (order_number,order_source,channel,customer_id,store_id,status,payment_method,
        subtotal,shipping_charge,total_amount,shipping_address,notes)
       VALUES ($1,$2,$3,$4,$5,'pending',$6,$7,$8,$9,$10,$11) RETURNING *`,
      [genOrder(), order_source||'manual', channel, custId, store_id, payment_method,
       subtotal, shipping_charge||0, total, JSON.stringify(shipping_address||{}), notes]
    );
    for (const item of items) {
      const lineTotal = item.unit_price * item.quantity;
      await client.query(
        `INSERT INTO order_items (order_id,product_id,variant_id,bin_id,quantity,unit_price,discount_percent,line_total)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
        [order.rows[0].id, item.product_id, item.variant_id||null, item.bin_id||null,
         item.quantity, item.unit_price, item.discount_percent||0, lineTotal]
      );
    }
    await client.query('COMMIT');
    res.status(201).json({ success: true, data: order.rows[0] });
  } catch(e) { await client.query('ROLLBACK'); throw e; }
  finally { client.release(); }
}));

// Approve order → hold stock
router.patch('/:id/approve', asyncHandler(async (req, res) => {
  const client = await getClient();
  try {
    await client.query('BEGIN');
    const order = await client.query(
      `UPDATE orders SET status='approved',approved_at=NOW() WHERE id=$1 AND status='pending' RETURNING *`,
      [req.params.id]
    );
    if (!order.rows[0]) throw { statusCode:400, message:'Order not in pending state' };
    const items = await client.query('SELECT * FROM order_items WHERE order_id=$1', [req.params.id]);
    const storeId = order.rows[0].store_id;
    for (const item of items.rows) {
      // good_qty ↓, hold_qty ↑ — check availability first
      const stockCheck = await client.query(
        `SELECT COALESCE(good_qty, 0) as good_qty FROM stock WHERE product_id=$1 AND store_id=$2`,
        [item.product_id, storeId]
      );
      const available = parseInt(stockCheck.rows[0]?.good_qty || 0);
      if (available < item.quantity) {
        throw { statusCode: 400, message: `Insufficient stock. Available: ${available}, Required: ${item.quantity}` };
      }
      await client.query(
        `UPDATE stock
         SET good_qty = GREATEST(0, good_qty - $1),
             hold_qty = hold_qty + $1
         WHERE product_id=$2 AND store_id=$3`,
        [item.quantity, item.product_id, storeId]
      );
    }
    await client.query('COMMIT');
    res.json({ success: true, data: order.rows[0] });
  } catch(e) { await client.query('ROLLBACK'); throw e; }
  finally { client.release(); }
}));

// Move to packaging
router.patch('/:id/send-to-packaging', asyncHandler(async (req, res) => {
  const result = await query(
    `UPDATE orders SET status='packaging' WHERE id=$1 AND status='approved' RETURNING *`,
    [req.params.id]
  );
  res.json({ success: true, data: result.rows[0] });
}));

router.patch('/:id/cancel', asyncHandler(async (req, res) => {
  const client = await getClient();
  try {
    await client.query('BEGIN');
    const order = await client.query(
      `UPDATE orders SET status='cancelled',cancelled_at=NOW(),cancel_reason=$1 WHERE id=$2 AND status NOT IN ('shipped','delivered','cancelled') RETURNING *`,
      [req.body.reason, req.params.id]
    );
    if (!order.rows[0]) throw { statusCode:400, message:'Cannot cancel this order' };
    if (order.rows[0].status === 'approved') {
      const items = await client.query('SELECT * FROM order_items WHERE order_id=$1', [req.params.id]);
      for (const item of items.rows) {
        await client.query(
          `UPDATE stock SET good_qty = good_qty + $1, hold_qty = GREATEST(0, hold_qty - $1) WHERE product_id=$2 AND store_id=$3`,
          [item.quantity, item.product_id, order.rows[0].store_id]
        );
      }
    }
    await client.query('COMMIT');
    res.json({ success: true, data: order.rows[0] });
  } catch(e) { await client.query('ROLLBACK'); throw e; }
  finally { client.release(); }
}));

module.exports = router;