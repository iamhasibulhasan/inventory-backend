const express = require('express');
const router = express.Router();
const { query, getClient } = require('../../../config/database');
const { authenticate } = require('../../../middleware/auth');
const { asyncHandler } = require('../../../middleware/errorHandler');

router.use(authenticate);

router.get('/', asyncHandler(async (req, res) => {
  const { status } = req.query;
  let sql = `SELECT ib.*, po.po_number, s.name as store_name, u.name as received_by_name,
    (SELECT COUNT(*) FROM inbound_items WHERE inbound_id=ib.id) as item_count
    FROM inbounds ib JOIN purchase_orders po ON ib.po_id=po.id
    JOIN stores s ON ib.store_id=s.id LEFT JOIN users u ON ib.received_by=u.id WHERE 1=1`;
  const params = [];
  if (status) { sql += ` AND ib.status=$1`; params.push(status); }
  sql += ' ORDER BY ib.created_at DESC';
  const result = await query(sql, params);
  res.json({ success: true, data: result.rows });
}));

router.get('/:id', asyncHandler(async (req, res) => {
  const [ib, items] = await Promise.all([
    query(
      `SELECT ib.*, po.po_number, s.name as store_name
       FROM inbounds ib JOIN purchase_orders po ON ib.po_id=po.id
       JOIN stores s ON ib.store_id=s.id WHERE ib.id=$1`, [req.params.id]
    ),
    query(
      `SELECT ii.*, p.name as product_name, p.sku, p.has_expiry, p.has_serial,
        pv.sku as variant_sku
       FROM inbound_items ii JOIN products p ON ii.product_id=p.id
       LEFT JOIN product_variants pv ON ii.variant_id=pv.id WHERE ii.inbound_id=$1`,
      [req.params.id]
    )
  ]);
  // Also get PO items not yet added to inbound
  const poItems = await query(
    `SELECT poi.*, p.name as product_name, p.sku, p.has_expiry, p.has_serial
     FROM po_items poi JOIN products p ON poi.product_id=p.id
     WHERE poi.po_id=(SELECT po_id FROM inbounds WHERE id=$1)`,
    [req.params.id]
  );
  res.json({ success: true, data: { ...ib.rows[0], items: items.rows, po_items: poItems.rows } });
}));

// Add item to inbound (with expiry/serial)
router.post('/:id/items', asyncHandler(async (req, res) => {
  const { po_item_id, product_id, variant_id, received_quantity, expiry_date, serial_numbers, item_condition } = req.body;
  const result = await query(
    `INSERT INTO inbound_items (inbound_id,po_item_id,product_id,variant_id,received_quantity,expiry_date,serial_numbers,item_condition)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING *`,
    [req.params.id, po_item_id, product_id, variant_id||null, received_quantity,
     expiry_date||null, JSON.stringify(serial_numbers||[]), item_condition||'good']
  );
  // Update PO item received qty
  await query(
    'UPDATE po_items SET received_quantity=received_quantity+$1 WHERE id=$2',
    [received_quantity, po_item_id]
  );
  res.status(201).json({ success: true, data: result.rows[0] });
}));

// Complete inbound → increase stock, set pending_stack
router.patch('/:id/complete', asyncHandler(async (req, res) => {
  const client = await getClient();
  try {
    await client.query('BEGIN');
    const ib = (await client.query('SELECT * FROM inbounds WHERE id=$1', [req.params.id])).rows[0];
    if (!ib) throw { statusCode:404, message:'Inbound not found' };
    if (ib.status !== 'in_progress') throw { statusCode:400, message:'Inbound already completed' };

    const items = await client.query('SELECT * FROM inbound_items WHERE inbound_id=$1', [req.params.id]);
    for (const item of items.rows) {
      // Upsert stock
      await client.query(
        `INSERT INTO stock (product_id,variant_id,store_id,good_qty)
         VALUES ($1,$2,$3,$4)
         ON CONFLICT DO NOTHING`,
        [item.product_id, item.variant_id, ib.store_id, 0]
      );
      const field = item.item_condition === 'damaged' ? 'damage_qty' : item.item_condition === 'expired' ? 'expired_qty' : 'good_qty';
      await client.query(
        `UPDATE stock SET ${field}=${field}+$1 WHERE product_id=$2 AND COALESCE(variant_id::text,'')=COALESCE($3::text,'') AND store_id=$4`,
        [item.received_quantity, item.product_id, item.variant_id, ib.store_id]
      );
      // Log movement
      await client.query(
        `INSERT INTO stock_movements (product_id,variant_id,to_store_id,movement_type,to_stock_type,quantity,reference_type,reference_id,created_by)
         VALUES ($1,$2,$3,'inbound',$4,$5,'inbound',$6,$7)`,
        [item.product_id, item.variant_id, ib.store_id, field.replace('_qty',''), item.received_quantity, ib.id, req.user.id]
      );
    }

    await client.query(
      `UPDATE inbounds SET status='pending_stack',completed_at=NOW() WHERE id=$1`,
      [req.params.id]
    );
    await client.query(
      `UPDATE purchase_orders SET status='inbound' WHERE id=$1`,
      [ib.po_id]
    );
    await client.query('COMMIT');
    res.json({ success: true, message: 'Inbound completed. Products are now pending for stack.' });
  } catch(e) { await client.query('ROLLBACK'); throw e; }
  finally { client.release(); }
}));

module.exports = router;
