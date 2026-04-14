const express = require('express');
const router = express.Router();
const { query } = require('../../../config/database');
const { authenticate } = require('../../../middleware/auth');
const { asyncHandler } = require('../../../middleware/errorHandler');

router.use(authenticate);

// COUNTRIES
router.get('/countries', asyncHandler(async (req, res) => {
  const result = await query('SELECT * FROM countries WHERE is_active=TRUE ORDER BY name');
  res.json({ success: true, data: result.rows });
}));
router.post('/countries', asyncHandler(async (req, res) => {
  const { name, code } = req.body;
  const result = await query('INSERT INTO countries (name,code) VALUES ($1,$2) RETURNING *', [name, code]);
  res.status(201).json({ success: true, data: result.rows[0] });
}));
router.put('/countries/:id', asyncHandler(async (req, res) => {
  const { name, code, is_active } = req.body;
  const result = await query(
    'UPDATE countries SET name=$1,code=$2,is_active=$3 WHERE id=$4 RETURNING *',
    [name, code, is_active, req.params.id]
  );
  res.json({ success: true, data: result.rows[0] });
}));
router.delete('/countries/:id', asyncHandler(async (req, res) => {
  await query('UPDATE countries SET is_active=FALSE WHERE id=$1', [req.params.id]);
  res.json({ success: true, message: 'Country deactivated' });
}));

// STATES
router.get('/states', asyncHandler(async (req, res) => {
  const { country_id } = req.query;
  let sql = `SELECT s.*, c.name as country_name FROM states s JOIN countries c ON s.country_id=c.id WHERE s.is_active=TRUE`;
  const params = [];
  if (country_id) { sql += ` AND s.country_id=$1`; params.push(country_id); }
  sql += ' ORDER BY s.name';
  const result = await query(sql, params);
  res.json({ success: true, data: result.rows });
}));
router.post('/states', asyncHandler(async (req, res) => {
  const { country_id, name, code } = req.body;
  const result = await query(
    'INSERT INTO states (country_id,name,code) VALUES ($1,$2,$3) RETURNING *',
    [country_id, name, code]
  );
  res.status(201).json({ success: true, data: result.rows[0] });
}));
router.put('/states/:id', asyncHandler(async (req, res) => {
  const { name, code, is_active } = req.body;
  const result = await query(
    'UPDATE states SET name=$1,code=$2,is_active=$3 WHERE id=$4 RETURNING *',
    [name, code, is_active, req.params.id]
  );
  res.json({ success: true, data: result.rows[0] });
}));
router.delete('/states/:id', asyncHandler(async (req, res) => {
  await query('UPDATE states SET is_active=FALSE WHERE id=$1', [req.params.id]);
  res.json({ success: true, message: 'State deactivated' });
}));

// CITIES
router.get('/cities', asyncHandler(async (req, res) => {
  const { state_id } = req.query;
  let sql = `SELECT c.*, s.name as state_name, co.name as country_name
    FROM cities c JOIN states s ON c.state_id=s.id JOIN countries co ON s.country_id=co.id
    WHERE c.is_active=TRUE`;
  const params = [];
  if (state_id) { sql += ` AND c.state_id=$1`; params.push(state_id); }
  sql += ' ORDER BY c.name';
  const result = await query(sql, params);
  res.json({ success: true, data: result.rows });
}));
router.post('/cities', asyncHandler(async (req, res) => {
  const { state_id, name, postal_code } = req.body;
  const result = await query(
    'INSERT INTO cities (state_id,name,postal_code) VALUES ($1,$2,$3) RETURNING *',
    [state_id, name, postal_code]
  );
  res.status(201).json({ success: true, data: result.rows[0] });
}));
router.put('/cities/:id', asyncHandler(async (req, res) => {
  const { name, postal_code, is_active } = req.body;
  const result = await query(
    'UPDATE cities SET name=$1,postal_code=$2,is_active=$3 WHERE id=$4 RETURNING *',
    [name, postal_code, is_active, req.params.id]
  );
  res.json({ success: true, data: result.rows[0] });
}));
router.delete('/cities/:id', asyncHandler(async (req, res) => {
  await query('UPDATE cities SET is_active=FALSE WHERE id=$1', [req.params.id]);
  res.json({ success: true, message: 'City deactivated' });
}));

module.exports = router;
