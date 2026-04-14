// ─────────────────────────────────────────────────────────────
//  routes/health.js — Student Health Records
//  🏥 Your unique selling point — most systems ignore this!
// ─────────────────────────────────────────────────────────────
const express = require('express');
const { query } = require('../config/db');
const { authenticate, authorize } = require('../middleware/auth');

const router = express.Router();
router.use(authenticate);

// ─────────────────────────────────────────────────────────────
//  GET /api/health/alerts — All students with health conditions
//  Perfect for the nurse / admin morning check
// ─────────────────────────────────────────────────────────────
router.get('/alerts', async (req, res) => {
  try {
    const { class_id, severity } = req.query;

    const conditions = ["(hr.allergies != 'None' OR hr.chronic_conditions != 'None')"];
    const params = [];
    let i = 1;

    if (class_id) { conditions.push(`s.class_id = $${i++}`); params.push(class_id); }
    if (severity) { conditions.push(`hr.allergy_severity = $${i++}`); params.push(severity); }

    const result = await query(
      `SELECT s.id, s.adm_no, s.name, s.parent_phone,
              c.name AS class_name,
              hr.blood_group, hr.allergies, hr.allergy_severity,
              hr.chronic_conditions, hr.current_medication,
              hr.medication_notes, hr.emergency_contact_name,
              hr.emergency_contact_phone
       FROM students s
       JOIN health_records hr ON s.id = hr.student_id
       LEFT JOIN classes c ON s.class_id = c.id
       WHERE s.is_active = TRUE AND ${conditions.join(' AND ')}
       ORDER BY
         CASE hr.allergy_severity
           WHEN 'Critical' THEN 1
           WHEN 'High' THEN 2
           WHEN 'Medium' THEN 3
           ELSE 4
         END,
         s.name`,
      params
    );

    res.json({
      success: true,
      data: result.rows,
      count: result.rows.length,
    });
  } catch (err) {
    console.error('Health alerts error:', err);
    res.status(500).json({ success: false, message: 'Server error.' });
  }
});

// ─────────────────────────────────────────────────────────────
//  GET /api/health/:student_id — Get one student's health record
// ─────────────────────────────────────────────────────────────
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

    if (result.rows.length === 0) {
      return res.status(404).json({ success: false, message: 'Health record not found.' });
    }

    res.json({ success: true, data: result.rows[0] });
  } catch (err) {
    res.status(500).json({ success: false, message: 'Server error.' });
  }
});

// ─────────────────────────────────────────────────────────────
//  PUT /api/health/:student_id — Update health record
// ─────────────────────────────────────────────────────────────
router.put('/:student_id', async (req, res) => {
  try {
    const {
      blood_group, height_cm, weight_kg,
      allergies, allergy_severity,
      chronic_conditions, disabilities,
      current_medication, medication_notes,
      emergency_contact_name, emergency_contact_phone, emergency_contact_rel,
      nhif_no, private_insurance, last_checkup_date, notes,
    } = req.body;

    const result = await query(
      `UPDATE health_records SET
         blood_group = COALESCE($1, blood_group),
         height_cm = COALESCE($2, height_cm),
         weight_kg = COALESCE($3, weight_kg),
         allergies = COALESCE($4, allergies),
         allergy_severity = COALESCE($5, allergy_severity),
         chronic_conditions = COALESCE($6, chronic_conditions),
         disabilities = COALESCE($7, disabilities),
         current_medication = COALESCE($8, current_medication),
         medication_notes = COALESCE($9, medication_notes),
         emergency_contact_name = COALESCE($10, emergency_contact_name),
         emergency_contact_phone = COALESCE($11, emergency_contact_phone),
         emergency_contact_rel = COALESCE($12, emergency_contact_rel),
         nhif_no = COALESCE($13, nhif_no),
         private_insurance = COALESCE($14, private_insurance),
         last_checkup_date = COALESCE($15, last_checkup_date),
         notes = COALESCE($16, notes),
         updated_at = NOW()
       WHERE student_id = $17
       RETURNING *`,
      [blood_group, height_cm, weight_kg, allergies, allergy_severity,
       chronic_conditions, disabilities, current_medication, medication_notes,
       emergency_contact_name, emergency_contact_phone, emergency_contact_rel,
       nhif_no, private_insurance, last_checkup_date, notes,
       req.params.student_id]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ success: false, message: 'Health record not found.' });
    }

    res.json({
      success: true,
      message: 'Health record updated.',
      data: result.rows[0],
    });
  } catch (err) {
    console.error('Update health error:', err);
    res.status(500).json({ success: false, message: 'Server error.' });
  }
});

// ─────────────────────────────────────────────────────────────
//  GET /api/health/stats/summary — Health overview for dashboard
// ─────────────────────────────────────────────────────────────
router.get('/stats/summary', async (req, res) => {
  try {
    const result = await query(`
      SELECT
        COUNT(*) AS total_students_with_records,
        COUNT(*) FILTER (WHERE allergies != 'None') AS with_allergies,
        COUNT(*) FILTER (WHERE chronic_conditions != 'None') AS with_conditions,
        COUNT(*) FILTER (WHERE allergy_severity = 'Critical') AS critical_alerts,
        COUNT(*) FILTER (WHERE allergy_severity = 'High') AS high_alerts,
        COUNT(*) FILTER (WHERE current_medication != 'None') AS on_medication,
        COUNT(*) FILTER (WHERE blood_group = 'Unknown') AS unknown_blood_group
      FROM health_records hr
      JOIN students s ON hr.student_id = s.id
      WHERE s.is_active = TRUE
    `);

    res.json({ success: true, data: result.rows[0] });
  } catch (err) {
    res.status(500).json({ success: false, message: 'Server error.' });
  }
});

module.exports = router;