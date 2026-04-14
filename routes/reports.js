const express = require('express');
const PDFDocument = require('pdfkit');
const { query } = require('../config/db');
const jwt = require('jsonwebtoken');

const router = express.Router();

const tokenAuth = (req, res, next) => {
  const token = req.query.token || (req.headers['authorization'] || '').split(' ')[1];
  if (!token) return res.status(401).json({ success: false, message: 'Access denied.' });
  try {
    req.user = jwt.verify(token, process.env.JWT_SECRET);
    next();
  } catch (e) {
    return res.status(401).json({ success: false, message: 'Invalid token.' });
  }
};

const getGrade = (avg) => {
  if (avg >= 80) return 'A';
  if (avg >= 75) return 'A-';
  if (avg >= 70) return 'B+';
  if (avg >= 65) return 'B';
  if (avg >= 60) return 'B-';
  if (avg >= 55) return 'C+';
  if (avg >= 50) return 'C';
  if (avg >= 45) return 'C-';
  if (avg >= 40) return 'D+';
  if (avg >= 35) return 'D';
  if (avg >= 30) return 'D-';
  return 'E';
};

const getComment = (grade) => {
  const map = {
    'A': 'Excellent performance. Keep it up!',
    'A-': 'Very good performance. Well done!',
    'B+': 'Good performance. Keep working hard.',
    'B': 'Good performance. Room for improvement.',
    'B-': 'Above average. Push yourself harder.',
    'C+': 'Average performance. More effort needed.',
    'C': 'Average performance. Needs improvement.',
    'C-': 'Below average. Requires more effort.',
    'D+': 'Poor performance. Needs urgent attention.',
    'D': 'Poor performance. Extra tuition recommended.',
    'D-': 'Very poor. Please see class teacher.',
    'E': 'Failed. Immediate intervention required.',
  };
  return map[grade] || 'Keep working hard.';
};

router.get('/report-card/:student_id', tokenAuth, async (req, res) => {
  try {
    const term = req.query.term || 'Term 1 2024';
    const academic_year = req.query.academic_year || '2024';
    const student_id = req.params.student_id;

    const studentResult = await query(
      'SELECT s.*, c.name AS class_name FROM students s LEFT JOIN classes c ON s.class_id = c.id WHERE s.id = $1',
      [student_id]
    );

    if (studentResult.rows.length === 0) {
      return res.status(404).json({ success: false, message: 'Student not found.' });
    }

    const student = studentResult.rows[0];

    const marksResult = await query(
      'SELECT ar.cat1, ar.cat2, ar.exam, ar.average, ar.grade, sub.name AS subject_name FROM academic_records ar JOIN subjects sub ON ar.subject_id = sub.id WHERE ar.student_id = $1 AND ar.term = $2 AND ar.academic_year = $3 ORDER BY sub.name',
      [student_id, term, academic_year]
    );

    const feeResult = await query(
      'SELECT COALESCE(SUM(amount_expected - amount_paid), 0) AS balance FROM fee_payments WHERE student_id = $1 AND academic_year = $2',
      [student_id, academic_year]
    );

    const classSizeResult = await query(
      'SELECT COUNT(*) FROM students WHERE class_id = $1 AND is_active = TRUE',
      [student.class_id]
    );

    const subjects = marksResult.rows;
    const feeBalance = parseFloat(feeResult.rows[0] ? feeResult.rows[0].balance : 0);
    const classSize = classSizeResult.rows[0] ? classSizeResult.rows[0].count : '-';

    const avgScore = subjects.length
      ? subjects.reduce((s, r) => s + parseFloat(r.average || 0), 0) / subjects.length
      : 0;

    const meanGrade = getGrade(Math.round(avgScore));
    const overallComment = getComment(meanGrade);
    const schoolName = process.env.SCHOOL_NAME || 'EduTrack Academy';
    const schoolMotto = process.env.SCHOOL_MOTTO || 'Excellence Through Knowledge';
    const schoolPhone = process.env.SCHOOL_PHONE || '';
    const schoolEmail = process.env.SCHOOL_EMAIL || '';
    const schoolAddress = process.env.SCHOOL_ADDRESS || '';

    // Create PDF
    const doc = new PDFDocument({ margin: 40, size: 'A4' });
    const filename = 'ReportCard_' + student.adm_no + '_' + term.replace(/ /g, '_') + '.pdf';

    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', 'attachment; filename="' + filename + '"');
    doc.pipe(res);

    // Header
    doc.rect(0, 0, doc.page.width, 120).fill('#064e3b');
    doc.fillColor('white').fontSize(20).font('Helvetica-Bold')
      .text(schoolName.toUpperCase(), 40, 20, { align: 'center' });
    doc.fontSize(11).font('Helvetica')
      .text('"' + schoolMotto + '"', 40, 46, { align: 'center' });
    doc.fontSize(9)
      .text(schoolPhone + '  |  ' + schoolEmail + '  |  ' + schoolAddress, 40, 62, { align: 'center' });
    doc.fontSize(14).font('Helvetica-Bold').fillColor('#f59e0b')
      .text('STUDENT PROGRESS REPORT - ' + term.toUpperCase() + ' ' + academic_year, 40, 82, { align: 'center' });

    let y = 135;

    // Student info box
    doc.rect(40, y, doc.page.width - 80, 90).fill('#f0fdf4').stroke('#064e3b');
    doc.fillColor('#064e3b').fontSize(11).font('Helvetica-Bold').text('STUDENT INFORMATION', 50, y + 8);
    doc.fillColor('#333').fontSize(10).font('Helvetica');

    const col1x = 50, col2x = 310;
    const infoItems = [
      ['Student Name:', student.name],
      ['Admission No.:', student.adm_no],
      ['Class:', student.class_name || '-'],
      ['Academic Year:', academic_year],
      ['Term:', term],
      ['Parent/Guardian:', student.parent_name || '-'],
    ];

    infoItems.forEach((item, i) => {
      const x = i % 2 === 0 ? col1x : col2x;
      const iy = y + 24 + Math.floor(i / 2) * 18;
      doc.font('Helvetica-Bold').text(item[0], x, iy, { continued: true });
      doc.font('Helvetica').text(' ' + item[1]);
    });

    y += 105;

    // Academic table header
    doc.rect(40, y, doc.page.width - 80, 22).fill('#064e3b');
    doc.fillColor('white').fontSize(10).font('Helvetica-Bold');
    doc.text('Subject', 50, y + 6);
    doc.text('CAT 1', 230, y + 6, { width: 60, align: 'center' });
    doc.text('CAT 2', 290, y + 6, { width: 60, align: 'center' });
    doc.text('Exam', 350, y + 6, { width: 60, align: 'center' });
    doc.text('Average', 410, y + 6, { width: 60, align: 'center' });
    doc.text('Grade', 470, y + 6, { width: 60, align: 'center' });
    y += 22;

    if (subjects.length === 0) {
      doc.rect(40, y, doc.page.width - 80, 30).fill('#f9fafb');
      doc.fillColor('#9ca3af').fontSize(10).font('Helvetica')
        .text('No academic records for this term', 40, y + 9, { align: 'center', width: doc.page.width - 80 });
      y += 30;
    } else {
      subjects.forEach((s, i) => {
        const avg = Math.round(parseFloat(s.average || 0));
        const grade = getGrade(avg);
        const rowBg = i % 2 === 0 ? 'white' : '#f9fafb';
        doc.rect(40, y, doc.page.width - 80, 20).fill(rowBg);
        doc.fillColor('#111').fontSize(10).font('Helvetica-Bold').text(s.subject_name, 50, y + 5);
        doc.font('Helvetica').fillColor('#333');
        doc.text(s.cat1 ? String(s.cat1) : '-', 230, y + 5, { width: 60, align: 'center' });
        doc.text(s.cat2 ? String(s.cat2) : '-', 290, y + 5, { width: 60, align: 'center' });
        doc.text(s.exam ? String(s.exam) : '-', 350, y + 5, { width: 60, align: 'center' });
        doc.font('Helvetica-Bold').text(avg + '%', 410, y + 5, { width: 60, align: 'center' });
        doc.text(grade, 470, y + 5, { width: 60, align: 'center' });
        y += 20;
      });
    }

    y += 15;

    // Summary boxes
    const boxW = 140, boxH = 55, gap = 15;
    const startX = 40;

    const boxes = [
      { label: 'Overall Average', value: Math.round(avgScore) + '%', color: '#064e3b' },
      { label: 'Mean Grade', value: meanGrade, color: '#1d4ed8' },
      { label: 'Class Size', value: String(classSize), color: '#7c3aed' },
    ];

    boxes.forEach((box, i) => {
      const bx = startX + i * (boxW + gap);
      doc.rect(bx, y, boxW, boxH).fill(box.color);
      doc.fillColor('white').fontSize(20).font('Helvetica-Bold')
        .text(box.value, bx, y + 8, { width: boxW, align: 'center' });
      doc.fontSize(9).font('Helvetica')
        .text(box.label, bx, y + 33, { width: boxW, align: 'center' });
    });

    y += boxH + 15;

    // Comment box
    doc.rect(40, y, doc.page.width - 80, 40).fill('#f0fdf4').stroke('#064e3b');
    doc.fillColor('#064e3b').fontSize(9).font('Helvetica-Bold').text('CLASS TEACHER\'S COMMENT', 50, y + 6);
    doc.fillColor('#333').fontSize(10).font('Helvetica').text(overallComment, 50, y + 20);
    y += 55;

    // Fee notice
    if (feeBalance > 0) {
      doc.rect(40, y, doc.page.width - 80, 30).fill('#fee2e2');
      doc.fillColor('#dc2626').fontSize(10).font('Helvetica-Bold')
        .text('OUTSTANDING FEE BALANCE: KES ' + Number(feeBalance).toLocaleString() + ' - Please clear before next term.', 50, y + 9);
    } else {
      doc.rect(40, y, doc.page.width - 80, 30).fill('#d1fae5');
      doc.fillColor('#065f46').fontSize(10).font('Helvetica-Bold')
        .text('Fees are fully paid for ' + academic_year + '. Thank you!', 50, y + 9, { align: 'center', width: doc.page.width - 80 });
    }
    y += 45;

    // Signatures
    doc.fillColor('#064e3b').fontSize(10).font('Helvetica-Bold').text('AUTHORISATION', 40, y);
    y += 15;
    const sigPositions = [40, 200, 360];
    const sigLabels = ['Class Teacher', 'Principal / Head Teacher', 'Parent / Guardian'];
    sigPositions.forEach((sx, i) => {
      doc.moveTo(sx, y + 35).lineTo(sx + 130, y + 35).stroke('#111');
      doc.fillColor('#6b7280').fontSize(9).font('Helvetica').text(sigLabels[i], sx, y + 40);
    });

    y += 65;

    // Footer
    doc.fillColor('#9ca3af').fontSize(8).font('Helvetica')
      .text('Generated by EduTrack Kenya on ' + new Date().toLocaleDateString('en-KE', { year: 'numeric', month: 'long', day: 'numeric' }) + '  |  ' + schoolPhone + '  |  ' + schoolEmail,
        40, y, { align: 'center', width: doc.page.width - 80 });

    doc.end();
  } catch (err) {
    console.error('Report card error:', err.message);
    if (!res.headersSent) {
      res.status(500).json({ success: false, message: 'Failed to generate report card: ' + err.message });
    }
  }
});

module.exports = router;

// GET /api/reports/id-card/:student_id — PDF Student ID Card
router.get('/id-card/:student_id', tokenAuth, async (req, res) => {
  try {
    const PDFDocument = require('pdfkit');
    const studentResult = await query(
      'SELECT s.*, c.name AS class_name FROM students s LEFT JOIN classes c ON s.class_id = c.id WHERE s.id = $1',
      [req.params.student_id]
    );
    if (studentResult.rows.length === 0) {
      return res.status(404).json({ success: false, message: 'Student not found.' });
    }
    const student = studentResult.rows[0];
    const schoolName = process.env.SCHOOL_NAME || 'EduTrack Academy';
    const schoolPhone = process.env.SCHOOL_PHONE || '';
    const academicYear = '2024';

    const doc = new PDFDocument({ size: [243, 153], margin: 0 });
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename="ID_${student.adm_no}.pdf"`);
    doc.pipe(res);

    // Front of card
    // Green header
    doc.rect(0, 0, 243, 40).fill('#064e3b');
    doc.fillColor('white').fontSize(9).font('Helvetica-Bold')
      .text(schoolName.toUpperCase(), 0, 8, { align: 'center', width: 243 });
    doc.fontSize(7).font('Helvetica').fillColor('#a7f3d0')
      .text('STUDENT IDENTITY CARD — ' + academicYear, 0, 20, { align: 'center', width: 243 });

    // Photo placeholder
    doc.rect(8, 46, 50, 60).stroke('#064e3b');
    doc.fillColor('#f0fdf4').rect(9, 47, 48, 58).fill();
    doc.fillColor('#9ca3af').fontSize(6).font('Helvetica')
      .text('PHOTO', 8, 72, { align: 'center', width: 50 });

    // Student details
    doc.fillColor('#064e3b').fontSize(10).font('Helvetica-Bold')
      .text(student.name, 68, 48, { width: 165 });
    doc.fillColor('#374151').fontSize(7.5).font('Helvetica');
    const details = [
      ['Adm. No.', student.adm_no],
      ['Class', student.class_name || '—'],
      ['Gender', student.gender || '—'],
      ['Blood Group', student.blood_group || '—'],
    ];
    details.forEach(([label, value], i) => {
      doc.fillColor('#6b7280').font('Helvetica').text(label + ':', 68, 63 + i * 11, { continued: true });
      doc.fillColor('#111').font('Helvetica-Bold').text(' ' + value);
    });

    // Bottom strip
    doc.rect(0, 118, 243, 35).fill('#064e3b');
    doc.fillColor('#f59e0b').fontSize(7).font('Helvetica-Bold')
      .text('If found please call: ' + schoolPhone, 0, 124, { align: 'center', width: 243 });
    doc.fillColor('#a7f3d0').fontSize(6).font('Helvetica')
      .text('This card is property of ' + schoolName, 0, 134, { align: 'center', width: 243 });

    // Adm No barcode-style strip
    doc.fillColor('#1a1a1a').fontSize(7).font('Helvetica-Bold')
      .text(student.adm_no, 0, 144, { align: 'center', width: 243 });

    doc.end();
  } catch (err) {
    console.error('ID card error:', err.message);
    if (!res.headersSent) res.status(500).json({ success: false, message: 'Failed: ' + err.message });
  }
});