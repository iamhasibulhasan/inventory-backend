const express = require('express');
const router = express.Router();
const { query, getClient } = require('../../../config/database');
const { authenticate } = require('../../../middleware/auth');
const { asyncHandler } = require('../../../middleware/errorHandler');

router.use(authenticate);

router.get('/', asyncHandler(async (req, res) => {
  const { status } = req.query;
  let sql = `SELECT po.*, s.name as supplier_name, u.name as created_by_name, st.name as store_name
    FROM purchase_orders po
    JOIN suppliers s ON po.supplier_id=s.id
    LEFT JOIN users u ON po.created_by=u.id
    LEFT JOIN stores st ON po.store_id=st.id WHERE 1=1`;
  const params = [];
  if (status) { sql += ` AND po.status=$1`; params.push(status); }
  sql += ' ORDER BY po.created_at DESC';
  const result = await query(sql, params);
  res.json({ success: true, data: result.rows });
}));

router.get('/:id', asyncHandler(async (req, res) => {
  const [po, items] = await Promise.all([
    query(
      `SELECT po.*, s.name as supplier_name, s.email as supplier_email, s.phone as supplier_phone,
        u.name as created_by_name, st.name as store_name
       FROM purchase_orders po JOIN suppliers s ON po.supplier_id=s.id
       LEFT JOIN users u ON po.created_by=u.id LEFT JOIN stores st ON po.store_id=st.id WHERE po.id=$1`,
      [req.params.id]
    ),
    query(
      `SELECT poi.*, p.name as product_name, p.sku, pv.sku as variant_sku
       FROM po_items poi JOIN products p ON poi.product_id=p.id
       LEFT JOIN product_variants pv ON poi.variant_id=pv.id WHERE poi.po_id=$1`,
      [req.params.id]
    )
  ]);
  if (!po.rows[0]) return res.status(404).json({ success: false, message: 'PO not found' });
  res.json({ success: true, data: { ...po.rows[0], items: items.rows } });
}));

// Admin approve PO
router.patch('/:id/approve', asyncHandler(async (req, res) => {
  const result = await query(
    `UPDATE purchase_orders SET status='approved',approved_by=$1,approved_at=NOW() WHERE id=$2 AND status='pending' RETURNING *`,
    [req.user.id, req.params.id]
  );
  if (!result.rows[0]) return res.status(400).json({ success: false, message: 'PO not in pending state' });
  res.json({ success: true, data: result.rows[0], message: 'PO approved and sent to operations' });
}));

// Operations team approve → move to inbound
router.patch('/:id/operations-approve', asyncHandler(async (req, res) => {
  const { store_id } = req.body;
  const client = await getClient();
  try {
    await client.query('BEGIN');
    const po = await client.query(
      `UPDATE purchase_orders SET status='operations_approved',operations_approved_by=$1,operations_approved_at=NOW(),store_id=$2
       WHERE id=$3 AND status='approved' RETURNING *`,
      [req.user.id, store_id, req.params.id]
    );
    if (!po.rows[0]) throw { statusCode:400, message:'PO not in approved state' };
    // Auto-create inbound record
    const inboundNum = `INB-${Date.now().toString().slice(-8)}`;
    const inb = await client.query(
      `INSERT INTO inbounds (inbound_number,po_id,store_id,received_by,status)
       VALUES ($1,$2,$3,$4,'in_progress') RETURNING *`,
      [inboundNum, req.params.id, store_id||po.rows[0].store_id, req.user.id]
    );
    await client.query('COMMIT');
    res.json({ success: true, data: { po: po.rows[0], inbound: inb.rows[0] }, message: 'Moved to Inbound' });
  } catch(e) { await client.query('ROLLBACK'); throw e; }
  finally { client.release(); }
}));

router.patch('/:id/cancel', asyncHandler(async (req, res) => {
  const result = await query(
    `UPDATE purchase_orders SET status='cancelled' WHERE id=$1 AND status NOT IN ('completed','cancelled') RETURNING *`,
    [req.params.id]
  );
  res.json({ success: true, data: result.rows[0] });
}));

module.exports = router;
