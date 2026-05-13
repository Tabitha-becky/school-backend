const express = require('express');
const { query } = require('../config/db');
const { authenticate, authorize } = require('../middleware/auth');

const router = express.Router();
router.use(authenticate);

// GET current term — auto detects based on today's date
router.get('/current-term', async (req, res) => {
  try {
    const today = new Date().toISOString().split('T')[0];

    // Find term whose dates contain today
    const result = await query(
      `SELECT * FROM school_settings 
       WHERE term_start_date <= $1 AND term_end_date >= $1
       ORDER BY term_start_date DESC LIMIT 1`,
      [today]
    );

    if (result.rows.length > 0) {
      return res.json({ success: true, data: result.rows[0] });
    }

    // Fallback: get manually set current term
    const fallback = await query(
      'SELECT * FROM school_settings WHERE is_current = TRUE ORDER BY created_at DESC LIMIT 1'
    );

    if (fallback.rows.length > 0) {
      return res.json({ success: true, data: fallback.rows[0] });
    }

    // Last resort: derive from current month
    const year = new Date().getFullYear();
    const month = new Date().getMonth() + 1;
    let term;
    if (month <= 4) term = `Term 1 ${year}`;
    else if (month <= 8) term = `Term 2 ${year}`;
    else term = `Term 3 ${year}`;

    res.json({ success: true, data: { academic_year: String(year), term, term_start_date: null, term_end_date: null, has_half_term: false } });
  } catch (err) {
    console.error('Current term error:', err.message);
    res.status(500).json({ success: false, message: 'Server error.' });
  }
});

// GET all terms
router.get('/terms', async (req, res) => {
  try {
    const result = await query('SELECT * FROM school_settings ORDER BY term_start_date ASC');
    res.json({ success: true, data: result.rows });
  } catch (err) {
    res.status(500).json({ success: false, message: 'Server error.' });
  }
});

// POST create a term
router.post('/terms', authorize('admin', 'principal'), async (req, res) => {
  try {
    const { academic_year, term, term_start_date, term_end_date, half_term_start, half_term_end, has_half_term, is_current } = req.body;

    if (!academic_year || !term || !term_start_date || !term_end_date) {
      return res.status(400).json({ success: false, message: 'Academic year, term name, start and end dates are required.' });
    }

    if (is_current) {
      await query('UPDATE school_settings SET is_current = FALSE');
    }

    const result = await query(
      `INSERT INTO school_settings (academic_year, term, term_start_date, term_end_date, half_term_start, half_term_end, has_half_term, is_current)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING *`,
      [
        academic_year, term, term_start_date, term_end_date,
        has_half_term ? half_term_start : null,
        has_half_term ? half_term_end : null,
        has_half_term || false,
        is_current || false
      ]
    );

    res.json({ success: true, message: 'Term saved.', data: result.rows[0] });
  } catch (err) {
    console.error('Save term error:', err.message);
    res.status(500).json({ success: false, message: 'Server error.' });
  }
});

// PUT set a term as current
router.put('/terms/:id/set-current', authorize('admin', 'principal'), async (req, res) => {
  try {
    await query('UPDATE school_settings SET is_current = FALSE');
    await query('UPDATE school_settings SET is_current = TRUE WHERE id = $1', [req.params.id]);
    res.json({ success: true, message: 'Current term updated.' });
  } catch (err) {
    res.status(500).json({ success: false, message: 'Server error.' });
  }
});

// DELETE a term
router.delete('/terms/:id', authorize('admin', 'principal'), async (req, res) => {
  try {
    await query('DELETE FROM school_settings WHERE id = $1', [req.params.id]);
    res.json({ success: true, message: 'Term deleted.' });
  } catch (err) {
    res.status(500).json({ success: false, message: 'Server error.' });
  }
});
// GET school profile
router.get('/profile', async (req, res) => {
  try {
    const result = await query('SELECT * FROM school_profile ORDER BY id LIMIT 1');
    res.json({ success: true, data: result.rows[0] || {} });
  } catch (err) {
    res.status(500).json({ success: false, message: 'Server error.' });
  }
});

// PUT save school profile
router.put('/profile', authorize('admin', 'principal'), async (req, res) => {
  try {
    const { school_name, motto, address, phone, email, website, logo, principal_name, school_type, county, nemis_code, kra_pin } = req.body;
    if (!school_name) return res.status(400).json({ success: false, message: 'School name is required.' });
    const existing = await query('SELECT id FROM school_profile LIMIT 1');
    let result;
    if (existing.rows.length > 0) {
      result = await query(
        `UPDATE school_profile SET school_name=$1, motto=$2, address=$3, phone=$4, email=$5, website=$6, logo=COALESCE($7,logo), principal_name=$8, school_type=$9, county=$10, nemis_code=$11, kra_pin=$12, updated_at=CURRENT_TIMESTAMP WHERE id=$13 RETURNING *`,
        [school_name, motto||null, address||null, phone||null, email||null, website||null, logo||null, principal_name||null, school_type||'Secondary', county||null, nemis_code||null, kra_pin||null, existing.rows[0].id]
      );
    } else {
      result = await query(
        `INSERT INTO school_profile (school_name,motto,address,phone,email,website,logo,principal_name,school_type,county,nemis_code,kra_pin) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) RETURNING *`,
        [school_name, motto||null, address||null, phone||null, email||null, website||null, logo||null, principal_name||null, school_type||'Secondary', county||null, nemis_code||null, kra_pin||null]
      );
    }
    res.json({ success: true, message: 'Profile saved.', data: result.rows[0] });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});
module.exports = router;