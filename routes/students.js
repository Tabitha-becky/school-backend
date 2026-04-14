// ─────────────────────────────────────────────────────────────
//  routes/students.js — Student Management (Full CRUD)
// ─────────────────────────────────────────────────────────────
const express = require('express');
const { query } = require('../config/db');
const { authenticate, authorize } = require('../middleware/auth');

const router = express.Router();

// All student routes require authentication
router.use((req, res, next) => {
  if (req.path.startsWith('/export') && req.query.token) {
    req.headers['authorization'] = `Bearer ${req.query.token}`;
  }
  next();
});
router.use(authenticate);

// ─────────────────────────────────────────────────────────────
//  GET /api/students
//  Query params: ?class_id=&search=&page=1&limit=20&active=true
// ─────────────────────────────────────────────────────────────
router.get('/', async (req, res) => {
  try {
    const {
      class_id, search,
      page = 1, limit = 50,
      active = 'true',
    } = req.query;

    const offset = (page - 1) * limit;
    const conditions = ['s.is_active = $1'];
    const params = [active === 'true'];
    let paramIndex = 2;

    if (class_id) {
      conditions.push(`s.class_id = $${paramIndex++}`);
      params.push(class_id);
    }

    if (search) {
      conditions.push(`(s.name ILIKE $${paramIndex} OR s.adm_no ILIKE $${paramIndex})`);
      params.push(`%${search}%`);
      paramIndex++;
    }

    const whereClause = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';

    const sql = `
      SELECT
        s.id, s.adm_no, s.name, s.gender, s.date_of_birth,
        s.parent_name, s.parent_phone, s.parent_email,
        s.address, s.year_joined, s.created_at,
        c.name AS class_name, c.id AS class_id,

        -- Fee summary
        COALESCE(SUM(fp.amount_paid), 0)      AS total_paid,
        COALESCE(SUM(fp.amount_expected), 0)  AS total_expected,
        COALESCE(SUM(fp.amount_expected - fp.amount_paid), 0) AS balance,

        -- Health alert flag
        CASE WHEN hr.allergies != 'None' OR hr.chronic_conditions != 'None'
             THEN TRUE ELSE FALSE END AS has_health_alert

      FROM students s
      LEFT JOIN classes c       ON s.class_id = c.id
      LEFT JOIN fee_payments fp ON s.id = fp.student_id
      LEFT JOIN health_records hr ON s.id = hr.student_id
      ${whereClause}
      GROUP BY s.id, c.name, c.id, hr.allergies, hr.chronic_conditions
      ORDER BY s.name
      LIMIT $${paramIndex} OFFSET $${paramIndex + 1}
    `;
    params.push(limit, offset);

    const countSql = `SELECT COUNT(*) FROM students s ${whereClause}`;
    const countParams = params.slice(0, paramIndex - 1);

    const [data, count] = await Promise.all([
      query(sql, params),
      query(countSql, countParams),
    ]);

    res.json({
      success: true,
      data: data.rows,
      pagination: {
        total: parseInt(count.rows[0].count),
        page: parseInt(page),
        limit: parseInt(limit),
        pages: Math.ceil(count.rows[0].count / limit),
      },
    });
  } catch (err) {
    console.error('Get students error:', err);
    res.status(500).json({ success: false, message: 'Server error.' });
  }
});

// ─────────────────────────────────────────────────────────────
//  GET /api/students/:id — Single student with all details
// ─────────────────────────────────────────────────────────────
router.get('/:id', async (req, res) => {
  try {
    // Student basic info
    const studentResult = await query(
      `SELECT s.*, c.name AS class_name
       FROM students s
       LEFT JOIN classes c ON s.class_id = c.id
       WHERE s.id = $1`,
      [req.params.id]
    );

    if (studentResult.rows.length === 0) {
      return res.status(404).json({ success: false, message: 'Student not found.' });
    }

    const student = studentResult.rows[0];

    // Health record
    const healthResult = await query(
      'SELECT * FROM health_records WHERE student_id = $1',
      [student.id]
    );

    // Fee payments
    const feesResult = await query(
      `SELECT fp.*, u.name AS received_by_name
       FROM fee_payments fp
       LEFT JOIN users u ON fp.received_by = u.id
       WHERE fp.student_id = $1
       ORDER BY fp.payment_date DESC`,
      [student.id]
    );

    // Academic records
    const academicsResult = await query(
      `SELECT ar.*, s.name AS subject_name, s.code AS subject_code
       FROM academic_records ar
       JOIN subjects s ON ar.subject_id = s.id
       WHERE ar.student_id = $1
       ORDER BY ar.term, s.name`,
      [student.id]
    );

    // Attendance summary
    const attendanceResult = await query(
      `SELECT
         COUNT(*) FILTER (WHERE status = 'present') AS present,
         COUNT(*) FILTER (WHERE status = 'absent')  AS absent,
         COUNT(*) FILTER (WHERE status = 'late')    AS late,
         COUNT(*)                                    AS total
       FROM attendance WHERE student_id = $1`,
      [student.id]
    );

    res.json({
      success: true,
      data: {
        ...student,
        health: healthResult.rows[0] || null,
        fees: feesResult.rows,
        academics: academicsResult.rows,
        attendance: attendanceResult.rows[0],
      },
    });
  } catch (err) {
    console.error('Get student error:', err);
    res.status(500).json({ success: false, message: 'Server error.' });
  }
});

// ─────────────────────────────────────────────────────────────
//  POST /api/students — Register new student
//  Body: student info + health info
// ─────────────────────────────────────────────────────────────
router.post('/', authorize('admin', 'principal', 'bursar'), async (req, res) => {
  const client = await require('../config/db').pool.connect();
  try {
    await client.query('BEGIN');

    const {
      adm_no, name, class_id, gender, date_of_birth,
      parent_name, parent_phone, parent_email, parent_phone2,
      address, county, year_joined,
      // Health info
      blood_group = 'Unknown', allergies = 'None', allergy_severity = 'Low',
      chronic_conditions = 'None', disabilities = 'None',
      current_medication = 'None', medication_notes,
      emergency_contact_name, emergency_contact_phone, emergency_contact_rel,
      nhif_no, notes: health_notes,
    } = req.body;

    // Validate required fields
    if (!adm_no || !name || !parent_phone) {
      await client.query('ROLLBACK');
      return res.status(400).json({
        success: false,
        message: 'Admission number, student name, and parent phone are required.',
      });
    }

    // Check admission number uniqueness
    const existing = await client.query('SELECT id FROM students WHERE adm_no = $1', [adm_no]);
    if (existing.rows.length > 0) {
      await client.query('ROLLBACK');
      return res.status(409).json({
        success: false,
        message: `Admission number ${adm_no} already exists.`,
      });
    }

    // Insert student
    const studentResult = await client.query(
      `INSERT INTO students
         (adm_no, name, class_id, gender, date_of_birth,
          parent_name, parent_phone, parent_email, parent_phone2,
          address, county, year_joined)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)
       RETURNING *`,
      [adm_no, name.trim(), class_id, gender, date_of_birth,
       parent_name, parent_phone, parent_email, parent_phone2,
       address, county, year_joined || new Date().getFullYear()]
    );

    const student = studentResult.rows[0];

    // Insert health record (always create one, even if empty)
    await client.query(
      `INSERT INTO health_records
         (student_id, blood_group, allergies, allergy_severity,
          chronic_conditions, disabilities, current_medication, medication_notes,
          emergency_contact_name, emergency_contact_phone, emergency_contact_rel,
          nhif_no, notes)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)`,
      [student.id, blood_group, allergies, allergy_severity,
       chronic_conditions, disabilities, current_medication, medication_notes,
       emergency_contact_name, emergency_contact_phone, emergency_contact_rel,
       nhif_no, health_notes]
    );

    await client.query('COMMIT');

    res.status(201).json({
      success: true,
      message: `${name} has been registered successfully.`,
      data: { id: student.id, adm_no: student.adm_no, name: student.name },
    });
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('Create student error:', err);
    res.status(500).json({ success: false, message: 'Failed to register student.' });
  } finally {
    client.release();
  }
});

// ─────────────────────────────────────────────────────────────
//  PUT /api/students/:id — Update student info
// ─────────────────────────────────────────────────────────────
router.put('/:id', authorize('admin', 'principal'), async (req, res) => {
  try {
    const {
      name, class_id, gender, date_of_birth,
      parent_name, parent_phone, parent_email,
      address, county,
    } = req.body;

    const result = await query(
      `UPDATE students SET
         name = COALESCE($1, name),
         class_id = COALESCE($2, class_id),
         gender = COALESCE($3, gender),
         date_of_birth = COALESCE($4, date_of_birth),
         parent_name = COALESCE($5, parent_name),
         parent_phone = COALESCE($6, parent_phone),
         parent_email = COALESCE($7, parent_email),
         address = COALESCE($8, address),
         county = COALESCE($9, county),
         updated_at = NOW()
       WHERE id = $10
       RETURNING id, name, adm_no`,
      [name, class_id, gender, date_of_birth, parent_name,
       parent_phone, parent_email, address, county, req.params.id]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ success: false, message: 'Student not found.' });
    }

    res.json({ success: true, message: 'Student updated.', data: result.rows[0] });
  } catch (err) {
    res.status(500).json({ success: false, message: 'Server error.' });
  }
});

// ─────────────────────────────────────────────────────────────
//  DELETE /api/students/:id — Deactivate (soft delete)
// ─────────────────────────────────────────────────────────────
router.delete('/:id', authorize('admin', 'principal'), async (req, res) => {
  try {
    await query(
      'UPDATE students SET is_active = FALSE, updated_at = NOW() WHERE id = $1',
      [req.params.id]
    );
    res.json({ success: true, message: 'Student deactivated.' });
  } catch (err) {
    res.status(500).json({ success: false, message: 'Server error.' });
  }
});

// ─────────────────────────────────────────────────────────────
//  GET /api/students/class/:class_id — Get all students in a class
// ─────────────────────────────────────────────────────────────
router.get('/class/:class_id', async (req, res) => {
  try {
    const result = await query(
      `SELECT s.id, s.adm_no, s.name, s.gender,
              hr.allergies, hr.chronic_conditions,
              CASE WHEN hr.allergies != 'None' OR hr.chronic_conditions != 'None'
                   THEN TRUE ELSE FALSE END AS has_health_alert
       FROM students s
       LEFT JOIN health_records hr ON s.id = hr.student_id
       WHERE s.class_id = $1 AND s.is_active = TRUE
       ORDER BY s.name`,
      [req.params.class_id]
    );
    res.json({ success: true, data: result.rows });
  } catch (err) {
    res.status(500).json({ success: false, message: 'Server error.' });
  }
});
router.get('/export/excel', async (req, res) => {
  try {
    const ExcelJS = require('exceljs');
    const { class_id, academic_year = '2024' } = req.query;

    let sql = `SELECT s.adm_no, s.name, s.gender, s.date_of_birth, c.name AS class_name,
                      s.parent_name, s.parent_phone, s.parent_email, s.address, s.county,
                      s.year_joined,
                      hr.blood_group, hr.allergies, hr.chronic_conditions, hr.current_medication,
                      hr.emergency_contact_phone,
                      COALESCE(SUM(fp.amount_paid), 0) AS total_paid,
                      COALESCE(SUM(fp.amount_expected), 0) AS total_expected,
                      COALESCE(SUM(fp.amount_expected - fp.amount_paid), 0) AS balance
               FROM students s
               LEFT JOIN classes c ON s.class_id = c.id
               LEFT JOIN health_records hr ON s.id = hr.student_id
               LEFT JOIN fee_payments fp ON s.id = fp.student_id AND fp.academic_year = $1
               WHERE s.is_active = TRUE`;
    const params = [academic_year];
    if (class_id) { sql += ' AND s.class_id = $2'; params.push(class_id); }
    sql += ' GROUP BY s.id, c.name, hr.blood_group, hr.allergies, hr.chronic_conditions, hr.current_medication, hr.emergency_contact_phone ORDER BY s.name';

    const result = await query(sql, params);
    const students = result.rows;

    const workbook = new ExcelJS.Workbook();
    workbook.creator = process.env.SCHOOL_NAME || 'EduTrack Kenya';
    workbook.created = new Date();

    const sheet = workbook.addWorksheet('Students', {
      pageSetup: { paperSize: 9, orientation: 'landscape' }
    });

    // Title row
    sheet.mergeCells('A1:S1');
    sheet.getCell('A1').value = (process.env.SCHOOL_NAME || 'EduTrack Kenya') + ' — Student List (' + academic_year + ')';
    sheet.getCell('A1').font = { bold: true, size: 14, color: { argb: 'FFFFFFFF' } };
    sheet.getCell('A1').fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF064e3b' } };
    sheet.getCell('A1').alignment = { horizontal: 'center', vertical: 'middle' };
    sheet.getRow(1).height = 30;

    // Header row
    const headers = [
      'Adm. No.', 'Name', 'Gender', 'Date of Birth', 'Class',
      'Parent Name', 'Parent Phone', 'Parent Email', 'Address', 'County', 'Year Joined',
      'Blood Group', 'Allergies', 'Conditions', 'Medication', 'Emergency Contact',
      'Total Expected (KES)', 'Total Paid (KES)', 'Balance (KES)'
    ];

    const headerRow = sheet.addRow(headers);
    headerRow.eachCell(cell => {
      cell.font = { bold: true, color: { argb: 'FFFFFFFF' } };
      cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF065f46' } };
      cell.alignment = { horizontal: 'center', vertical: 'middle', wrapText: true };
      cell.border = { bottom: { style: 'thin', color: { argb: 'FF064e3b' } } };
    });
    sheet.getRow(2).height = 22;

    // Data rows
    students.forEach((s, index) => {
      const row = sheet.addRow([
        s.adm_no, s.name, s.gender,
        s.date_of_birth ? new Date(s.date_of_birth).toLocaleDateString('en-KE') : '',
        s.class_name || '',
        s.parent_name || '', s.parent_phone || '', s.parent_email || '',
        s.address || '', s.county || '', s.year_joined || '',
        s.blood_group || '', s.allergies || '', s.chronic_conditions || '',
        s.current_medication || '', s.emergency_contact_phone || '',
        parseFloat(s.total_expected || 0),
        parseFloat(s.total_paid || 0),
        parseFloat(s.balance || 0)
      ]);

      // Alternate row colors
      const bgColor = index % 2 === 0 ? 'FFFFFFFF' : 'FFf0fdf4';
      row.eachCell(cell => {
        cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: bgColor } };
        cell.alignment = { vertical: 'middle', wrapText: false };
      });

      // Color balance cell red if outstanding
      const balanceCell = row.getCell(19);
      if (parseFloat(s.balance || 0) > 0) {
        balanceCell.font = { color: { argb: 'FFdc2626' }, bold: true };
      } else {
        balanceCell.font = { color: { argb: 'FF16a34a' }, bold: true };
      }

      // Color health alert cells
      if (s.allergies && s.allergies !== 'None') {
        row.getCell(13).font = { color: { argb: 'FFdc2626' }, bold: true };
      }
      if (s.chronic_conditions && s.chronic_conditions !== 'None') {
        row.getCell(14).font = { color: { argb: 'FF7c3aed' }, bold: true };
      }
    });

    // Column widths
    const widths = [12, 25, 10, 14, 12, 20, 15, 25, 20, 15, 12, 12, 20, 20, 25, 18, 18, 16, 14];
    widths.forEach((w, i) => { sheet.getColumn(i + 1).width = w; });

    // Summary row
    sheet.addRow([]);
    const summaryRow = sheet.addRow([
      '', 'TOTAL STUDENTS: ' + students.length, '', '', '',
      '', '', '', '', '', '',
      '', '', '', '', '',
      students.reduce((s, r) => s + parseFloat(r.total_expected || 0), 0),
      students.reduce((s, r) => s + parseFloat(r.total_paid || 0), 0),
      students.reduce((s, r) => s + parseFloat(r.balance || 0), 0)
    ]);
    summaryRow.eachCell(cell => {
      cell.font = { bold: true };
      cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFd1fae5' } };
    });

    // Auto filter
    sheet.autoFilter = { from: 'A2', to: 'S2' };

    // Stream the file
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', `attachment; filename="Students_${academic_year}_${Date.now()}.xlsx"`);
    await workbook.xlsx.write(res);
    res.end();
  } catch (err) {
    console.error('Excel export error:', err.message);
    res.status(500).json({ success: false, message: 'Failed to export: ' + err.message });
  }
});
module.exports = router;