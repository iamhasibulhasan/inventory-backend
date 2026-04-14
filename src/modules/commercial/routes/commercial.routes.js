const express = require('express');
const router = express.Router();
const { query } = require('../../../config/database');
const { authenticate } = require('../../../middleware/auth');
const { asyncHandler } = require('../../../middleware/errorHandler');

router.use(authenticate);

// ========== CATEGORIES ==========
router.get('/categories', asyncHandler(async (req, res) => {
  const result = await query(
    `SELECT c.*, p.name as parent_name FROM categories c LEFT JOIN categories p ON c.parent_id=p.id
     WHERE c.is_active=TRUE ORDER BY c.name`
  );
  res.json({ success: true, data: result.rows });
}));
router.post('/categories', asyncHandler(async (req, res) => {
  const { name, parent_id, slug } = req.body;
  const autoSlug = slug || name.toLowerCase().replace(/[^a-z0-9]+/g,'-');
  const result = await query(
    'INSERT INTO categories (name,parent_id,slug) VALUES ($1,$2,$3) RETURNING *',
    [name, parent_id||null, autoSlug]
  );
  res.status(201).json({ success: true, data: result.rows[0] });
}));
router.put('/categories/:id', asyncHandler(async (req, res) => {
  const { name, parent_id, is_active } = req.body;
  const result = await query(
    'UPDATE categories SET name=$1,parent_id=$2,is_active=$3 WHERE id=$4 RETURNING *',
    [name, parent_id||null, is_active, req.params.id]
  );
  res.json({ success: true, data: result.rows[0] });
}));
router.delete('/categories/:id', asyncHandler(async (req, res) => {
  await query('UPDATE categories SET is_active=FALSE WHERE id=$1', [req.params.id]);
  res.json({ success: true });
}));

// ========== UOM ==========
router.get('/uom', asyncHandler(async (req, res) => {
  const result = await query('SELECT * FROM units_of_measurement WHERE is_active=TRUE ORDER BY name');
  res.json({ success: true, data: result.rows });
}));
router.post('/uom', asyncHandler(async (req, res) => {
  const { name, symbol, uom_type } = req.body;
  const result = await query(
    'INSERT INTO units_of_measurement (name,symbol,uom_type) VALUES ($1,$2,$3) RETURNING *',
    [name, symbol, uom_type]
  );
  res.status(201).json({ success: true, data: result.rows[0] });
}));
router.put('/uom/:id', asyncHandler(async (req, res) => {
  const { name, symbol, uom_type, is_active } = req.body;
  const result = await query(
    'UPDATE units_of_measurement SET name=$1,symbol=$2,uom_type=$3,is_active=$4 WHERE id=$5 RETURNING *',
    [name, symbol, uom_type, is_active, req.params.id]
  );
  res.json({ success: true, data: result.rows[0] });
}));

// ========== ATTRIBUTES ==========
router.get('/attributes', asyncHandler(async (req, res) => {
  const attrs = await query('SELECT * FROM product_attributes ORDER BY name');
  const vals = await query('SELECT * FROM attribute_values ORDER BY attribute_id, value');
  const data = attrs.rows.map(a => ({
    ...a,
    values: vals.rows.filter(v => v.attribute_id === a.id)
  }));
  res.json({ success: true, data });
}));
router.post('/attributes', asyncHandler(async (req, res) => {
  const { name, description, values } = req.body;
  const result = await query(
    'INSERT INTO product_attributes (name,description) VALUES ($1,$2) RETURNING *',
    [name, description]
  );
  const attr = result.rows[0];
  if (values && values.length > 0) {
    for (const v of values) {
      await query('INSERT INTO attribute_values (attribute_id,value) VALUES ($1,$2)', [attr.id, v]);
    }
  }
  res.status(201).json({ success: true, data: attr });
}));
router.post('/attributes/:id/values', asyncHandler(async (req, res) => {
  const { value } = req.body;
  const result = await query(
    'INSERT INTO attribute_values (attribute_id,value) VALUES ($1,$2) RETURNING *',
    [req.params.id, value]
  );
  res.status(201).json({ success: true, data: result.rows[0] });
}));
router.delete('/attributes/:id/values/:valueId', asyncHandler(async (req, res) => {
  await query('DELETE FROM attribute_values WHERE id=$1 AND attribute_id=$2', [req.params.valueId, req.params.id]);
  res.json({ success: true });
}));

// ========== PRODUCTS ==========
router.get('/products', asyncHandler(async (req, res) => {
  const { page=1, limit=20, search, category_id, supplier_id, has_variants } = req.query;
  const offset = (page-1)*limit;
  let conditions = ['p.is_active=TRUE'];
  const params = [];
  let i = 1;
  if (search) { conditions.push(`(p.name ILIKE $${i} OR p.sku ILIKE $${i})`); params.push(`%${search}%`); i++; }
  if (category_id) { conditions.push(`p.category_id=$${i++}`); params.push(category_id); }
  if (supplier_id) { conditions.push(`p.supplier_id=$${i++}`); params.push(supplier_id); }
  if (has_variants) { conditions.push(`p.has_variants=$${i++}`); params.push(has_variants==='true'); }
  const where = conditions.join(' AND ');
  const [data, count] = await Promise.all([
    query(
      `SELECT p.*, c.name as category_name, s.name as supplier_name, u.symbol as uom_symbol,
        COALESCE((SELECT SUM(st.good_qty) FROM stock st WHERE st.product_id=p.id),0) as stock_qty
       FROM products p
       LEFT JOIN categories c ON p.category_id=c.id
       LEFT JOIN suppliers s ON p.supplier_id=s.id
       LEFT JOIN units_of_measurement u ON p.uom_id=u.id
       WHERE ${where} ORDER BY p.created_at DESC LIMIT $${i} OFFSET $${i+1}`,
      [...params, limit, offset]
    ),
    query(`SELECT COUNT(*) FROM products p WHERE ${where}`, params)
  ]);
  res.json({ success: true, data: data.rows, total: parseInt(count.rows[0].count), page: parseInt(page), limit: parseInt(limit) });
}));

router.get('/products/:id', asyncHandler(async (req, res) => {
  const [product, variants, stock] = await Promise.all([
    query(
      `SELECT p.*, c.name as category_name, s.name as supplier_name, u.symbol as uom_symbol
       FROM products p LEFT JOIN categories c ON p.category_id=c.id
       LEFT JOIN suppliers s ON p.supplier_id=s.id LEFT JOIN units_of_measurement u ON p.uom_id=u.id
       WHERE p.id=$1`, [req.params.id]
    ),
    query(
      `SELECT pv.*, array_agg(json_build_object('attribute',pa.name,'value',av.value)) as attributes
       FROM product_variants pv
       JOIN variant_attribute_values vav ON pv.id=vav.variant_id
       JOIN attribute_values av ON vav.attribute_value_id=av.id
       JOIN product_attributes pa ON av.attribute_id=pa.id
       WHERE pv.product_id=$1 AND pv.is_active=TRUE
       GROUP BY pv.id ORDER BY pv.created_at`, [req.params.id]
    ),
    query(
      `SELECT st.*, s.name as store_name FROM stock st LEFT JOIN stores s ON st.store_id=s.id WHERE st.product_id=$1`,
      [req.params.id]
    )
  ]);
  if (!product.rows[0]) return res.status(404).json({ success: false, message: 'Product not found' });
  res.json({ success: true, data: { ...product.rows[0], variants: variants.rows, stock: stock.rows } });
}));

router.post('/products', asyncHandler(async (req, res) => {
  const { name, sku, category_id, supplier_id, uom_id, purchase_price, selling_price, mrp,
          vat_rate, has_expiry, has_serial, has_variants, description, min_stock_level, variants } = req.body;
  const slug = name.toLowerCase().replace(/[^a-z0-9]+/g,'-');
  const result = await query(
    `INSERT INTO products (name,slug,sku,category_id,supplier_id,uom_id,purchase_price,selling_price,mrp,
      vat_rate,has_expiry,has_serial,has_variants,description,min_stock_level)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15) RETURNING *`,
    [name,slug,sku,category_id,supplier_id,uom_id,purchase_price,selling_price,mrp,
     vat_rate||15,has_expiry||false,has_serial||false,has_variants||false,description,min_stock_level||10]
  );
  const product = result.rows[0];
  if (variants && variants.length > 0) {
    for (const v of variants) {
      const vr = await query(
        'INSERT INTO product_variants (product_id,sku,purchase_price,selling_price) VALUES ($1,$2,$3,$4) RETURNING *',
        [product.id, v.sku, v.purchase_price||purchase_price, v.selling_price||selling_price]
      );
      if (v.attribute_value_ids) {
        for (const avId of v.attribute_value_ids) {
          await query('INSERT INTO variant_attribute_values (variant_id,attribute_value_id) VALUES ($1,$2)', [vr.rows[0].id, avId]);
        }
      }
    }
  }
  res.status(201).json({ success: true, data: product });
}));

router.put('/products/:id', asyncHandler(async (req, res) => {
  const { name, category_id, supplier_id, uom_id, purchase_price, selling_price, mrp,
          vat_rate, has_expiry, has_serial, description, min_stock_level, is_active } = req.body;
  const result = await query(
    `UPDATE products SET name=$1,category_id=$2,supplier_id=$3,uom_id=$4,purchase_price=$5,selling_price=$6,
      mrp=$7,vat_rate=$8,has_expiry=$9,has_serial=$10,description=$11,min_stock_level=$12,is_active=$13
     WHERE id=$14 RETURNING *`,
    [name,category_id,supplier_id,uom_id,purchase_price,selling_price,mrp,vat_rate,
     has_expiry,has_serial,description,min_stock_level,is_active,req.params.id]
  );
  res.json({ success: true, data: result.rows[0] });
}));
router.delete('/products/:id', asyncHandler(async (req, res) => {
  await query('UPDATE products SET is_active=FALSE WHERE id=$1', [req.params.id]);
  res.json({ success: true });
}));

// ========== PRODUCT VARIANTS ==========
router.get('/products/:id/variants', asyncHandler(async (req, res) => {
  const result = await query(
    `SELECT pv.*,
      array_agg(json_build_object('attribute',pa.name,'value',av.value)) as attributes
     FROM product_variants pv
     LEFT JOIN variant_attribute_values vav ON pv.id=vav.variant_id
     LEFT JOIN attribute_values av ON vav.attribute_value_id=av.id
     LEFT JOIN product_attributes pa ON av.attribute_id=pa.id
     WHERE pv.product_id=$1 GROUP BY pv.id ORDER BY pv.created_at`,
    [req.params.id]
  );
  res.json({ success: true, data: result.rows });
}));

router.post('/products/:id/variants', asyncHandler(async (req, res) => {
  const { sku, purchase_price, selling_price, attribute_value_ids } = req.body;
  const product = await query('SELECT * FROM products WHERE id=$1', [req.params.id]);
  const vr = await query(
    'INSERT INTO product_variants (product_id,sku,purchase_price,selling_price) VALUES ($1,$2,$3,$4) RETURNING *',
    [req.params.id, sku, purchase_price||product.rows[0].purchase_price, selling_price||product.rows[0].selling_price]
  );
  if (attribute_value_ids) {
    for (const avId of attribute_value_ids) {
      await query('INSERT INTO variant_attribute_values (variant_id,attribute_value_id) VALUES ($1,$2)', [vr.rows[0].id, avId]);
    }
  }
  // Mark product as has_variants
  await query('UPDATE products SET has_variants=TRUE WHERE id=$1', [req.params.id]);
  res.status(201).json({ success: true, data: vr.rows[0] });
}));

module.exports = router;
