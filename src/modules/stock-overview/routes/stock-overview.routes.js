const express = require('express');
const router = express.Router();
const { query } = require('../../../config/database');
const { authenticate } = require('../../../middleware/auth');
const { asyncHandler } = require('../../../middleware/errorHandler');

router.use(authenticate);

// Full stock overview
router.get('/', asyncHandler(async (req, res) => {
  const { store_id, search, low_stock } = req.query;
  let conditions = ['p.is_active=TRUE'];
  const params = [];
  let i = 1;
  if (search) { conditions.push(`(p.name ILIKE $${i} OR p.sku ILIKE $${i})`); params.push(`%${search}%`); i++; }
  if (store_id) { conditions.push(`st.store_id=$${i++}`); params.push(store_id); }

  const result = await query(
    `SELECT p.id, p.name, p.sku, p.min_stock_level, cat.name as category_name,
      COALESCE(SUM(st.good_qty),0) as good_qty,
      COALESCE(SUM(st.damage_qty),0) as damage_qty,
      COALESCE(SUM(st.expired_qty),0) as expired_qty,
      COALESCE(SUM(st.lost_qty),0) as lost_qty,
      COALESCE(SUM(st.scrap_qty),0) as scrap_qty,
      COALESCE(SUM(st.hold_qty),0) as hold_qty,
      COALESCE(SUM(st.processing_qty),0) as processing_qty,
      COALESCE(SUM(st.good_qty+st.damage_qty+st.expired_qty+st.lost_qty+st.scrap_qty),0) as total_qty
     FROM products p
     LEFT JOIN stock st ON p.id=st.product_id
     LEFT JOIN categories cat ON p.category_id=cat.id
     WHERE ${conditions.join(' AND ')}
     GROUP BY p.id, p.name, p.sku, p.min_stock_level, cat.name
     ${low_stock==='true' ? 'HAVING COALESCE(SUM(st.good_qty),0) <= p.min_stock_level' : ''}
     ORDER BY p.name`,
    params
  );
  res.json({ success: true, data: result.rows });
}));

// Bin-wise stock for a product
router.get('/product/:productId/bins', asyncHandler(async (req, res) => {
  const result = await query(
    `SELECT bs.*, b.code as bin_code, b.name as bin_name, b.bin_type,
      r.name as row_name, rk.name as rack_name, rm.name as room_name, f.name as floor_name, s.name as store_name,
      COALESCE(pv.sku, p.sku) as item_sku
     FROM bin_stock bs
     JOIN bins b ON bs.bin_id=b.id
     JOIN rows r ON b.row_id=r.id
     JOIN racks rk ON r.rack_id=rk.id
     JOIN rooms rm ON rk.room_id=rm.id
     JOIN floors f ON rm.floor_id=f.id
     JOIN stores s ON f.store_id=s.id
     JOIN products p ON bs.product_id=p.id
     LEFT JOIN product_variants pv ON bs.variant_id=pv.id
     WHERE bs.product_id=$1 AND bs.quantity > 0
     ORDER BY b.code`,
    [req.params.productId]
  );
  res.json({ success: true, data: result.rows });
}));

// Bin detail - what's in a specific bin
router.get('/bin/:binId', asyncHandler(async (req, res) => {
  const [bin, stock] = await Promise.all([
    query(
      `SELECT b.*, r.name as row_name, rk.name as rack_name, rm.name as room_name,
        f.name as floor_name, s.name as store_name
       FROM bins b JOIN rows r ON b.row_id=r.id JOIN racks rk ON r.rack_id=rk.id
       JOIN rooms rm ON rk.room_id=rm.id JOIN floors f ON rm.floor_id=f.id JOIN stores s ON f.store_id=s.id
       WHERE b.id=$1`, [req.params.binId]
    ),
    query(
      `SELECT bs.*, p.name as product_name, p.sku, pv.sku as variant_sku
       FROM bin_stock bs JOIN products p ON bs.product_id=p.id
       LEFT JOIN product_variants pv ON bs.variant_id=pv.id
       WHERE bs.bin_id=$1 AND bs.quantity > 0`,
      [req.params.binId]
    )
  ]);
  res.json({ success: true, data: { ...bin.rows[0], stock: stock.rows } });
}));

// Warehouse mapping view - all bins with stock info
router.get('/warehouse-map/:storeId', asyncHandler(async (req, res) => {
  const result = await query(
    `SELECT b.id, b.name, b.code, b.bin_type, b.max_capacity, b.position_x, b.position_y,
      r.name as row_name, r.id as row_id,
      rk.name as rack_name, rk.id as rack_id, rk.code as rack_code,
      rm.name as room_name, rm.id as room_id,
      f.name as floor_name, f.id as floor_id,
      COALESCE((SELECT SUM(bs.quantity) FROM bin_stock bs WHERE bs.bin_id=b.id),0) as total_stock,
      (SELECT COUNT(*) FROM bin_stock bs WHERE bs.bin_id=b.id AND bs.quantity>0) as product_count
     FROM bins b
     JOIN rows r ON b.row_id=r.id
     JOIN racks rk ON r.rack_id=rk.id
     JOIN rooms rm ON rk.room_id=rm.id
     JOIN floors f ON rm.floor_id=f.id
     WHERE f.store_id=$1 AND b.is_active=TRUE
     ORDER BY f.floor_number, rm.name, rk.name, r.name, b.position_x, b.position_y`,
    [req.params.storeId]
  );
  res.json({ success: true, data: result.rows });
}));

// Stock movements history
router.get('/movements', asyncHandler(async (req, res) => {
  const { product_id, store_id, limit=50 } = req.query;
  let conditions = ['1=1'];
  const params = [];
  let i = 1;
  if (product_id) { conditions.push(`sm.product_id=$${i++}`); params.push(product_id); }
  if (store_id) { conditions.push(`(sm.from_store_id=$${i} OR sm.to_store_id=$${i})`); params.push(store_id); i++; }
  const result = await query(
    `SELECT sm.*, p.name as product_name, p.sku, u.name as created_by_name,
      fb.code as from_bin_code, tb.code as to_bin_code
     FROM stock_movements sm JOIN products p ON sm.product_id=p.id
     LEFT JOIN users u ON sm.created_by=u.id
     LEFT JOIN bins fb ON sm.from_bin_id=fb.id LEFT JOIN bins tb ON sm.to_bin_id=tb.id
     WHERE ${conditions.join(' AND ')} ORDER BY sm.created_at DESC LIMIT $${i}`,
    [...params, limit]
  );
  res.json({ success: true, data: result.rows });
}));

module.exports = router;
