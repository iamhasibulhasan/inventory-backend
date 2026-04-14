// ===== DAMAGE ROUTES =====
const express = require('express');
const router = express.Router();
const { query, getClient } = require('../../../config/database');
const { authenticate } = require('../../../middleware/auth');
const { asyncHandler } = require('../../../middleware/errorHandler');
router.use(authenticate);

const genDmg = () => `DMG-${Date.now().toString().slice(-8)}`;

router.get('/', asyncHandler(async (req, res) => {
  const { status } = req.query;
  let sql = `SELECT dl.*, p.name as product_name, p.sku,
    fb.code as from_bin_code, tb.code as to_bin_code,
    u.name as declared_by_name, a.name as approved_by_name
    FROM damage_logs dl JOIN products p ON dl.product_id=p.id
    LEFT JOIN bins fb ON dl.from_bin_id=fb.id LEFT JOIN bins tb ON dl.to_bin_id=tb.id
    LEFT JOIN users u ON dl.declared_by=u.id LEFT JOIN users a ON dl.approved_by=a.id WHERE 1=1`;
  const params = [];
  if (status) { sql += ` AND dl.status=$1`; params.push(status); }
  sql += ' ORDER BY dl.created_at DESC';
  const result = await query(sql, params);
  res.json({ success: true, data: result.rows });
}));

router.post('/', asyncHandler(async (req, res) => {
  const { product_id, variant_id, from_bin_id, to_bin_id, quantity, damage_type, reason } = req.body;
  const result = await query(
    `INSERT INTO damage_logs (damage_number,product_id,variant_id,from_bin_id,to_bin_id,quantity,damage_type,reason,declared_by,status)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,'pending') RETURNING *`,
    [genDmg(), product_id, variant_id||null, from_bin_id, to_bin_id, quantity, damage_type||'damage', reason, req.user.id]
  );
  res.status(201).json({ success: true, data: result.rows[0] });
}));

// Approve damage → good↓ damage↑ (or scrap/expired/lost), move bin stock
router.patch('/:id/approve', asyncHandler(async (req, res) => {
  const client = await getClient();
  try {
    await client.query('BEGIN');
    const dmg = await client.query(
      `UPDATE damage_logs SET status='approved',approved_by=$1,approved_at=NOW() WHERE id=$2 AND status='pending' RETURNING *`,
      [req.user.id, req.params.id]
    );
    if (!dmg.rows[0]) throw { statusCode:400, message:'Damage log not pending' };
    const d = dmg.rows[0];
    const typeField = d.damage_type === 'scrap' ? 'scrap_qty' : d.damage_type === 'expired' ? 'expired_qty'
      : d.damage_type === 'lost' ? 'lost_qty' : 'damage_qty';
    // Update stock: good↓ type↑
    await client.query(
      `UPDATE stock SET good_qty=good_qty-$1, ${typeField}=${typeField}+$1 WHERE product_id=$2`,
      [d.quantity, d.product_id]
    );
    // Move bin_stock: from_bin↓ to_bin↑
    if (d.from_bin_id) {
      await client.query(
        'UPDATE bin_stock SET quantity=quantity-$1 WHERE bin_id=$2 AND product_id=$3',
        [d.quantity, d.from_bin_id, d.product_id]
      );
    }
    if (d.to_bin_id) {
      await client.query(
        `INSERT INTO bin_stock (bin_id,product_id,variant_id,quantity) VALUES ($1,$2,$3,$4)
         ON CONFLICT DO NOTHING`,
        [d.to_bin_id, d.product_id, d.variant_id, 0]
      );
      await client.query(
        'UPDATE bin_stock SET quantity=quantity+$1 WHERE bin_id=$2 AND product_id=$3',
        [d.quantity, d.to_bin_id, d.product_id]
      );
    }
    await client.query(
      `INSERT INTO stock_movements (product_id,variant_id,from_bin_id,to_bin_id,movement_type,from_stock_type,to_stock_type,quantity,reference_type,reference_id,created_by)
       VALUES ($1,$2,$3,$4,'damage','good',$5,$6,'damage_log',$7,$8)`,
      [d.product_id, d.variant_id, d.from_bin_id, d.to_bin_id, d.damage_type, d.quantity, d.id, req.user.id]
    );
    await client.query('COMMIT');
    res.json({ success: true, data: dmg.rows[0] });
  } catch(e) { await client.query('ROLLBACK'); throw e; }
  finally { client.release(); }
}));

router.patch('/:id/reject', asyncHandler(async (req, res) => {
  const result = await query(
    `UPDATE damage_logs SET status='rejected',approved_by=$1 WHERE id=$2 AND status='pending' RETURNING *`,
    [req.user.id, req.params.id]
  );
  res.json({ success: true, data: result.rows[0] });
}));

module.exports = router;
