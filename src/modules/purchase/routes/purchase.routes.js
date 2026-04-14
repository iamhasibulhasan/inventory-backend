const express = require('express');
const router = express.Router();
const { query, getClient } = require('../../../config/database');
const { authenticate } = require('../../../middleware/auth');
const { asyncHandler } = require('../../../middleware/errorHandler');

router.use(authenticate);
const genPR = () => `PR-${Date.now().toString().slice(-8)}`;

router.get('/', asyncHandler(async (req, res) => {
  const { status } = req.query;
  let sql = `SELECT pr.*, s.name as supplier_name, u.name as requested_by_name, a.name as approved_by_name,
    (SELECT COUNT(*) FROM requisition_items WHERE pr_id=pr.id) as item_count
    FROM purchase_requisitions pr
    JOIN suppliers s ON pr.supplier_id=s.id
    LEFT JOIN users u ON pr.requested_by=u.id LEFT JOIN users a ON pr.approved_by=a.id WHERE 1=1`;
  const params = [];
  if (status) { sql += ` AND pr.status=$1`; params.push(status); }
  sql += ' ORDER BY pr.created_at DESC';
  const result = await query(sql, params);
  res.json({ success: true, data: result.rows });
}));

router.get('/:id', asyncHandler(async (req, res) => {
  const [pr, items] = await Promise.all([
    query(
      `SELECT pr.*, s.name as supplier_name, u.name as requested_by_name
       FROM purchase_requisitions pr JOIN suppliers s ON pr.supplier_id=s.id
       LEFT JOIN users u ON pr.requested_by=u.id WHERE pr.id=$1`, [req.params.id]
    ),
    query(
      `SELECT ri.*, p.name as product_name, p.sku, pv.sku as variant_sku
       FROM requisition_items ri JOIN products p ON ri.product_id=p.id
       LEFT JOIN product_variants pv ON ri.variant_id=pv.id WHERE ri.pr_id=$1`,
      [req.params.id]
    )
  ]);
  if (!pr.rows[0]) return res.status(404).json({ success: false, message: 'PR not found' });
  res.json({ success: true, data: { ...pr.rows[0], items: items.rows } });
}));

router.post('/', asyncHandler(async (req, res) => {
  const { supplier_id, items, notes, required_date, priority } = req.body;
  if (!supplier_id || !items?.length) return res.status(400).json({ success: false, message: 'Supplier and items required' });
  const pr = await query(
    `INSERT INTO purchase_requisitions (pr_number,supplier_id,requested_by,status,priority,required_date,notes)
     VALUES ($1,$2,$3,'draft',$4,$5,$6) RETURNING *`,
    [genPR(), supplier_id, req.user.id, priority||'normal', required_date, notes]
  );
  for (const item of items) {
    await query(
      'INSERT INTO requisition_items (pr_id,product_id,variant_id,requested_quantity,unit_price) VALUES ($1,$2,$3,$4,$5)',
      [pr.rows[0].id, item.product_id, item.variant_id||null, item.quantity, item.unit_price||0]
    );
  }
  res.status(201).json({ success: true, data: pr.rows[0] });
}));

router.patch('/:id/submit', asyncHandler(async (req, res) => {
  const result = await query(
    `UPDATE purchase_requisitions SET status='pending' WHERE id=$1 AND status='draft' RETURNING *`,
    [req.params.id]
  );
  if (!result.rows[0]) return res.status(400).json({ success: false, message: 'PR not in draft state' });
  res.json({ success: true, data: result.rows[0] });
}));

router.patch('/:id/approve', asyncHandler(async (req, res) => {
  const client = await getClient();
  try {
    await client.query('BEGIN');
    const pr = await client.query(
      `UPDATE purchase_requisitions SET status='approved',approved_by=$1,approved_at=NOW() WHERE id=$2 AND status='pending' RETURNING *`,
      [req.user.id, req.params.id]
    );
    if (!pr.rows[0]) throw { statusCode:400, message:'PR not in pending state' };
    // Auto-create Purchase Order
    const prData = pr.rows[0];
    const items = await client.query('SELECT * FROM requisition_items WHERE pr_id=$1', [req.params.id]);
    let subtotal = 0;
    items.rows.forEach(i => { subtotal += (i.unit_price||0) * i.requested_quantity; });
    const vat = subtotal * 0.15;
    const total = subtotal + vat;
    const poNum = `PO-${Date.now().toString().slice(-8)}`;
    const po = await client.query(
      `INSERT INTO purchase_orders (po_number,pr_id,supplier_id,created_by,status,subtotal,vat_amount,total_amount)
       VALUES ($1,$2,$3,$4,'pending',$5,$6,$7) RETURNING *`,
      [poNum, req.params.id, prData.supplier_id, req.user.id, subtotal, vat, total]
    );
    for (const item of items.rows) {
      await client.query(
        'INSERT INTO po_items (po_id,product_id,variant_id,ordered_quantity,unit_price,line_total) VALUES ($1,$2,$3,$4,$5,$6)',
        [po.rows[0].id, item.product_id, item.variant_id, item.requested_quantity, item.unit_price||0,
         (item.unit_price||0)*item.requested_quantity]
      );
    }
    await client.query(`UPDATE purchase_requisitions SET status='converted' WHERE id=$1`, [req.params.id]);
    await client.query('COMMIT');
    res.json({ success: true, data: { pr: pr.rows[0], po: po.rows[0] }, message: 'PR approved and PO created' });
  } catch(e) { await client.query('ROLLBACK'); throw e; }
  finally { client.release(); }
}));

router.patch('/:id/reject', asyncHandler(async (req, res) => {
  const result = await query(
    `UPDATE purchase_requisitions SET status='rejected',approved_by=$1,approved_at=NOW(),rejected_reason=$2 WHERE id=$3 RETURNING *`,
    [req.user.id, req.body.reason||'', req.params.id]
  );
  res.json({ success: true, data: result.rows[0] });
}));

module.exports = router;
