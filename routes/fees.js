const express = require('express');
const { query } = require('../config/db');
const { authenticate, authorize } = require('../middleware/auth');

const router = express.Router();

// Allow token via query param (receipts opened in new tab)
router.use((req, res, next) => {
  if (req.query.token) {
    req.headers['authorization'] = `Bearer ${req.query.token}`;
  }
  next();
});
router.use(authenticate);

// ─────────────────────────────────────────────
// GET /fees/summary  — dashboard totals
// ─────────────────────────────────────────────
router.get('/summary', async (req, res) => {
  try {
    const { academic_year } = req.query;
    const year = academic_year || String(new Date().getFullYear());

    // Overall totals for the academic year
    const summaryResult = await query(
      `SELECT
         COALESCE(SUM(fp.amount_expected), 0)                                          AS total_expected,
         COALESCE(SUM(fp.amount_paid), 0)                                              AS total_collected,
         COALESCE(SUM(GREATEST(fp.amount_expected - fp.amount_paid, 0)), 0)            AS total_outstanding,
         COUNT(DISTINCT CASE WHEN fp.amount_expected > fp.amount_paid THEN fp.student_id END) AS students_with_balance
       FROM fee_payments fp
       JOIN students s ON s.id = fp.student_id
       WHERE fp.academic_year = $1
         AND s.is_active = TRUE`,
      [year]
    );

    // 10 most recent actual payments (amount_paid > 0)
    const recentPaymentsResult = await query(
      `SELECT
         fp.id, fp.student_id, fp.term, fp.academic_year,
         fp.amount_paid, fp.payment_method, fp.payment_date, fp.reference_no,
         s.name AS student_name
       FROM fee_payments fp
       JOIN students s ON s.id = fp.student_id
       WHERE fp.amount_paid > 0
         AND s.is_active = TRUE
       ORDER BY fp.payment_date DESC NULLS LAST, fp.created_at DESC
       LIMIT 10`,
      []
    );

    res.json({
      success: true,
      data: {
        summary       : summaryResult.rows[0],
        recentPayments: recentPaymentsResult.rows,
      },
    });
  } catch (err) {
    console.error('Fee summary error:', err);
    res.status(500).json({ success: false, message: 'Server error.' });
  }
});

// ─────────────────────────────────────────────
// GET /fees/structure  — list fee structures
// ─────────────────────────────────────────────
router.get('/structure', async (req, res) => {
  try {
    const { academic_year } = req.query;
    const year = academic_year || String(new Date().getFullYear());

    const result = await query(
      `SELECT fs.*, c.name AS class_name
       FROM fee_structures fs
       JOIN classes c ON fs.class_id = c.id
       WHERE fs.academic_year = $1
       ORDER BY c.name, fs.term`,
      [year]
    );

    res.json({ success: true, data: result.rows });
  } catch (err) {
    console.error('Get fee structure error:', err);
    res.status(500).json({ success: false, message: 'Server error.' });
  }
});

// ─────────────────────────────────────────────
// POST /fees/structure  — create or update fee structure
// ─────────────────────────────────────────────
router.post('/structure', authorize('admin', 'principal'), async (req, res) => {
  try {
    const {
      class_id, term, academic_year,
      tuition_fee = 0, activity_fee = 0, boarding_fee = 0, other_fee = 0,
    } = req.body;

    if (!class_id || !term || !academic_year) {
      return res.status(400).json({ success: false, message: 'Class, term and academic year are required.' });
    }

    const total = parseFloat(tuition_fee) + parseFloat(activity_fee) +
                  parseFloat(boarding_fee) + parseFloat(other_fee);

    // Upsert — update if exists, insert if not
    const result = await query(
      `INSERT INTO fee_structures (class_id, term, academic_year, tuition_fee, activity_fee, boarding_fee, other_fee, total_amount)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
       ON CONFLICT (class_id, term, academic_year)
       DO UPDATE SET
         tuition_fee  = EXCLUDED.tuition_fee,
         activity_fee = EXCLUDED.activity_fee,
         boarding_fee = EXCLUDED.boarding_fee,
         other_fee    = EXCLUDED.other_fee,
         total_amount = EXCLUDED.total_amount
       RETURNING *`,
      [class_id, term, academic_year,
       parseFloat(tuition_fee), parseFloat(activity_fee),
       parseFloat(boarding_fee), parseFloat(other_fee), total]
    );

    res.status(201).json({ success: true, message: 'Fee structure saved.', data: result.rows[0] });
  } catch (err) {
    console.error('Create fee structure error:', err);
    res.status(500).json({ success: false, message: 'Server error: ' + err.message });
  }
});

// ─────────────────────────────────────────────
// DELETE /fees/structure/:id
// ─────────────────────────────────────────────
router.delete('/structure/:id', authorize('admin', 'principal'), async (req, res) => {
  try {
    const result = await query(
      'DELETE FROM fee_structures WHERE id = $1 RETURNING id',
      [req.params.id]
    );
    if (result.rows.length === 0) {
      return res.status(404).json({ success: false, message: 'Fee structure not found.' });
    }
    res.json({ success: true, message: 'Fee structure deleted.' });
  } catch (err) {
    res.status(500).json({ success: false, message: 'Server error.' });
  }
});

// ─────────────────────────────────────────────
// POST /fees/generate
// Bulk-create fee records for all students in every class
// that has a fee structure for the given term.
// Includes arrears (previous unpaid balance) carried forward.
// ─────────────────────────────────────────────
router.post('/generate', authorize('admin', 'principal'), async (req, res) => {
  const client = await require('../config/db').pool.connect();
  try {
    await client.query('BEGIN');

    const { term, academic_year } = req.body;
    if (!term || !academic_year) {
      return res.status(400).json({ success: false, message: 'Term and academic year are required.' });
    }

    // All fee structures for this term
    const structures = await client.query(
      `SELECT fs.*, c.id AS cid
       FROM fee_structures fs
       JOIN classes c ON fs.class_id = c.id
       WHERE fs.term = $1 AND fs.academic_year = $2`,
      [term, academic_year]
    );

    let created = 0;
    let skipped = 0;

    for (const structure of structures.rows) {
      // Active students in this class
      const students = await client.query(
        `SELECT id FROM students WHERE class_id = $1 AND is_active = TRUE`,
        [structure.cid]
      );

      for (const student of students.rows) {
        // Skip if a fee record already exists for this student + term
        const existing = await client.query(
          `SELECT id FROM fee_payments
           WHERE student_id = $1 AND term = $2 AND academic_year = $3`,
          [student.id, term, academic_year]
        );

        if (existing.rows.length > 0) {
          skipped++;
          continue;
        }

        // Calculate arrears: sum of all UNPAID amounts from previous terms
        const arrearsResult = await client.query(
          `SELECT COALESCE(SUM(GREATEST(fp.amount_expected - fp.amount_paid, 0)), 0) AS arrears
           FROM fee_payments fp
           WHERE fp.student_id   = $1
             AND fp.academic_year <= $2
             AND NOT (fp.term = $3 AND fp.academic_year = $4)`,
          [student.id, academic_year, term, academic_year]
        );

        const arrears  = parseFloat(arrearsResult.rows[0].arrears || 0);
        const termFee  = parseFloat(structure.total_amount || 0);
        // Store current term fee + previous arrears as the expected amount
        const totalDue = termFee + arrears;

        await client.query(
          `INSERT INTO fee_payments
             (student_id, term, academic_year, amount_expected, amount_paid, payment_method)
           VALUES ($1, $2, $3, $4, 0, 'Pending')`,
          [student.id, term, academic_year, totalDue]
        );
        created++;
      }
    }

    await client.query('COMMIT');

    res.json({
      success: true,
      message: `Generated ${created} fee record(s). ${skipped} already existed and were skipped.`,
      data: { created, skipped },
    });
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('Generate fees error:', err);
    res.status(500).json({ success: false, message: 'Failed to generate fees: ' + err.message });
  } finally {
    client.release();
  }
});

// ─────────────────────────────────────────────
// POST /fees/payment  — record a payment against a student
// ─────────────────────────────────────────────
router.post('/payment', authorize('admin', 'principal', 'bursar'), async (req, res) => {
  try {
    const {
      student_id, term, amount_expected, amount_paid,
      payment_method = 'Cash', reference_no, payment_date,
    } = req.body;

    if (!student_id || !term || !amount_paid) {
      return res.status(400).json({ success: false, message: 'Student, term and amount paid are required.' });
    }

    // Derive the academic year from the term string or the payment date
    // Term strings look like "Term 2 2025" — extract the year from there first
    const termYearMatch = String(term).match(/\b(\d{4})\b/);
    const academic_year = termYearMatch
      ? termYearMatch[1]
      : String(new Date(payment_date || Date.now()).getFullYear());

    // Check if a fee record already exists for this student + term
    const existing = await query(
      `SELECT id, amount_paid, amount_expected
       FROM fee_payments
       WHERE student_id = $1 AND term = $2 AND academic_year = $3`,
      [student_id, term, academic_year]
    );

    let result;
    if (existing.rows.length > 0) {
      // Add to the existing payment record
      const newTotalPaid = parseFloat(existing.rows[0].amount_paid) + parseFloat(amount_paid);

      // If the caller also supplied a new expected amount (rare override), respect it
      const newExpected = amount_expected
        ? Math.max(parseFloat(amount_expected), parseFloat(existing.rows[0].amount_expected))
        : parseFloat(existing.rows[0].amount_expected);

      result = await query(
        `UPDATE fee_payments SET
           amount_paid    = $1,
           amount_expected = $2,
           payment_method  = $3,
           reference_no    = COALESCE($4, reference_no),
           payment_date    = COALESCE($5, payment_date),
           received_by     = $6
         WHERE id = $7
         RETURNING *`,
        [newTotalPaid, newExpected, payment_method, reference_no || null,
         payment_date || null, req.user.id, existing.rows[0].id]
      );
    } else {
      // No prior record — insert fresh
      result = await query(
        `INSERT INTO fee_payments
           (student_id, term, academic_year, amount_expected, amount_paid,
            payment_method, reference_no, payment_date, received_by)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
         RETURNING *`,
        [student_id, term, academic_year,
         parseFloat(amount_expected || amount_paid),
         parseFloat(amount_paid),
         payment_method, reference_no || null,
         payment_date || null, req.user.id]
      );
    }

    res.json({ success: true, message: 'Payment recorded successfully.', data: result.rows[0] });
  } catch (err) {
    console.error('Record payment error:', err);
    res.status(500).json({ success: false, message: 'Server error: ' + err.message });
  }
});

// ─────────────────────────────────────────────
// GET /fees/receipt/:id  — PDF receipt
// ─────────────────────────────────────────────
router.get('/receipt/:id', async (req, res) => {
  try {
    const PDFDocument = require('pdfkit');

    const result = await query(
      `SELECT
         fp.*,
         s.name AS student_name, s.adm_no,
         c.name AS class_name,
         u.name AS received_by_name
       FROM fee_payments fp
       JOIN students s ON s.id = fp.student_id
       LEFT JOIN classes c ON s.class_id = c.id
       LEFT JOIN users   u ON fp.received_by = u.id
       WHERE fp.id = $1`,
      [req.params.id]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ success: false, message: 'Fee record not found.' });
    }

    const fee        = result.rows[0];
    const schoolName = process.env.SCHOOL_NAME || 'EduTrack Kenya';
    const balance    = Math.max(parseFloat(fee.amount_expected) - parseFloat(fee.amount_paid), 0);
    const fmt        = (n) => `KES ${parseFloat(n || 0).toLocaleString('en-KE', { minimumFractionDigits: 2 })}`;
    const fmtDate    = (d) => d ? new Date(d).toLocaleDateString('en-KE', { day: '2-digit', month: 'short', year: 'numeric' }) : '—';

    const doc = new PDFDocument({ size: 'A5', margin: 36 });

    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `inline; filename="Receipt_${fee.adm_no}_${fee.term}.pdf"`);
    doc.pipe(res);

    // ── Header bar ──────────────────────────────────────────────────────────
    doc.rect(0, 0, doc.page.width, 70).fill('#064e3b');
    doc.fillColor('white').fontSize(16).font('Helvetica-Bold')
       .text(schoolName, 36, 18, { align: 'center', width: doc.page.width - 72 });
    doc.fontSize(9).font('Helvetica')
       .text('Official Fee Receipt', 36, 38, { align: 'center', width: doc.page.width - 72 });
    doc.fillColor('#f59e0b').fontSize(8)
       .text(`Receipt No: ${fee.receipt_no || fee.id}`, 36, 52, { align: 'center', width: doc.page.width - 72 });

    // ── Student info ─────────────────────────────────────────────────────────
    doc.fillColor('#064e3b').fontSize(10).font('Helvetica-Bold')
       .text('STUDENT DETAILS', 36, 88);
    doc.moveTo(36, 102).lineTo(doc.page.width - 36, 102).strokeColor('#064e3b').lineWidth(1).stroke();

    const infoY = 110;
    const col2  = doc.page.width / 2;
    doc.fillColor('#374151').fontSize(9).font('Helvetica');

    const infoRows = [
      ['Name',       fee.student_name],
      ['Adm. No.',   fee.adm_no],
      ['Class',      fee.class_name || '—'],
      ['Term',       fee.term],
    ];
    infoRows.forEach(([label, value], i) => {
      const y = infoY + i * 18;
      const x = i % 2 === 0 ? 36  : col2;
      const r = i % 2 === 0 ? col2 : doc.page.width - 36;
      doc.font('Helvetica-Bold').text(label + ':', x, y, { width: 70, continued: false });
      doc.font('Helvetica').text(value, x + 72, y, { width: r - x - 72 });
    });

    // ── Payment summary box ───────────────────────────────────────────────────
    const boxY = infoY + 4 * 18 + 16;
    doc.rect(36, boxY, doc.page.width - 72, 90).fill('#f0fdf4').stroke('#6ee7b7');

    doc.fillColor('#064e3b').fontSize(10).font('Helvetica-Bold')
       .text('PAYMENT SUMMARY', 50, boxY + 10);

    const rows = [
      ['Amount Expected', fmt(fee.amount_expected)],
      ['Amount Paid',     fmt(fee.amount_paid)],
      ['Balance Due',     fmt(balance)],
      ['Payment Method',  fee.payment_method || '—'],
      ['Payment Date',    fmtDate(fee.payment_date)],
    ];

    rows.forEach(([label, value], i) => {
      const y       = boxY + 28 + i * 14;
      const isPaid  = label === 'Amount Paid';
      const isBalance = label === 'Balance Due';
      doc.fillColor(isPaid ? '#16a34a' : isBalance && balance > 0 ? '#dc2626' : '#374151')
         .fontSize(9)
         .font(isPaid || isBalance ? 'Helvetica-Bold' : 'Helvetica')
         .text(label, 50, y, { width: 130 })
         .text(value, 180, y, { width: 150, align: 'right' });
    });

    // ── Reference no ─────────────────────────────────────────────────────────
    if (fee.reference_no) {
      doc.fillColor('#6b7280').fontSize(8).font('Helvetica')
         .text(`Reference: ${fee.reference_no}`, 36, boxY + 100);
    }

    // ── Received by & status stamp ────────────────────────────────────────────
    const stampY = boxY + 118;
    if (fee.received_by_name) {
      doc.fillColor('#6b7280').fontSize(8)
         .text(`Received by: ${fee.received_by_name}`, 36, stampY);
    }

    // Green "PAID" or orange "PARTIAL" stamp
    if (balance <= 0) {
      doc.save()
         .rotate(-20, { origin: [doc.page.width - 80, stampY] })
         .rect(doc.page.width - 120, stampY - 8, 90, 28).lineWidth(3).strokeColor('#16a34a').stroke()
         .fillColor('#16a34a').fontSize(16).font('Helvetica-Bold')
         .text('PAID', doc.page.width - 112, stampY - 2)
         .restore();
    } else if (parseFloat(fee.amount_paid) > 0) {
      doc.save()
         .rotate(-20, { origin: [doc.page.width - 80, stampY] })
         .rect(doc.page.width - 130, stampY - 8, 110, 28).lineWidth(3).strokeColor('#d97706').stroke()
         .fillColor('#d97706').fontSize(12).font('Helvetica-Bold')
         .text('PARTIAL', doc.page.width - 126, stampY - 2)
         .restore();
    }

    // ── Footer ────────────────────────────────────────────────────────────────
    doc.fillColor('#9ca3af').fontSize(7).font('Helvetica')
       .text(
         `Generated ${new Date().toLocaleDateString('en-KE', { day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' })} · EduTrack Kenya`,
         36, doc.page.height - 36, { align: 'center', width: doc.page.width - 72 }
       );

    doc.end();
  } catch (err) {
    console.error('Receipt error:', err);
    res.status(500).json({ success: false, message: 'Failed to generate receipt.' });
  }
});

module.exports = router;