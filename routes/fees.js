const express = require('express');
const PDFDocument = require('pdfkit');
const { query } = require('../config/db');
const { authenticate, authorize } = require('../middleware/auth');

const router = express.Router();

router.use((req, res, next) => {
  if (req.path.startsWith('/receipt') && req.query.token) {
    req.headers['authorization'] = `Bearer ${req.query.token}`;
  }
  next();
});
router.use(authenticate);

const generateReceiptNo = () => {
  const date = new Date();
  const yy = date.getFullYear().toString().slice(-2);
  const mm = String(date.getMonth() + 1).padStart(2, '0');
  const rand = Math.floor(Math.random() * 9000) + 1000;
  return `RCP-${yy}${mm}-${rand}`;
};

router.get('/summary', async (req, res) => {
  try {
    const { term, academic_year = '2024' } = req.query;
    const termFilter = term ? 'AND fp.term = $2' : '';
    const params = term ? [academic_year, term] : [academic_year];

    const result = await query(
      `SELECT COUNT(DISTINCT s.id) AS total_students,
              COALESCE(SUM(fp.amount_paid), 0) AS total_collected,
              COALESCE(SUM(fp.amount_expected - fp.amount_paid), 0) AS total_outstanding,
              COALESCE(SUM(fp.amount_expected), 0) AS total_expected,
              COUNT(DISTINCT CASE WHEN fp.amount_expected > fp.amount_paid THEN s.id END) AS students_with_balance
       FROM students s
       LEFT JOIN fee_payments fp ON s.id = fp.student_id AND fp.academic_year = $1 ${termFilter}
       WHERE s.is_active = TRUE`,
      params
    );

    const methodBreakdown = await query(
      `SELECT payment_method, COUNT(*) AS count, SUM(amount_paid) AS total
       FROM fee_payments WHERE academic_year = $1 ${term ? 'AND term = $2' : ''}
       GROUP BY payment_method ORDER BY total DESC`,
      params
    );

    const recent = await query(
      `SELECT fp.*, s.name AS student_name, s.adm_no
       FROM fee_payments fp JOIN students s ON fp.student_id = s.id
       WHERE fp.academic_year = $1 ${term ? 'AND fp.term = $2' : ''}
       ORDER BY fp.created_at DESC LIMIT 10`,
      params
    );

    res.json({ success: true, data: { summary: result.rows[0], byMethod: methodBreakdown.rows, recentPayments: recent.rows } });
  } catch (err) {
    console.error('Fee summary error:', err);
    res.status(500).json({ success: false, message: 'Server error.' });
  }
});

router.get('/balances', async (req, res) => {
  try {
    const { term, academic_year = '2024', class_id } = req.query;
    const conditions = ['s.is_active = TRUE'];
    const params = [];
    let i = 1;
    if (term) { conditions.push(`fp.term = $${i++}`); params.push(term); }
    if (academic_year) { conditions.push(`fp.academic_year = $${i++}`); params.push(academic_year); }
    if (class_id) { conditions.push(`s.class_id = $${i++}`); params.push(class_id); }

    const result = await query(
      `SELECT s.id, s.adm_no, s.name, s.parent_phone, c.name AS class_name,
              COALESCE(SUM(fp.amount_paid), 0) AS total_paid,
              COALESCE(SUM(fp.amount_expected), 0) AS total_expected,
              COALESCE(SUM(fp.amount_expected - fp.amount_paid), 0) AS balance
       FROM students s LEFT JOIN classes c ON s.class_id = c.id
       LEFT JOIN fee_payments fp ON s.id = fp.student_id
       ${conditions.length ? 'WHERE ' + conditions.join(' AND ') : ''}
       GROUP BY s.id, s.adm_no, s.name, s.parent_phone, c.name
       HAVING COALESCE(SUM(fp.amount_expected - fp.amount_paid), 0) > 0
       ORDER BY balance DESC`,
      params
    );
    res.json({ success: true, data: result.rows, count: result.rows.length });
  } catch (err) {
    res.status(500).json({ success: false, message: 'Server error.' });
  }
});

router.get('/student/:student_id', async (req, res) => {
  try {
    const payments = await query(
      `SELECT fp.*, u.name AS received_by_name FROM fee_payments fp
       LEFT JOIN users u ON fp.received_by = u.id
       WHERE fp.student_id = $1 ORDER BY fp.payment_date DESC`,
      [req.params.student_id]
    );
    const summary = await query(
      `SELECT COALESCE(SUM(amount_paid), 0) AS total_paid,
              COALESCE(SUM(amount_expected), 0) AS total_expected,
              COALESCE(SUM(amount_expected - amount_paid), 0) AS balance,
              COUNT(*) AS payment_count
       FROM fee_payments WHERE student_id = $1`,
      [req.params.student_id]
    );
    res.json({ success: true, data: { payments: payments.rows, summary: summary.rows[0] } });
  } catch (err) {
    res.status(500).json({ success: false, message: 'Server error.' });
  }
});

router.post('/payment', authorize('admin', 'principal', 'bursar'), async (req, res) => {
  try {
    const { student_id, term, academic_year = '2024', amount_paid, amount_expected, payment_method, reference_no, payment_date, notes } = req.body;

    if (!student_id || !amount_paid || !payment_method) {
      return res.status(400).json({ success: false, message: 'student_id, amount_paid, and payment_method are required.' });
    }

    const balanceResult = await query(
      `SELECT COALESCE(SUM(amount_expected - amount_paid), 0) AS balance
       FROM fee_payments WHERE student_id = $1 AND term = $2 AND academic_year = $3`,
      [student_id, term, academic_year]
    );
    const balanceBefore = parseFloat(balanceResult.rows[0].balance);
    const balanceAfter = Math.max(0, balanceBefore - parseFloat(amount_paid));
    const receiptNo = generateReceiptNo();

    const result = await query(
      `INSERT INTO fee_payments (student_id, term, academic_year, amount_paid, amount_expected, payment_method, reference_no, payment_date, balance_before, balance_after, notes, received_by, receipt_no)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13) RETURNING *`,
      [student_id, term, academic_year, amount_paid, amount_expected || null, payment_method, reference_no, payment_date || new Date().toISOString().split('T')[0], balanceBefore, balanceAfter, notes, req.user.id, receiptNo]
    );

    const studentResult = await query('SELECT name, adm_no, parent_phone FROM students WHERE id = $1', [student_id]);

    res.status(201).json({
      success: true,
      message: `Payment of KES ${Number(amount_paid).toLocaleString()} recorded.`,
      data: { ...result.rows[0], student: studentResult.rows[0] },
    });
  } catch (err) {
    console.error('Payment error:', err);
    res.status(500).json({ success: false, message: 'Failed to record payment.' });
  }
});

// ── PDF RECEIPT using PDFKit ──────────────────────────────────
router.get('/receipt/:payment_id', async (req, res) => {
  try {
    const result = await query(
      `SELECT fp.*, s.name AS student_name, s.adm_no, s.parent_name, s.parent_phone,
              c.name AS class_name, u.name AS received_by_name
       FROM fee_payments fp
       JOIN students s ON fp.student_id = s.id
       LEFT JOIN classes c ON s.class_id = c.id
       LEFT JOIN users u ON fp.received_by = u.id
       WHERE fp.id = $1`,
      [req.params.payment_id]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ success: false, message: 'Receipt not found.' });
    }

    const p = result.rows[0];
    const schoolName = process.env.SCHOOL_NAME || 'EduTrack Academy';
    const schoolMotto = process.env.SCHOOL_MOTTO || 'Excellence Through Knowledge';
    const schoolPhone = process.env.SCHOOL_PHONE || '';
    const schoolEmail = process.env.SCHOOL_EMAIL || '';
    const schoolAddress = process.env.SCHOOL_ADDRESS || '';
    const payDate = new Date(p.payment_date || p.created_at).toLocaleDateString('en-KE', { year: 'numeric', month: 'long', day: 'numeric' });
    const now = new Date().toLocaleDateString('en-KE', { year: 'numeric', month: 'long', day: 'numeric' });

    const doc = new PDFDocument({ margin: 50, size: 'A4' });
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', 'attachment; filename="Receipt_' + p.receipt_no + '.pdf"');
    doc.pipe(res);

    // Green header
    doc.rect(0, 0, doc.page.width, 130).fill('#064e3b');
    doc.fillColor('white').fontSize(22).font('Helvetica-Bold')
      .text(schoolName.toUpperCase(), 50, 18, { align: 'center' });
    doc.fontSize(10).font('Helvetica')
      .text('"' + schoolMotto + '"', 50, 46, { align: 'center' });
    doc.fontSize(9)
      .text(schoolPhone + '  |  ' + schoolEmail + '  |  ' + schoolAddress, 50, 62, { align: 'center' });
    doc.fontSize(16).font('Helvetica-Bold').fillColor('#f59e0b')
      .text('OFFICIAL FEE RECEIPT', 50, 82, { align: 'center' });
    doc.fontSize(10).font('Helvetica').fillColor('#a7f3d0')
      .text('Receipt No: ' + p.receipt_no + '   |   Date: ' + payDate, 50, 105, { align: 'center' });

    let y = 150;

    // Student section
    doc.rect(50, y, doc.page.width - 100, 22).fill('#064e3b');
    doc.fillColor('white').fontSize(10).font('Helvetica-Bold')
      .text('STUDENT INFORMATION', 60, y + 6);
    y += 22;

    const studentRows = [
      ['Student Name', p.student_name],
      ['Admission No.', p.adm_no],
      ['Class', p.class_name || '-'],
      ['Parent / Guardian', p.parent_name || '-'],
      ['Parent Phone', p.parent_phone || '-'],
    ];

    studentRows.forEach((row, i) => {
      doc.rect(50, y, doc.page.width - 100, 20).fill(i % 2 === 0 ? 'white' : '#f9fafb');
      doc.fillColor('#6b7280').fontSize(10).font('Helvetica').text(row[0], 60, y + 5);
      doc.fillColor('#111').font('Helvetica-Bold').text(row[1], 250, y + 5);
      y += 20;
    });

    y += 15;

    // Payment section
    doc.rect(50, y, doc.page.width - 100, 22).fill('#064e3b');
    doc.fillColor('white').fontSize(10).font('Helvetica-Bold')
      .text('PAYMENT DETAILS', 60, y + 6);
    y += 22;

    const paymentRows = [
      ['Term', p.term],
      ['Academic Year', p.academic_year],
      ['Payment Method', p.payment_method],
      ['Reference No.', p.reference_no || '-'],
      ['Received By', p.received_by_name || 'System'],
    ];

    paymentRows.forEach((row, i) => {
      doc.rect(50, y, doc.page.width - 100, 20).fill(i % 2 === 0 ? 'white' : '#f9fafb');
      doc.fillColor('#6b7280').fontSize(10).font('Helvetica').text(row[0], 60, y + 5);
      doc.fillColor('#111').font('Helvetica-Bold').text(row[1], 250, y + 5);
      y += 20;
    });

    y += 20;

    // Amount paid big box
    doc.rect(50, y, doc.page.width - 100, 70).fill('#064e3b');
    doc.fillColor('#a7f3d0').fontSize(11).font('Helvetica')
      .text('AMOUNT PAID', 50, y + 12, { align: 'center', width: doc.page.width - 100 });
    doc.fillColor('white').fontSize(32).font('Helvetica-Bold')
      .text('KES ' + Number(p.amount_paid).toLocaleString(), 50, y + 28, { align: 'center', width: doc.page.width - 100 });
    y += 85;

    // Balance notice
    if (p.balance_after > 0) {
      doc.rect(50, y, doc.page.width - 100, 30).fill('#fee2e2');
      doc.fillColor('#dc2626').fontSize(10).font('Helvetica-Bold')
        .text('Outstanding Balance: KES ' + Number(p.balance_after).toLocaleString() + ' - Please clear before next term.', 60, y + 9);
    } else {
      doc.rect(50, y, doc.page.width - 100, 30).fill('#d1fae5');
      doc.fillColor('#065f46').fontSize(10).font('Helvetica-Bold')
        .text('Fees fully paid. Thank you!', 50, y + 9, { align: 'center', width: doc.page.width - 100 });
    }
    y += 45;

    // Signatures
    doc.fillColor('#064e3b').fontSize(10).font('Helvetica-Bold').text('AUTHORISATION', 50, y);
    y += 15;
    const sigLabels = ['Received By (Bursar)', 'Official Stamp'];
    const sigX = [50, 320];
    sigX.forEach((sx, i) => {
      doc.moveTo(sx, y + 40).lineTo(sx + 180, y + 40).stroke('#333');
      doc.fillColor('#6b7280').fontSize(9).font('Helvetica').text(sigLabels[i], sx, y + 45);
    });

    // PAID stamp circle
    doc.circle(420, y + 20, 30).stroke('#064e3b');
    doc.fillColor('#064e3b').fontSize(12).font('Helvetica-Bold').text('PAID', 390, y + 12, { width: 60, align: 'center' });

    y += 80;

    // Footer
    doc.fillColor('#9ca3af').fontSize(8).font('Helvetica')
      .text('This is an official receipt from ' + schoolName + '. Generated on ' + now + '.', 50, y, { align: 'center', width: doc.page.width - 100 })
      .text('Please keep this receipt for your records. For queries call: ' + schoolPhone, 50, y + 12, { align: 'center', width: doc.page.width - 100 });

    doc.end();
  } catch (err) {
    console.error('Receipt error:', err.message);
    if (!res.headersSent) {
      res.status(500).json({ success: false, message: 'Failed to generate receipt: ' + err.message });
    }
  }
});

router.delete('/payment/:id', authorize('admin', 'principal'), async (req, res) => {
  try {
    await query('DELETE FROM fee_payments WHERE id = $1', [req.params.id]);
    res.json({ success: true, message: 'Payment record deleted.' });
  } catch (err) {
    res.status(500).json({ success: false, message: 'Server error.' });
  }
});
// GET /api/fees/structure — get all fee structures
router.get('/structure', async (req, res) => {
  try {
    const { academic_year = '2024' } = req.query;
    const result = await query(
      `SELECT fs.*, c.name AS class_name
       FROM fee_structures fs
       JOIN classes c ON fs.class_id = c.id
       WHERE fs.academic_year = $1
       ORDER BY c.name, fs.term`,
      [academic_year]
    );
    res.json({ success: true, data: result.rows });
  } catch (err) {
    res.status(500).json({ success: false, message: 'Server error.' });
  }
});

// POST /api/fees/structure — create or update fee structure
router.post('/structure', authorize('admin', 'principal'), async (req, res) => {
  try {
    const { class_id, term, academic_year = '2024', tuition_fee, activity_fee = 0, boarding_fee = 0, other_fee = 0 } = req.body;
    if (!class_id || !term || !tuition_fee) {
      return res.status(400).json({ success: false, message: 'class_id, term and tuition_fee are required.' });
    }
    const result = await query(
      `INSERT INTO fee_structures (class_id, term, academic_year, tuition_fee, activity_fee, boarding_fee, other_fee)
       VALUES ($1,$2,$3,$4,$5,$6,$7)
       ON CONFLICT (class_id, term, academic_year)
       DO UPDATE SET tuition_fee = EXCLUDED.tuition_fee, activity_fee = EXCLUDED.activity_fee,
         boarding_fee = EXCLUDED.boarding_fee, other_fee = EXCLUDED.other_fee
       RETURNING *`,
      [class_id, term, academic_year, tuition_fee, activity_fee, boarding_fee, other_fee]
    );
    res.json({ success: true, message: 'Fee structure saved.', data: result.rows[0] });
  } catch (err) {
    console.error('Fee structure error:', err);
    res.status(500).json({ success: false, message: 'Server error.' });
  }
});

// GET /api/fees/structure/:class_id?term= — get expected fee for a class
router.get('/structure/:class_id', async (req, res) => {
  try {
    const { term, academic_year = '2024' } = req.query;
    const result = await query(
      `SELECT * FROM fee_structures WHERE class_id = $1 AND term = $2 AND academic_year = $3`,
      [req.params.class_id, term, academic_year]
    );
    res.json({ success: true, data: result.rows[0] || null });
  } catch (err) {
    res.status(500).json({ success: false, message: 'Server error.' });
  }
});

// DELETE /api/fees/structure/:id — delete a fee structure
router.delete('/structure/:id', authorize('admin', 'principal'), async (req, res) => {
  try {
    await query('DELETE FROM fee_structures WHERE id = $1', [req.params.id]);
    res.json({ success: true, message: 'Fee structure deleted.' });
  } catch (err) {
    res.status(500).json({ success: false, message: 'Server error.' });
  }
});
// POST /api/fees/generate — Auto-generate fee records from fee structure
router.post('/generate', authorize('admin', 'principal'), async (req, res) => {
  try {
    const { term, academic_year = '2024' } = req.body;
    if (!term) return res.status(400).json({ success: false, message: 'Term is required.' });

    // Get all fee structures for this term
    const structures = await query(
      'SELECT * FROM fee_structures WHERE term = $1 AND academic_year = $2',
      [term, academic_year]
    );

    if (structures.rows.length === 0) {
      return res.status(404).json({ success: false, message: 'No fee structures found for this term. Please set up fee structures first.' });
    }

    let created = 0;
    let skipped = 0;

    for (const structure of structures.rows) {
      // Get all active students in this class
      const students = await query(
        'SELECT id FROM students WHERE class_id = $1 AND is_active = TRUE',
        [structure.class_id]
      );

      for (const student of students.rows) {
        // Check if fee record already exists
        const existing = await query(
          'SELECT id FROM fee_payments WHERE student_id = $1 AND term = $2 AND academic_year = $3',
          [student.id, term, academic_year]
        );

        if (existing.rows.length > 0) {
          skipped++;
          continue;
        }

        // Generate receipt number
        const receiptNo = `RCP-${academic_year.slice(-2)}${String(new Date().getMonth() + 1).padStart(2,'0')}-${Math.floor(Math.random() * 9000) + 1000}`;

        await query(
          `INSERT INTO fee_payments (student_id, term, academic_year, amount_paid, amount_expected, payment_method, balance_before, balance_after, receipt_no, received_by)
           VALUES ($1,$2,$3,0,$4,'Pending',0,$4,$5,$6)`,
          [student.id, term, academic_year, structure.total_amount, receiptNo, req.user.id]
        );
        created++;
      }
    }

    res.json({
      success: true,
      message: `Fee records generated! ${created} created, ${skipped} already existed.`,
      data: { created, skipped }
    });
  } catch (err) {
    console.error('Generate fees error:', err);
    res.status(500).json({ success: false, message: 'Failed to generate fee records: ' + err.message });
  }
});
module.exports = router;