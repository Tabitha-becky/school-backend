const express = require('express');
const { query } = require('../config/db');
const { authenticate, authorize } = require('../middleware/auth');

const router = express.Router();
router.use(authenticate);

// GET current term
router.get('/current-term', async (req, res) => {
  try {
    const today = new Date().toISOString().split('T')[0];

    const result = await query(
      `SELECT * FROM school_settings 
       WHERE term_start_date <= $1 AND term_end_date >= $1
       ORDER BY term_start_date DESC LIMIT 1`,
      [today]
    );

    if (result.rows.length > 0) {
      return res.json({ success: true, data: result.rows[0] });
    }

    const fallback = await query(
      'SELECT * FROM school_settings WHERE is_current = TRUE ORDER BY created_at DESC LIMIT 1'
    );

    if (fallback.rows.length > 0) {
      return res.json({ success: true, data: fallback.rows[0] });
    }

    // Derive from current date
    const year = new Date().getFullYear();
    const month = new Date().getMonth() + 1;
    let term;
    if (month <= 4) term = `Term 1 ${year}`;
    else if (month <= 8) term = `Term 2 ${year}`;
    else term = `Term 3 ${year}`;

    res.json({ success: true, data: { academic_year: String(year), term, term_start_date: null, term_end_date: null, has_half_term: false } });
  } catch (err) {
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

// POST save a term
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
      [academic_year, term, term_start_date, term_end_date,
       has_half_term ? half_term_start : null,
       has_half_term ? half_term_end : null,
       has_half_term || false, is_current || false]
    );
    res.json({ success: true, message: 'Term saved.', data: result.rows[0] });
  } catch (err) {
    console.error(err);
    res.status(500).json({ success: false, message: 'Server error.' });
  }
});

// PUT set current term
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

module.exports = router;
