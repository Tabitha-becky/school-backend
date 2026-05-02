const express = require('express');
const { query } = require('../config/db');
const { authenticate } = require('../middleware/auth');

const router = express.Router();
router.use(authenticate);

// GET /api/health/alerts
router.get('/alerts', async (req, res) => {
  try {
    const { class_id } = req.query;
    const conditions = ["(hr.allergies != 'None' OR hr.chronic_conditions != 'None')"];
    const params = [];

    if (class_id) { conditions.push(`s.class_id = $1`); params.push(class_id); }

    const result = await query(
      `SELECT s.id, s.adm_no, s.name, s.parent_phone,
              c.name AS class_name,
              hr.blood_group, hr.allergies,
              hr.chronic_conditions, hr.current_medication,
              hr.emergency_contact_phone
       FROM students s
       JOIN health_records hr ON s.id = hr.student_id
       LEFT JOIN classes c ON s.class_id = c.id
       WHERE s.is_active = TRUE AND ${conditions.join(' AND ')}
       ORDER BY s.name`,
      params
    );

    res.json({ success: true, data: result.rows, count: result.rows.length });
  } catch (err) {
    console.error('Health alerts error:', err);
    res.status(500).json({ success: false, message: 'Server error.' });
  }
});

// GET /api/health/stats/summary
router.get('/stats/summary', async (req, res) => {
  try {
    const result = await query(`
      SELECT
        COUNT(*) AS total_students_with_records,
        COUNT(*) FILTER (WHERE allergies != 'None') AS with_allergies,
        COUNT(*) FILTER (WHERE chronic_conditions != 'None') AS with_conditions,
        COUNT(*) FILTER (WHERE current_medication != 'None') AS on_medication
      FROM health_records hr
      JOIN students s ON hr.student_id = s.id
      WHERE s.is_active = TRUE
    `);
    res.json({ success: true, data: result.rows[0] });
  } catch (err) {
    res.status(500).json({ success: false, message: 'Server error.' });
  }
});

// GET /api/health/:student_id
router.get('/:student_id', async (req, res) => {
  try {
    const result = await query(
      `SELECT hr.*, s.name AS student_name, s.adm_no, c.name AS class_name
       FROM health_records hr
       JOIN students s ON hr.student_id = s.id
       LEFT JOIN classes c ON s.class_id = c.id
       WHERE hr.student_id = $1`,
      [req.params.student_id]
    );
    if (result.rows.length === 0) return res.status(404).json({ success: false, message: 'Health record not found.' });
    res.json({ success: true, data: result.rows[0] });
  } catch (err) {
    res.status(500).json({ success: false, message: 'Server error.' });
  }
});

// PUT /api/health/:student_id
router.put('/:student_id', async (req, res) => {
  try {
    const { blood_group, allergies, chronic_conditions, current_medication, emergency_contact_phone } = req.body;
    const result = await query(
      `UPDATE health_records SET
         blood_group = COALESCE($1, blood_group),
         allergies = COALESCE($2, allergies),
         chronic_conditions = COALESCE($3, chronic_conditions),
         current_medication = COALESCE($4, current_medication),
         emergency_contact_phone = COALESCE($5, emergency_contact_phone)
       WHERE student_id = $6 RETURNING *`,
      [blood_group, allergies, chronic_conditions, current_medication, emergency_contact_phone, req.params.student_id]
    );
    if (result.rows.length === 0) return res.status(404).json({ success: false, message: 'Health record not found.' });
    res.json({ success: true, message: 'Health record updated.', data: result.rows[0] });
  } catch (err) {
    console.error('Update health error:', err);
    res.status(500).json({ success: false, message: 'Server error.' });
  }
});

module.exports = router;