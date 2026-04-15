const express = require('express');
const router = express.Router();
const { query, getClient } = require('../../../config/database');
const { authenticate } = require('../../../middleware/auth');
const { asyncHandler } = require('../../../middleware/errorHandler');

router.use(authenticate);

router.get('/materials', asyncHandler(async (req, res) => {
  const result = await query('SELECT * FROM packaging_materials WHERE is_active=TRUE ORDER BY name');
  res.json({ success: true, data: result.rows });
}));

// Only show orders that don't have a package yet
router.get('/orders-pending', asyncHandler(async (req, res) => {
  const result = await query(
    `SELECT o.*, c.name as customer_name,
      (SELECT COUNT(*) FROM order_items WHERE order_id=o.id) as item_count
     FROM orders o LEFT JOIN customers c ON o.customer_id=c.id
     WHERE o.status='packaging'
     AND NOT EXISTS (SELECT 1 FROM packages WHERE order_id=o.id)
     ORDER BY o.created_at`
  );
  res.json({ success: true, data: result.rows });
}));

router.get('/', asyncHandler(async (req, res) => {
  const { status } = req.query;
  let sql = `SELECT pk.*, o.order_number, u.name as packed_by_name
    FROM packages pk JOIN orders o ON pk.order_id=o.id
    LEFT JOIN users u ON pk.packed_by=u.id WHERE 1=1`;
  const params = [];
  if (status) { sql += ` AND pk.status=$1`; params.push(status); }
  sql += ' ORDER BY pk.created_at DESC';
  const result = await query(sql, params);
  res.json({ success: true, data: result.rows });
}));

router.get('/:id', asyncHandler(async (req, res) => {
  const [pkg, items, materials] = await Promise.all([
    query(
      `SELECT pk.*, o.order_number, o.customer_id
       FROM packages pk JOIN orders o ON pk.order_id=o.id WHERE pk.id=$1`,
      [req.params.id]
    ),
    query(
      `SELECT pi.*, oi.quantity as ordered_qty, p.name as product_name, p.sku
       FROM package_items pi
       JOIN order_items oi ON pi.order_item_id=oi.id
       JOIN products p ON oi.product_id=p.id
       WHERE pi.package_id=$1`,
      [req.params.id]
    ),
    query(
      `SELECT pm.*, mat.name as material_name, mat.unit
       FROM package_materials pm
       JOIN packaging_materials mat ON pm.material_id=mat.id
       WHERE pm.package_id=$1`,
      [req.params.id]
    )
  ]);
  res.json({ success: true, data: { ...pkg.rows[0], items: items.rows, materials: materials.rows } });
}));

// Helper: deduct from bin_stock, never goes below 0
async function deductFromBins(client, productId, variantId, quantityToDeduct) {
  const binStocks = await client.query(
    `SELECT id, quantity FROM bin_stock
     WHERE product_id=$1
     AND (variant_id=$2 OR (variant_id IS NULL AND $2 IS NULL))
     AND quantity > 0
     ORDER BY quantity DESC`,
    [productId, variantId || null]
  );
  let remaining = quantityToDeduct;
  for (const bs of binStocks.rows) {
    if (remaining <= 0) break;
    const deduct = Math.min(remaining, parseInt(bs.quantity));
    await client.query(
      `UPDATE bin_stock SET quantity = GREATEST(0, quantity - $1), updated_at=NOW() WHERE id=$2`,
      [deduct, bs.id]
    );
    remaining -= deduct;
  }
}

// POST / — Create package with ALL order items, deduct bin stock immediately
router.post('/', asyncHandler(async (req, res) => {
  const { order_id, items, materials, weight_kg, notes } = req.body;

  if (!order_id) throw { statusCode: 400, message: 'order_id is required' };

  // Enforce: only ONE package per order
  const existingPkg = await query('SELECT id FROM packages WHERE order_id=$1', [order_id]);
  if (existingPkg.rows.length > 0) {
    throw { statusCode: 400, message: 'This order has already been packaged. Only one package per order is allowed.' };
  }

  const client = await getClient();
  try {
    await client.query('BEGIN');

    const order = (await client.query('SELECT * FROM orders WHERE id=$1', [order_id])).rows[0];
    if (!order) throw { statusCode: 404, message: 'Order not found' };

    // Always use ALL order items
    const oi = await client.query('SELECT * FROM order_items WHERE order_id=$1', [order_id]);
    const orderItems = oi.rows;

    // Pre-check: enough bin stock for all items
    for (const item of orderItems) {
      const binTotal = await client.query(
        `SELECT COALESCE(SUM(quantity), 0) as total FROM bin_stock
         WHERE product_id=$1
         AND (variant_id=$2 OR (variant_id IS NULL AND $2 IS NULL))
         AND quantity > 0`,
        [item.product_id, item.variant_id || null]
      );
      const available = parseInt(binTotal.rows[0].total);
      if (available < item.quantity) {
        const prod = await client.query('SELECT name, sku FROM products WHERE id=$1', [item.product_id]);
        throw {
          statusCode: 400,
          message: `Insufficient bin stock for "${prod.rows[0]?.name}" (${prod.rows[0]?.sku}). Available: ${available}, Required: ${item.quantity}`
        };
      }
    }

    const pkgNum = `PKG-${Date.now().toString().slice(-8)}`;
    const pkg = await client.query(
      `INSERT INTO packages (package_number, order_id, packed_by, status, weight_kg, notes)
       VALUES ($1,$2,$3,'pending',$4,$5) RETURNING *`,
      [pkgNum, order_id, req.user.id, weight_kg || null, notes || null]
    );

    // Insert package items + deduct bin stock
    for (const item of orderItems) {
      // Use provided serial numbers if sent, else empty
      const providedItem = (items || []).find(i => i.order_item_id === item.id);
      const serialNumbers = providedItem?.serial_numbers || [];

      await client.query(
        `INSERT INTO package_items (package_id, order_item_id, quantity, serial_numbers)
         VALUES ($1,$2,$3,$4)`,
        [pkg.rows[0].id, item.id, item.quantity, JSON.stringify(serialNumbers)]
      );

      // Deduct from bin_stock at packaging time
      await deductFromBins(client, item.product_id, item.variant_id, item.quantity);
    }

    // Packaging materials
    if (materials && materials.length > 0) {
      for (const mat of materials) {
        if (!mat.material_id) continue;
        await client.query(
          'INSERT INTO package_materials (package_id, material_id, quantity) VALUES ($1,$2,$3)',
          [pkg.rows[0].id, mat.material_id, mat.quantity || 1]
        );
        await client.query(
          `UPDATE packaging_materials
           SET stock_qty = GREATEST(0, stock_qty - $1)
           WHERE id=$2`,
          [mat.quantity || 1, mat.material_id]
        );
      }
    }

    await client.query('COMMIT');
    res.status(201).json({ success: true, data: pkg.rows[0] });
  } catch (e) {
    await client.query('ROLLBACK');
    throw e;
  } finally {
    client.release();
  }
}));

// Complete packaging: hold_qty↓ processing_qty↑ — never below 0
router.patch('/:id/complete', asyncHandler(async (req, res) => {
  const client = await getClient();
  try {
    await client.query('BEGIN');

    const pkg = await client.query(
      `UPDATE packages SET status='packed', packed_at=NOW()
       WHERE id=$1 AND status='pending' RETURNING *`,
      [req.params.id]
    );
    if (!pkg.rows[0]) throw { statusCode: 400, message: 'Package not in pending state' };

    const order = (await client.query('SELECT * FROM orders WHERE id=$1', [pkg.rows[0].order_id])).rows[0];
    const items = await client.query('SELECT * FROM order_items WHERE order_id=$1', [pkg.rows[0].order_id]);

    for (const item of items.rows) {
      await client.query(
        `UPDATE stock
         SET hold_qty       = GREATEST(0, hold_qty - $1),
             processing_qty = processing_qty + $1
         WHERE product_id=$2 AND store_id=$3`,
        [item.quantity, item.product_id, order.store_id]
      );
    }

    await client.query(`UPDATE orders SET status='processing', packed_at=NOW() WHERE id=$1`, [pkg.rows[0].order_id]);
    await client.query('COMMIT');
    res.json({ success: true, data: pkg.rows[0] });
  } catch (e) {
    await client.query('ROLLBACK');
    throw e;
  } finally {
    client.release();
  }
}));

// Master package + vehicle dispatch: processing_qty↓ only (bin already deducted)
router.post('/master-package', asyncHandler(async (req, res) => {
  const { vehicle_id, package_ids, notes } = req.body;
  if (!package_ids || package_ids.length === 0) {
    throw { statusCode: 400, message: 'Select at least one package' };
  }

  const client = await getClient();
  try {
    await client.query('BEGIN');

    const mpNum = `MP-${Date.now().toString().slice(-8)}`;
    const mp = await client.query(
      `INSERT INTO master_packages (mp_number, vehicle_id, created_by, status, notes)
       VALUES ($1,$2,$3,'loaded',$4) RETURNING *`,
      [mpNum, vehicle_id || null, req.user.id, notes || null]
    );

    for (const pkgId of package_ids) {
      await client.query(
        'INSERT INTO master_package_items (master_package_id, package_id) VALUES ($1,$2)',
        [mp.rows[0].id, pkgId]
      );

      const pkg = (await client.query('SELECT * FROM packages WHERE id=$1', [pkgId])).rows[0];
      if (!pkg) throw { statusCode: 404, message: `Package ${pkgId} not found` };

      const order = (await client.query('SELECT * FROM orders WHERE id=$1', [pkg.order_id])).rows[0];
      const items = await client.query('SELECT * FROM order_items WHERE order_id=$1', [pkg.order_id]);

      for (const item of items.rows) {
        // Only reduce processing_qty at dispatch — bin already deducted at package creation
        await client.query(
          `UPDATE stock
           SET processing_qty = GREATEST(0, processing_qty - $1)
           WHERE product_id=$2 AND store_id=$3`,
          [item.quantity, item.product_id, order.store_id]
        );

        await client.query(
          `INSERT INTO stock_movements
             (product_id, variant_id, movement_type, from_stock_type, quantity,
              reference_type, reference_id, created_by)
           VALUES ($1,$2,'outbound','processing',$3,'master_package',$4,$5)`,
          [item.product_id, item.variant_id || null, item.quantity, mp.rows[0].id, req.user.id]
        );
      }

      await client.query(`UPDATE orders SET status='shipped', shipped_at=NOW() WHERE id=$1`, [pkg.order_id]);
      await client.query(`UPDATE packages SET status='dispatched' WHERE id=$1`, [pkgId]);
    }

    await client.query(`UPDATE master_packages SET dispatched_at=NOW() WHERE id=$1`, [mp.rows[0].id]);
    await client.query('COMMIT');
    res.status(201).json({ success: true, data: mp.rows[0] });
  } catch (e) {
    await client.query('ROLLBACK');
    throw e;
  } finally {
    client.release();
  }
}));

router.get('/vehicles/list', asyncHandler(async (req, res) => {
  const result = await query('SELECT * FROM vehicles WHERE is_active=TRUE ORDER BY name');
  res.json({ success: true, data: result.rows });
}));

module.exports = router;