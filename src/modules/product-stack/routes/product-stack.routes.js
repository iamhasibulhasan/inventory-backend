const express = require('express');
const router = express.Router();
const { query, getClient } = require('../../../config/database');
const { authenticate } = require('../../../middleware/auth');
const { asyncHandler } = require('../../../middleware/errorHandler');

router.use(authenticate);

// Get pending stacks
router.get('/pending', asyncHandler(async (req, res) => {
  const result = await query(
    `SELECT ps.*, p.name as product_name, p.sku,
      ib.inbound_number, s.name as store_name
     FROM product_stacks ps
     JOIN products p ON ps.product_id=p.id
     LEFT JOIN inbounds ib ON ps.inbound_id=ib.id
     LEFT JOIN stores s ON s.id=(SELECT store_id FROM inbounds WHERE id=ps.inbound_id)
     WHERE ps.status='pending' ORDER BY ps.created_at`
  );
  res.json({ success: true, data: result.rows });
}));

// Get all stacks (stacked)
router.get('/inbound-pending', asyncHandler(async (req, res) => {
  const result = await query(
    `SELECT
      ii.inbound_id,
      ii.product_id,
      ii.variant_id,
      ii.received_quantity,
      p.name as product_name,
      p.sku,
      ib.inbound_number,
      ib.store_id,
      s.name as store_name,
      COALESCE(
        (SELECT SUM(ps.quantity) FROM product_stacks ps
         WHERE ps.product_id = ii.product_id
           AND ps.inbound_id = ii.inbound_id), 0
      ) as stacked_qty
     FROM inbound_items ii
     JOIN inbounds ib ON ii.inbound_id = ib.id
     JOIN products p ON ii.product_id = p.id
     JOIN stores s ON ib.store_id = s.id
     WHERE ib.status = 'pending_stack'
     ORDER BY ib.created_at`
  );
  // Filter to only items that still need stacking
  const pending = result.rows.filter(r =>
    parseInt(r.received_quantity) > parseInt(r.stacked_qty)
  );
  res.json({ success: true, data: pending });
}));

// Get available bins for a store
router.get('/bins/:store_id', asyncHandler(async (req, res) => {
  const result = await query(
    `SELECT b.*, r.name as row_name, rk.name as rack_name, rm.name as room_name, f.name as floor_name,
      COALESCE((SELECT SUM(bs.quantity) FROM bin_stock bs WHERE bs.bin_id=b.id), 0) as current_stock
     FROM bins b
     JOIN rows r ON b.row_id=r.id
     JOIN racks rk ON r.rack_id=rk.id
     JOIN rooms rm ON rk.room_id=rm.id
     JOIN floors f ON rm.floor_id=f.id
     WHERE f.store_id=$1 AND b.is_active=TRUE AND b.bin_type='good'
     ORDER BY b.code`,
    [req.params.store_id]
  );
  res.json({ success: true, data: result.rows });
}));

// Stack a product into a bin
router.post('/', asyncHandler(async (req, res) => {
  const { inbound_id, product_id, variant_id, bin_id, quantity, notes } = req.body;
  const client = await getClient();
  try {
    await client.query('BEGIN');

    // Check bin capacity
    const bin = (await client.query('SELECT * FROM bins WHERE id=$1', [bin_id])).rows[0];
    if (!bin) throw { statusCode:404, message:'Bin not found' };
    const currentStock = (await client.query(
      'SELECT COALESCE(SUM(quantity),0) as total FROM bin_stock WHERE bin_id=$1', [bin_id]
    )).rows[0].total;
    if (bin.max_capacity && (parseInt(currentStock) + quantity) > bin.max_capacity) {
      throw { statusCode:400, message:`Bin capacity exceeded. Available: ${bin.max_capacity - currentStock}` };
    }

    const stackNum = `STK-${Date.now().toString().slice(-8)}`;
    const stack = await client.query(
      `INSERT INTO product_stacks (stack_number,inbound_id,product_id,variant_id,bin_id,quantity,stacked_by,status,stacked_at,notes)
       VALUES ($1,$2,$3,$4,$5,$6,$7,'stacked',NOW(),$8) RETURNING *`,
      [stackNum, inbound_id||null, product_id, variant_id||null, bin_id, quantity, req.user.id, notes]
    );

 // Update bin_stock (upsert manually)
const existingBinStock = await client.query(
  `SELECT id FROM bin_stock WHERE bin_id=$1 AND product_id=$2
   AND (variant_id=$3 OR (variant_id IS NULL AND $3 IS NULL))`,
  [bin_id, product_id, variant_id||null]
);
if (existingBinStock.rows.length > 0) {
  await client.query(
    `UPDATE bin_stock SET quantity=quantity+$1, updated_at=NOW()
     WHERE bin_id=$2 AND product_id=$3
     AND (variant_id=$4 OR (variant_id IS NULL AND $4 IS NULL))`,
    [quantity, bin_id, product_id, variant_id||null]
  );
} else {
  await client.query(
    `INSERT INTO bin_stock (bin_id,product_id,variant_id,quantity)
     VALUES ($1,$2,$3,$4)`,
    [bin_id, product_id, variant_id||null, quantity]
  );
}

    // Log movement
    await client.query(
      `INSERT INTO stock_movements (product_id,variant_id,to_bin_id,movement_type,to_stock_type,quantity,reference_type,reference_id,created_by)
       VALUES ($1,$2,$3,'stack','good',$4,'product_stack',$5,$6)`,
      [product_id, variant_id||null, bin_id, quantity, stack.rows[0].id, req.user.id]
    );

    await client.query('COMMIT');
    res.status(201).json({ success: true, data: stack.rows[0] });
  } catch(e) { await client.query('ROLLBACK'); throw e; }
  finally { client.release(); }
}));

// Get products pending for stacking (from completed inbounds)
router.get('/inbound-pending', asyncHandler(async (req, res) => {
  const result = await query(
    `SELECT ii.*, p.name as product_name, p.sku, ib.inbound_number, s.name as store_name,
      ib.store_id,
      COALESCE(
        (SELECT SUM(ps.quantity) FROM product_stacks ps WHERE ps.product_id=ii.product_id AND ps.inbound_id=ii.inbound_id),0
      ) as stacked_qty
     FROM inbound_items ii
     JOIN inbounds ib ON ii.inbound_id=ib.id
     JOIN products p ON ii.product_id=p.id
     JOIN stores s ON ib.store_id=s.id
     WHERE ib.status='pending_stack'
     HAVING ii.received_quantity > COALESCE(
       (SELECT SUM(ps.quantity) FROM product_stacks ps WHERE ps.product_id=ii.product_id AND ps.inbound_id=ii.inbound_id),0
     )
     ORDER BY ib.created_at`
  );
  res.json({ success: true, data: result.rows });
}));

module.exports = router;
