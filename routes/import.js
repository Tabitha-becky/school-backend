const express = require('express');
const multer = require('multer');
const ExcelJS = require('exceljs');
const { query } = require('../config/db');
const { authenticate, authorize } = require('../middleware/auth');

const router = express.Router();
router.use(authenticate);

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 10 * 1024 * 1024 } });

// Download template
router.get('/template', authorize('admin', 'principal'), async (req, res) => {
  const workbook = new ExcelJS.Workbook();
  const sheet = workbook.addWorksheet('Students');

  sheet.mergeCells('A1:N1');
  sheet.getCell('A1').value = 'EduTrack Kenya — Student Import Template';
  sheet.getCell('A1').font = { bold: true, size: 13, color: { argb: 'FFFFFFFF' } };
  sheet.getCell('A1').fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF064e3b' } };
  sheet.getCell('A1').alignment = { horizontal: 'center' };
  sheet.getRow(1).height = 28;

  const headers = ['adm_no*', 'name*', 'gender', 'date_of_birth', 'class_name', 'parent_name', 'parent_phone*', 'parent_email', 'address', 'blood_group', 'allergies', 'chronic_conditions', 'current_medication', 'emergency_contact_phone'];
  const headerRow = sheet.addRow(headers);
  headerRow.eachCell(cell => {
    cell.font = { bold: true, color: { argb: 'FFFFFFFF' } };
    cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF065f46' } };
    cell.alignment = { horizontal: 'center' };
  });
  sheet.getRow(2).height = 20;

  // Example rows
  const examples = [
    ['ADM001', 'John Kamau', 'Male', '2010-03-15', 'Form 1A', 'James Kamau', '0712345678', 'james@email.com', 'Nairobi', 'O+', 'None', 'None', 'None', '0712345679'],
    ['ADM002', 'Mary Wanjiku', 'Female', '2010-07-22', 'Form 1A', 'Grace Wanjiku', '0723456789', '', 'Kiambu', 'A+', 'Peanuts', 'Asthma', 'Carries inhaler', '0723456780'],
  ];
  examples.forEach((row, idx) => {
    const r = sheet.addRow(row);
    r.eachCell(cell => { cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: idx % 2 === 0 ? 'FFFFFFFF' : 'FFf0fdf4' } }; });
  });

  // Notes row
  sheet.addRow([]);
  const notesRow = sheet.addRow(['NOTES: * = required. date_of_birth format: YYYY-MM-DD. class_name must match exactly e.g. "Form 1A". gender: Male or Female. Leave optional fields blank.']);
  sheet.mergeCells(`A${notesRow.number}:N${notesRow.number}`);
  notesRow.getCell(1).font = { italic: true, color: { argb: 'FF6b7280' } };

  const widths = [12, 25, 10, 15, 12, 20, 15, 25, 20, 12, 20, 20, 25, 22];
  widths.forEach((w, i) => { sheet.getColumn(i + 1).width = w; });

  res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  res.setHeader('Content-Disposition', 'attachment; filename="EduTrack_Import_Template.xlsx"');
  await workbook.xlsx.write(res);
  res.end();
});

// Import students from Excel
router.post('/students', authorize('admin', 'principal'), upload.single('file'), async (req, res) => {
  if (!req.file) return res.status(400).json({ success: false, message: 'No file uploaded.' });

  const client = await require('../config/db').pool.connect();
  try {
    const workbook = new ExcelJS.Workbook();
    await workbook.xlsx.load(req.file.buffer);
    const sheet = workbook.worksheets[0];

    // Get classes for lookup
    const classResult = await client.query('SELECT id, name FROM classes');
    const classMap = {};
    classResult.rows.forEach(c => { classMap[c.name.toLowerCase().trim()] = c.id; });

    const results = { success: 0, skipped: 0, errors: [] };
    let rowNum = 0;

    sheet.eachRow((row, rowIndex) => {
      if (rowIndex <= 2) return; // Skip header rows
      const values = row.values; // 1-indexed
      const adm_no = String(values[1] || '').trim();
      const name = String(values[2] || '').trim();
      if (!adm_no || !name || adm_no === 'adm_no*') return;
      rowNum++;
      results._rows = results._rows || [];
      results._rows.push({ adm_no, name, gender: String(values[3] || 'Male').trim(), date_of_birth: values[4] ? String(values[4]).trim() : null, class_name: String(values[5] || '').trim(), parent_name: String(values[6] || '').trim(), parent_phone: String(values[7] || '').trim(), parent_email: String(values[8] || '').trim(), address: String(values[9] || '').trim(), blood_group: String(values[10] || 'Unknown').trim(), allergies: String(values[11] || 'None').trim(), chronic_conditions: String(values[12] || 'None').trim(), current_medication: String(values[13] || 'None').trim(), emergency_contact_phone: String(values[14] || '').trim() });
    });

    const rows = results._rows || [];
    delete results._rows;

    await client.query('BEGIN');

    for (const row of rows) {
      if (!row.adm_no || !row.name || !row.parent_phone) {
        results.errors.push(`Row skipped: missing adm_no, name or parent_phone (${row.adm_no || 'unknown'})`);
        results.skipped++;
        continue;
      }

      // Check duplicate
      const existing = await client.query('SELECT id FROM students WHERE adm_no = $1', [row.adm_no]);
      if (existing.rows.length > 0) {
        results.errors.push(`${row.adm_no} (${row.name}) already exists — skipped`);
        results.skipped++;
        continue;
      }

      const classId = row.class_name ? classMap[row.class_name.toLowerCase()] || null : null;
      let dob = null;
      if (row.date_of_birth && row.date_of_birth !== 'null') {
        try { dob = new Date(row.date_of_birth).toISOString().split('T')[0]; if (isNaN(new Date(dob))) dob = null; } catch { dob = null; }
      }

      const studentResult = await client.query(
        `INSERT INTO students (adm_no, name, class_id, gender, date_of_birth, parent_name, parent_phone, parent_email, address, year_joined)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING id`,
        [row.adm_no, row.name, classId, row.gender || 'Male', dob, row.parent_name || null, row.parent_phone, row.parent_email || null, row.address || null, new Date().getFullYear()]
      );

      const studentId = studentResult.rows[0].id;

      try {
        await client.query(
          `INSERT INTO health_records (student_id, blood_group, allergies, chronic_conditions, current_medication, emergency_contact_phone)
           VALUES ($1,$2,$3,$4,$5,$6)`,
          [studentId, row.blood_group || 'Unknown', row.allergies || 'None', row.chronic_conditions || 'None', row.current_medication || 'None', row.emergency_contact_phone || null]
        );
      } catch (e) { /* health record optional */ }

      results.success++;
    }

    await client.query('COMMIT');

    res.json({
      success: true,
      message: `Import complete! ${results.success} students imported, ${results.skipped} skipped.`,
      data: results
    });
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('Import error:', err);
    res.status(500).json({ success: false, message: 'Import failed: ' + err.message });
  } finally {
    client.release();
  }
});

module.exports = router;