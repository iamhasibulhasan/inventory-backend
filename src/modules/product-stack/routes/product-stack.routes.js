const express = require('express');
const router = express.Router();
const { query, getClient } = require('../../../config/database');
const { authenticate } = require('../../../middleware/auth');
const { asyncHandler } = require('../../../middleware/errorHandler');

router.use(authenticate);

// 1. ROOT — list all stacks (with optional status filter)
router.get('/', asyncHandler(async (req, res) => {
  const { status } = req.query;
  let where = '';
  const values = [];
  if (status) { where = 'WHERE ps.status = $1'; values.push(status); }

  const result = await query(
    `SELECT ps.*, p.name as product_name, p.sku,
       b.code as bin_code, b.name as bin_name, b.bin_type,
       ib.inbound_number, s.name as store_name,
       u.name as stacked_by_name
     FROM product_stacks ps
     JOIN products p ON ps.product_id = p.id
     JOIN bins b ON ps.bin_id = b.id
     LEFT JOIN inbounds ib ON ps.inbound_id = ib.id
     LEFT JOIN stores s ON s.id = ib.store_id
     LEFT JOIN users u ON ps.stacked_by = u.id
     ${where}
     ORDER BY ps.created_at DESC`,
    values
  );
  res.json({ success: true, data: result.rows });
}));

// 2. Pending stacks
router.get('/pending', asyncHandler(async (req, res) => {
  const result = await query(
    `SELECT ps.*, p.name as product_name, p.sku,
       ib.inbound_number, s.name as store_name
     FROM product_stacks ps
     JOIN products p ON ps.product_id = p.id
     LEFT JOIN inbounds ib ON ps.inbound_id = ib.id
     LEFT JOIN stores s ON s.id = ib.store_id
     WHERE ps.status = 'pending'
     ORDER BY ps.created_at`
  );
  res.json({ success: true, data: result.rows });
}));

// 3. Items from completed inbounds waiting to be stacked
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
         (SELECT SUM(ps.quantity)
          FROM product_stacks ps
          WHERE ps.product_id = ii.product_id
            AND ps.inbound_id = ii.inbound_id
         ), 0
       ) as stacked_qty
     FROM inbound_items ii
     JOIN inbounds ib ON ii.inbound_id = ib.id
     JOIN products p ON ii.product_id = p.id
     JOIN stores s ON ib.store_id = s.id
     WHERE ib.status = 'pending_stack'
     ORDER BY ib.created_at`
  );

  // Only return items that still need stacking
  const pending = result.rows.filter(r =>
    parseInt(r.received_quantity) > parseInt(r.stacked_qty)
  );
  res.json({ success: true, data: pending });
}));

// 4. Get available bins for a store
router.get('/bins/:store_id', asyncHandler(async (req, res) => {
  const result = await query(
    `SELECT b.*,
       r.name as row_name, rk.name as rack_name,
       rm.name as room_name, f.name as floor_name,
       COALESCE(
         (SELECT SUM(bs.quantity) FROM bin_stock bs WHERE bs.bin_id = b.id), 0
       ) as current_stock
     FROM bins b
     JOIN rows r ON b.row_id = r.id
     JOIN racks rk ON r.rack_id = rk.id
     JOIN rooms rm ON rk.room_id = rm.id
     JOIN floors f ON rm.floor_id = f.id
     WHERE f.store_id = $1
       AND b.is_active = TRUE
       AND b.bin_type = 'good'
     ORDER BY b.code`,
    [req.params.store_id]
  );
  res.json({ success: true, data: result.rows });
}));

// 5. Stack a product into a bin
router.post('/', asyncHandler(async (req, res) => {
  const { inbound_id, product_id, variant_id, bin_id, quantity, notes } = req.body;

  if (!product_id || !bin_id || !quantity || quantity <= 0) {
    throw { statusCode: 400, message: 'product_id, bin_id and a positive quantity are required' };
  }

  const client = await getClient();
  try {
    await client.query('BEGIN');

    // Validate bin exists
    const bin = (await client.query('SELECT * FROM bins WHERE id=$1', [bin_id])).rows[0];
    if (!bin) throw { statusCode: 404, message: 'Bin not found' };
    if (!bin.is_active) throw { statusCode: 400, message: 'Bin is not active' };

    // Check bin capacity
    const currentStock = parseInt(
      (await client.query(
        'SELECT COALESCE(SUM(quantity),0) as total FROM bin_stock WHERE bin_id=$1',
        [bin_id]
      )).rows[0].total
    );
    if (bin.max_capacity && (currentStock + quantity) > bin.max_capacity) {
      throw {
        statusCode: 400,
        message: `Bin capacity exceeded. Available space: ${bin.max_capacity - currentStock} units`
      };
    }

    // If linked to an inbound — validate quantity not overstacked
    if (inbound_id) {
      const inboundItem = await client.query(
        `SELECT ii.received_quantity,
           COALESCE(
             (SELECT SUM(ps.quantity) FROM product_stacks ps
              WHERE ps.product_id=$1 AND ps.inbound_id=$2), 0
           ) as already_stacked
         FROM inbound_items ii
         WHERE ii.inbound_id=$2 AND ii.product_id=$1`,
        [product_id, inbound_id]
      );
      if (inboundItem.rows.length > 0) {
        const maxStackable = parseInt(inboundItem.rows[0].received_quantity) -
                             parseInt(inboundItem.rows[0].already_stacked);
        if (quantity > maxStackable) {
          throw {
            statusCode: 400,
            message: `Cannot stack more than received. Max stackable: ${maxStackable}`
          };
        }
      }
    }

    // Create stack record
    const stackNum = `STK-${Date.now().toString().slice(-8)}`;
    const stack = await client.query(
      `INSERT INTO product_stacks
         (stack_number, inbound_id, product_id, variant_id, bin_id,
          quantity, stacked_by, status, stacked_at, notes)
       VALUES ($1,$2,$3,$4,$5,$6,$7,'stacked',NOW(),$8)
       RETURNING *`,
      [stackNum, inbound_id || null, product_id, variant_id || null,
       bin_id, quantity, req.user.id, notes || null]
    );

    // Upsert bin_stock (never goes below 0)
    const existingBinStock = await client.query(
      `SELECT id FROM bin_stock
       WHERE bin_id=$1 AND product_id=$2
       AND (variant_id=$3 OR (variant_id IS NULL AND $3 IS NULL))`,
      [bin_id, product_id, variant_id || null]
    );
    if (existingBinStock.rows.length > 0) {
      await client.query(
        `UPDATE bin_stock
         SET quantity = quantity + $1, updated_at = NOW()
         WHERE bin_id=$2 AND product_id=$3
         AND (variant_id=$4 OR (variant_id IS NULL AND $4 IS NULL))`,
        [quantity, bin_id, product_id, variant_id || null]
      );
    } else {
      await client.query(
        `INSERT INTO bin_stock (bin_id, product_id, variant_id, quantity)
         VALUES ($1,$2,$3,$4)`,
        [bin_id, product_id, variant_id || null, quantity]
      );
    }

    // Log movement
    await client.query(
      `INSERT INTO stock_movements
         (product_id, variant_id, to_bin_id, movement_type, to_stock_type,
          quantity, reference_type, reference_id, created_by)
       VALUES ($1,$2,$3,'stack','good',$4,'product_stack',$5,$6)`,
      [product_id, variant_id || null, bin_id, quantity, stack.rows[0].id, req.user.id]
    );

    // Check if ALL items from this inbound are fully stacked → mark inbound completed
    if (inbound_id) {
      const check = await client.query(
        `SELECT
           SUM(ii.received_quantity) as total_received,
           COALESCE(
             (SELECT SUM(ps2.quantity)
              FROM product_stacks ps2
              WHERE ps2.inbound_id=$1), 0
           ) as total_stacked
         FROM inbound_items ii
         WHERE ii.inbound_id=$1`,
        [inbound_id]
      );
      const totalReceived = parseInt(check.rows[0].total_received || 0);
      const totalStacked = parseInt(check.rows[0].total_stacked || 0);
      if (totalStacked >= totalReceived && totalReceived > 0) {
        await client.query(
          `UPDATE inbounds SET status='completed' WHERE id=$1`,
          [inbound_id]
        );
      }
    }

    await client.query('COMMIT');
    res.status(201).json({ success: true, data: stack.rows[0] });
  } catch (e) {
    await client.query('ROLLBACK');
    throw e;
  } finally {
    client.release();
  }
}));

module.exports = router;