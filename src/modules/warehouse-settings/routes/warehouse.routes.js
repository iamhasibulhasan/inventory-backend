const express = require('express');
const router = express.Router();
const { query } = require('../../../config/database');
const { authenticate } = require('../../../middleware/auth');
const { asyncHandler } = require('../../../middleware/errorHandler');
router.use(authenticate);

// STORES
router.get('/stores', asyncHandler(async (req, res) => {
  const result = await query(
    `SELECT s.*, c.name as city_name, u.name as manager_name FROM stores s
     LEFT JOIN cities c ON s.city_id=c.id LEFT JOIN users u ON s.manager_id=u.id WHERE s.is_active=TRUE ORDER BY s.name`
  );
  res.json({ success: true, data: result.rows });
}));
router.post('/stores', asyncHandler(async (req, res) => {
  const { name, code, address, city_id, manager_id } = req.body;
  const result = await query(
    'INSERT INTO stores (name,code,address,city_id,manager_id) VALUES ($1,$2,$3,$4,$5) RETURNING *',
    [name, code, address, city_id||null, manager_id||null]
  );
  res.status(201).json({ success: true, data: result.rows[0] });
}));
router.put('/stores/:id', asyncHandler(async (req, res) => {
  const { name, code, address, city_id, manager_id, is_active } = req.body;
  const result = await query(
    'UPDATE stores SET name=$1,code=$2,address=$3,city_id=$4,manager_id=$5,is_active=$6 WHERE id=$7 RETURNING *',
    [name, code, address, city_id||null, manager_id||null, is_active, req.params.id]
  );
  res.json({ success: true, data: result.rows[0] });
}));

// FLOORS
router.get('/floors', asyncHandler(async (req, res) => {
  const { store_id } = req.query;
  let sql = `SELECT f.*, s.name as store_name FROM floors f JOIN stores s ON f.store_id=s.id WHERE 1=1`;
  const params = [];
  if (store_id) { sql += ` AND f.store_id=$1`; params.push(store_id); }
  sql += ' ORDER BY f.floor_number';
  const result = await query(sql, params);
  res.json({ success: true, data: result.rows });
}));
router.post('/floors', asyncHandler(async (req, res) => {
  const { store_id, name, floor_number } = req.body;
  const result = await query(
    'INSERT INTO floors (store_id,name,floor_number) VALUES ($1,$2,$3) RETURNING *',
    [store_id, name, floor_number]
  );
  res.status(201).json({ success: true, data: result.rows[0] });
}));

// ROOMS
router.get('/rooms', asyncHandler(async (req, res) => {
  const { floor_id } = req.query;
  let sql = `SELECT r.*, f.name as floor_name, s.name as store_name FROM rooms r
    JOIN floors f ON r.floor_id=f.id JOIN stores s ON f.store_id=s.id WHERE 1=1`;
  const params = [];
  if (floor_id) { sql += ` AND r.floor_id=$1`; params.push(floor_id); }
  sql += ' ORDER BY r.name';
  const result = await query(sql, params);
  res.json({ success: true, data: result.rows });
}));
router.post('/rooms', asyncHandler(async (req, res) => {
  const { floor_id, name } = req.body;
  const result = await query('INSERT INTO rooms (floor_id,name) VALUES ($1,$2) RETURNING *', [floor_id, name]);
  res.status(201).json({ success: true, data: result.rows[0] });
}));

// RACKS
router.get('/racks', asyncHandler(async (req, res) => {
  const { room_id } = req.query;
  let sql = `SELECT rk.*, rm.name as room_name, f.name as floor_name FROM racks rk
    JOIN rooms rm ON rk.room_id=rm.id JOIN floors f ON rm.floor_id=f.id WHERE 1=1`;
  const params = [];
  if (room_id) { sql += ` AND rk.room_id=$1`; params.push(room_id); }
  sql += ' ORDER BY rk.name';
  const result = await query(sql, params);
  res.json({ success: true, data: result.rows });
}));
router.post('/racks', asyncHandler(async (req, res) => {
  const { room_id, name, code } = req.body;
  const result = await query('INSERT INTO racks (room_id,name,code) VALUES ($1,$2,$3) RETURNING *', [room_id, name, code]);
  res.status(201).json({ success: true, data: result.rows[0] });
}));

// ROWS
router.get('/rows', asyncHandler(async (req, res) => {
  const { rack_id } = req.query;
  let sql = `SELECT r.*, rk.name as rack_name FROM rows r JOIN racks rk ON r.rack_id=rk.id WHERE 1=1`;
  const params = [];
  if (rack_id) { sql += ` AND r.rack_id=$1`; params.push(rack_id); }
  sql += ' ORDER BY r.name';
  const result = await query(sql, params);
  res.json({ success: true, data: result.rows });
}));
router.post('/rows', asyncHandler(async (req, res) => {
  const { rack_id, name } = req.body;
  const result = await query('INSERT INTO rows (rack_id,name) VALUES ($1,$2) RETURNING *', [rack_id, name]);
  res.status(201).json({ success: true, data: result.rows[0] });
}));

// BINS
router.get('/bins', asyncHandler(async (req, res) => {
  const { row_id, bin_type } = req.query;
  let conditions = ['1=1'];
  const params = [];
  let i = 1;
  if (row_id) { conditions.push(`b.row_id=$${i++}`); params.push(row_id); }
  if (bin_type) { conditions.push(`b.bin_type=$${i++}`); params.push(bin_type); }
  const result = await query(
    `SELECT b.*, r.name as row_name, rk.name as rack_name, rm.name as room_name, f.name as floor_name, s.name as store_name,
      COALESCE((SELECT SUM(bs.quantity) FROM bin_stock bs WHERE bs.bin_id=b.id),0) as current_stock
     FROM bins b JOIN rows r ON b.row_id=r.id JOIN racks rk ON r.rack_id=rk.id
     JOIN rooms rm ON rk.room_id=rm.id JOIN floors f ON rm.floor_id=f.id JOIN stores s ON f.store_id=s.id
     WHERE ${conditions.join(' AND ')} ORDER BY b.code`,
    params
  );
  res.json({ success: true, data: result.rows });
}));
router.post('/bins', asyncHandler(async (req, res) => {
  const { row_id, name, code, bin_type, max_capacity, position_x, position_y } = req.body;
  const result = await query(
    'INSERT INTO bins (row_id,name,code,bin_type,max_capacity,position_x,position_y) VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING *',
    [row_id, name, code, bin_type||'good', max_capacity, position_x, position_y]
  );
  res.status(201).json({ success: true, data: result.rows[0] });
}));
router.put('/bins/:id', asyncHandler(async (req, res) => {
  const { name, bin_type, max_capacity, is_active } = req.body;
  const result = await query(
    'UPDATE bins SET name=$1,bin_type=$2,max_capacity=$3,is_active=$4 WHERE id=$5 RETURNING *',
    [name, bin_type, max_capacity, is_active, req.params.id]
  );
  res.json({ success: true, data: result.rows[0] });
}));

// Full tree for a store
router.get('/tree/:storeId', asyncHandler(async (req, res) => {
  const [floors, rooms, racks, rows, bins] = await Promise.all([
    query('SELECT * FROM floors WHERE store_id=$1 ORDER BY floor_number', [req.params.storeId]),
    query('SELECT r.* FROM rooms r JOIN floors f ON r.floor_id=f.id WHERE f.store_id=$1 ORDER BY r.name', [req.params.storeId]),
    query('SELECT rk.* FROM racks rk JOIN rooms rm ON rk.room_id=rm.id JOIN floors f ON rm.floor_id=f.id WHERE f.store_id=$1 ORDER BY rk.name', [req.params.storeId]),
    query('SELECT row.* FROM rows row JOIN racks rk ON row.rack_id=rk.id JOIN rooms rm ON rk.room_id=rm.id JOIN floors f ON rm.floor_id=f.id WHERE f.store_id=$1 ORDER BY row.name', [req.params.storeId]),
    query(
      `SELECT b.*, COALESCE((SELECT SUM(bs.quantity) FROM bin_stock bs WHERE bs.bin_id=b.id),0) as current_stock
       FROM bins b JOIN rows row ON b.row_id=row.id JOIN racks rk ON row.rack_id=rk.id
       JOIN rooms rm ON rk.room_id=rm.id JOIN floors f ON rm.floor_id=f.id WHERE f.store_id=$1 ORDER BY b.code`,
      [req.params.storeId]
    )
  ]);
  res.json({ success: true, data: { floors: floors.rows, rooms: rooms.rows, racks: racks.rows, rows: rows.rows, bins: bins.rows } });
}));

module.exports = router;
