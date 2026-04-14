const express = require('express');
const { query } = require('../config/db');
const { authenticate, authorize } = require('../middleware/auth');

const router = express.Router();
router.use(authenticate);

// GET /api/attendance/class/:class_id?date=
router.get('/class/:class_id', async (req, res) => {
  try {
    const { date = new Date().toISOString().split('T')[0] } = req.query;
    const students = await query(
      'SELECT id, name, adm_no FROM students WHERE class_id = $1 AND is_active = TRUE ORDER BY name',
      [req.params.class_id]
    );
    const attendance = await query(
      'SELECT * FROM attendance WHERE class_id = $1 AND date = $2',
      [req.params.class_id, date]
    );
    const attMap = {};
    attendance.rows.forEach(a => { attMap[a.student_id] = a.status; });
    const result = students.rows.map(s => ({ ...s, status: attMap[s.id] || 'present' }));
    res.json({ success: true, data: result, date });
  } catch (err) {
    res.status(500).json({ success: false, message: 'Server error.' });
  }
});

// POST /api/attendance/save — save bulk attendance
router.post('/save', async (req, res) => {
  try {
    const { records, class_id, date } = req.body;
    if (!records || !class_id || !date) {
      return res.status(400).json({ success: false, message: 'records, class_id and date required.' });
    }
    for (const r of records) {
      await query(
        `INSERT INTO attendance (student_id, class_id, date, status, marked_by)
         VALUES ($1, $2, $3, $4, $5)
         ON CONFLICT (student_id, date)
         DO UPDATE SET status = EXCLUDED.status, marked_by = EXCLUDED.marked_by`,
        [r.student_id, class_id, date, r.status, req.user.id]
      );
    }
    res.json({ success: true, message: `Attendance saved for ${records.length} students.` });
  } catch (err) {
    console.error('Attendance save error:', err.message);
    res.status(500).json({ success: false, message: 'Server error.' });
  }
});

// GET /api/attendance/student/:student_id — attendance summary
router.get('/student/:student_id', async (req, res) => {
  try {
    const result = await query(
      `SELECT date, status FROM attendance WHERE student_id = $1 ORDER BY date DESC LIMIT 30`,
      [req.params.student_id]
    );
    const summary = await query(
      `SELECT
         COUNT(*) FILTER (WHERE status = 'present') AS present,
         COUNT(*) FILTER (WHERE status = 'absent')  AS absent,
         COUNT(*) FILTER (WHERE status = 'late')    AS late,
         COUNT(*) AS total
       FROM attendance WHERE student_id = $1`,
      [req.params.student_id]
    );
    res.json({ success: true, data: result.rows, summary: summary.rows[0] });
  } catch (err) {
    res.status(500).json({ success: false, message: 'Server error.' });
  }
});

// GET /api/attendance/report?class_id=&month=
router.get('/report', async (req, res) => {
  try {
    const { class_id, month = new Date().toISOString().slice(0, 7) } = req.query;
    const conditions = [`TO_CHAR(a.date, 'YYYY-MM') = $1`];
    const params = [month];
    if (class_id) { conditions.push('a.class_id = $2'); params.push(class_id); }
    const result = await query(
      `SELECT s.name, s.adm_no,
         COUNT(*) FILTER (WHERE a.status = 'present') AS present,
         COUNT(*) FILTER (WHERE a.status = 'absent')  AS absent,
         COUNT(*) FILTER (WHERE a.status = 'late')    AS late,
         COUNT(*) AS total
       FROM attendance a
       JOIN students s ON a.student_id = s.id
       WHERE ${conditions.join(' AND ')}
       GROUP BY s.id, s.name, s.adm_no ORDER BY s.name`,
      params
    );
    res.json({ success: true, data: result.rows, month });
  } catch (err) {
    res.status(500).json({ success: false, message: 'Server error.' });
  }
});

module.exports = router;