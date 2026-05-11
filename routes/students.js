const express = require('express');
const { query } = require('../config/db');
const { authenticate, authorize } = require('../middleware/auth');

const router = express.Router();

router.use((req, res, next) => {
  if (req.path.startsWith('/export') && req.query.token) {
    req.headers['authorization'] = `Bearer ${req.query.token}`;
  }
  next();
});
router.use(authenticate);

// GET all students
router.get('/', async (req, res) => {
  try {
    const { class_id, search, page = 1, limit = 50, active = 'true' } = req.query;
    const offset = (page - 1) * limit;
    const conditions = ['s.is_active = $1'];
    const params = [active === 'true'];
    let paramIndex = 2;

    if (class_id) { conditions.push(`s.class_id = $${paramIndex++}`); params.push(class_id); }
    if (search) {
      conditions.push(`(s.name ILIKE $${paramIndex} OR s.adm_no ILIKE $${paramIndex})`);
      params.push(`%${search}%`);
      paramIndex++;
    }

    const whereClause = `WHERE ${conditions.join(' AND ')}`;
    const sql = `
      SELECT s.id, s.adm_no, s.name, s.gender, s.date_of_birth,
             s.parent_name, s.parent_phone, s.parent_email,
             s.address, s.year_joined, s.created_at,
             c.name AS class_name, c.id AS class_id,
             COALESCE(SUM(fp.amount_paid), 0) AS total_paid,
             COALESCE(SUM(fp.amount_expected), 0) AS total_expected,
             COALESCE(SUM(fp.amount_expected - fp.amount_paid), 0) AS balance,
             CASE WHEN hr.allergies IS NOT NULL AND hr.allergies != 'None'
                  THEN TRUE ELSE FALSE END AS has_health_alert
      FROM students s
      LEFT JOIN classes c ON s.class_id = c.id
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

    const [data, count] = await Promise.all([query(sql, params), query(countSql, countParams)]);

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

// GET single student
router.get('/:id', async (req, res) => {
  try {
    const studentResult = await query(
      'SELECT s.*, c.name AS class_name FROM students s LEFT JOIN classes c ON s.class_id = c.id WHERE s.id = $1',
      [req.params.id]
    );
    if (studentResult.rows.length === 0) {
      return res.status(404).json({ success: false, message: 'Student not found.' });
    }
    const student = studentResult.rows[0];

    const [healthResult, feesResult, academicsResult, attendanceResult] = await Promise.all([
      query('SELECT * FROM health_records WHERE student_id = $1', [student.id]),
      query('SELECT fp.*, u.name AS received_by_name FROM fee_payments fp LEFT JOIN users u ON fp.received_by = u.id WHERE fp.student_id = $1 ORDER BY fp.payment_date DESC', [student.id]),
      query('SELECT ar.*, s.name AS subject_name FROM academic_records ar JOIN subjects s ON ar.subject_id = s.id WHERE ar.student_id = $1 ORDER BY ar.term, s.name', [student.id]),
      query("SELECT COUNT(*) FILTER (WHERE status = 'present') AS present, COUNT(*) FILTER (WHERE status = 'absent') AS absent, COUNT(*) FILTER (WHERE status = 'late') AS late, COUNT(*) AS total FROM attendance WHERE student_id = $1", [student.id]),
    ]);

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

// POST create student
router.post('/', authorize('admin', 'principal', 'bursar'), async (req, res) => {
  const client = await require('../config/db').pool.connect();
  try {
    await client.query('BEGIN');

 const {
  adm_no,
  name,
  class_id,
  gender,
  date_of_birth,
  parent_name,
  parent_phone,
  parent_email,
  address,
  county,
  year_joined,
  joining_term = 1,

  blood_group = 'Unknown',
  allergies = 'None',
  chronic_conditions = 'None',
  current_medication = 'None',
  emergency_contact_phone,
} = req.body;

    if (!adm_no || !name || !parent_phone) {
      await client.query('ROLLBACK');
      return res.status(400).json({ success: false, message: 'Admission number, name and parent phone are required.' });
    }

    const existing = await client.query('SELECT id FROM students WHERE adm_no = $1', [adm_no]);
    if (existing.rows.length > 0) {
      await client.query('ROLLBACK');
      return res.status(409).json({ success: false, message: `Admission number ${adm_no} already exists.` });
    }

    const studentResult = await client.query(
      `INSERT INTO students (adm_no, name, class_id, gender, date_of_birth, parent_name, parent_phone, parent_email, address, county, year_joined)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) RETURNING *`,
      [adm_no, name.trim(), class_id || null, gender || null, date_of_birth || null,
       parent_name || null, parent_phone, parent_email || null,
       address || null, county || null, year_joined || new Date().getFullYear()]
    );
try {

  const currentTermRes = await client.query(
    `SELECT *
     FROM school_settings
     WHERE term_start_date <= CURRENT_DATE
     AND term_end_date >= CURRENT_DATE
     ORDER BY term_start_date DESC
     LIMIT 1`
  );

  const currentTerm = currentTermRes.rows[0];

  if (currentTerm && class_id) {

    // 🚨 IMPORTANT: only charge from joining term onward
    if (currentTerm.term < joining_term) {
      return;
    }

    // prevent duplicate fee creation for same term
    const existingFee = await client.query(
      `SELECT id FROM fee_payments
       WHERE student_id = $1
       AND term = $2
       AND academic_year = $3`,
      [student.id, currentTerm.term, currentTerm.academic_year]
    );

    if (existingFee.rows.length > 0) {
      return;
    }

    const feeStructure = await client.query(
      `SELECT *
       FROM fee_structures
       WHERE class_id = $1
       AND term = $2
       AND academic_year = $3
       LIMIT 1`,
      [class_id, currentTerm.term, currentTerm.academic_year]
    );

    if (feeStructure.rows.length > 0) {

      const structure = feeStructure.rows[0];

      // 🔥 ARREARS FIX (only unpaid balances)
      const arrearsResult = await client.query(
        `SELECT COALESCE(SUM(balance_after), 0) AS arrears
         FROM fee_payments
         WHERE student_id = $1
         AND balance_after > 0`,
        [student.id]
      );

      const previousArrears = parseFloat(arrearsResult.rows[0].arrears || 0);

      const termFee = parseFloat(structure.total_amount || 0);
      const totalExpected = termFee + previousArrears;

      const receiptNo = `RCP-${new Date().getFullYear().toString().slice(-2)}${String(new Date().getMonth() + 1).padStart(2,'0')}-${Math.floor(Math.random() * 9000) + 1000}`;

      await client.query(
        `INSERT INTO fee_payments (
            student_id,
            term,
            academic_year,
            amount_paid,
            amount_expected,
            payment_method,
            balance_before,
            balance_after,
            receipt_no,
            received_by
         )
         VALUES ($1,$2,$3,0,$4,'Pending',$5,$6,$7,$8)`,
        [
          student.id,
          currentTerm.term,
          currentTerm.academic_year,
          totalExpected,
          previousArrears,
          totalExpected,
          receiptNo,
          req.user.id
        ]
      );
    }
  }

} catch (feeErr) {
  console.log('Fee auto-generate skipped:', feeErr.message);
}
    const student = studentResult.rows[0];

   

    // Insert basic health record
    try {
      await client.query(
        `INSERT INTO health_records (student_id, blood_group, allergies, chronic_conditions, current_medication, emergency_contact_phone)
         VALUES ($1,$2,$3,$4,$5,$6)`,
        [student.id, blood_group, allergies, chronic_conditions, current_medication, emergency_contact_phone || null]
      );
    } catch (healthErr) {
      console.log('Health record insert skipped:', healthErr.message);
    }

    await client.query('COMMIT');

    res.status(201).json({
      success: true,
      message: `${name} registered successfully.`,
      data: { id: student.id, adm_no: student.adm_no, name: student.name },
    });
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('Create student error:', err);
    res.status(500).json({ success: false, message: 'Failed to register student: ' + err.message });
  } finally {
    client.release();
  }
});

// PUT update student
router.put('/:id', authorize('admin', 'principal'), async (req, res) => {
  try {

    const {
      name,
      class_id,
      gender,
      date_of_birth,
      parent_name,
      parent_phone,
      parent_email,
      address,
      county,

      // HEALTH DETAILS
      blood_group,
      allergies,
      chronic_conditions,
      current_medication,
      emergency_contact_phone

    } = req.body;

    // UPDATE STUDENT DETAILS
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
        county = COALESCE($9, county)
      WHERE id = $10
      RETURNING id, name, adm_no`,
      [
        name,
        class_id,
        gender,
        date_of_birth || null,
        parent_name,
        parent_phone,
        parent_email,
        address,
        county,
        req.params.id
      ]
    );

    // CHECK IF STUDENT EXISTS
    if (result.rows.length === 0) {
      return res.status(404).json({
        success: false,
        message: 'Student not found.'
      });
    }

    // UPDATE HEALTH RECORDS
    await query(
      `UPDATE health_records SET
        blood_group = COALESCE($1, blood_group),
        allergies = COALESCE($2, allergies),
        chronic_conditions = COALESCE($3, chronic_conditions),
        current_medication = COALESCE($4, current_medication),
        emergency_contact_phone = COALESCE($5, emergency_contact_phone)
      WHERE student_id = $6`,
      [
        blood_group,
        allergies,
        chronic_conditions,
        current_medication,
        emergency_contact_phone,
        req.params.id
      ]
    );

    res.json({
      success: true,
      message: 'Student and health details updated successfully.',
      data: result.rows[0]
    });

  } catch (err) {

    console.error('Update student error:', err);

    res.status(500).json({
      success: false,
      message: 'Server error.'
    });

  }
});

// DELETE student
router.delete('/:id', authorize('admin', 'principal'), async (req, res) => {
  try {
    await query('UPDATE students SET is_active = FALSE WHERE id = $1', [req.params.id]);
    res.json({ success: true, message: 'Student deactivated.' });
  } catch (err) {
    res.status(500).json({ success: false, message: 'Server error.' });
  }
});

// GET students by class
router.get('/class/:class_id', async (req, res) => {
  try {
    const result = await query(
      `SELECT s.id, s.adm_no, s.name, s.gender,
              hr.allergies, hr.chronic_conditions,
              CASE WHEN hr.allergies IS NOT NULL AND hr.allergies != 'None' THEN TRUE ELSE FALSE END AS has_health_alert
       FROM students s LEFT JOIN health_records hr ON s.id = hr.student_id
       WHERE s.class_id = $1 AND s.is_active = TRUE ORDER BY s.name`,
      [req.params.class_id]
    );
    res.json({ success: true, data: result.rows });
  } catch (err) {
    res.status(500).json({ success: false, message: 'Server error.' });
  }
});

// Excel export
router.get('/export/excel', async (req, res) => {
  try {
    const ExcelJS = require('exceljs');
    const { class_id, academic_year = String(new Date().getFullYear()) } = req.query;
    let sql = `SELECT s.adm_no, s.name, s.gender, s.date_of_birth, c.name AS class_name,
                      s.parent_name, s.parent_phone, s.parent_email, s.address, s.county, s.year_joined,
                      hr.blood_group, hr.allergies, hr.chronic_conditions, hr.current_medication, hr.emergency_contact_phone,
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
    const sheet = workbook.addWorksheet('Students');
    sheet.mergeCells('A1:S1');
    sheet.getCell('A1').value = (process.env.SCHOOL_NAME || 'EduTrack Kenya') + ' — Student List (' + academic_year + ')';
    sheet.getCell('A1').font = { bold: true, size: 14, color: { argb: 'FFFFFFFF' } };
    sheet.getCell('A1').fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF064e3b' } };
    sheet.getCell('A1').alignment = { horizontal: 'center' };
    sheet.getRow(1).height = 30;

    const headers = ['Adm. No.','Name','Gender','Date of Birth','Class','Parent Name','Parent Phone','Parent Email','Address','County','Year Joined','Blood Group','Allergies','Conditions','Medication','Emergency Contact','Total Expected','Total Paid','Balance'];
    const headerRow = sheet.addRow(headers);
    headerRow.eachCell(cell => {
      cell.font = { bold: true, color: { argb: 'FFFFFFFF' } };
      cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF065f46' } };
      cell.alignment = { horizontal: 'center' };
    });

    students.forEach((s, idx) => {
      const row = sheet.addRow([
        s.adm_no, s.name, s.gender,
        s.date_of_birth ? new Date(s.date_of_birth).toLocaleDateString('en-KE') : '',
        s.class_name || '', s.parent_name || '', s.parent_phone || '', s.parent_email || '',
        s.address || '', s.county || '', s.year_joined || '',
        s.blood_group || '', s.allergies || '', s.chronic_conditions || '',
        s.current_medication || '', s.emergency_contact_phone || '',
        parseFloat(s.total_expected || 0), parseFloat(s.total_paid || 0), parseFloat(s.balance || 0)
      ]);
      row.eachCell(cell => {
        cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: idx % 2 === 0 ? 'FFFFFFFF' : 'FFf0fdf4' } };
      });
    });

    const widths = [12,25,10,14,12,20,15,25,20,15,12,12,20,20,25,18,18,16,14];
    widths.forEach((w, i) => { sheet.getColumn(i + 1).width = w; });
    sheet.autoFilter = { from: 'A2', to: 'S2' };

    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', `attachment; filename="Students_${academic_year}.xlsx"`);
    await workbook.xlsx.write(res);
    res.end();
  } catch (err) {
    console.error('Excel export error:', err.message);
    res.status(500).json({ success: false, message: 'Failed to export: ' + err.message });
  }
});

module.exports = router;