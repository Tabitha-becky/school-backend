require('dotenv').config();
const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');

const authRoutes       = require('./routes/auth');
const studentRoutes    = require('./routes/students');
const feeRoutes        = require('./routes/fees');
const academicRoutes   = require('./routes/academics');
const healthRoutes     = require('./routes/health');
const reportRoutes     = require('./routes/reports');
const attendanceRoutes = require('./routes/attendance');

const app = express();
const PORT = process.env.PORT || 5000;

/**
 * =========================
 * SECURITY
 * =========================
 */
app.use(helmet());

/**
 * =========================
 * CORS (PRODUCTION FIXED)
 * =========================
 */
const allowedOrigins = [
  'http://localhost:3000',
  'http://localhost:5173',
  'https://school-frontend-lilac-omega.vercel.app'
];

const corsOptions = {
  origin: function (origin, callback) {
    if (!origin) return callback(null, true);

    if (allowedOrigins.includes(origin)) {
      return callback(null, true);
    }

    console.log("❌ Blocked by CORS:", origin);
    return callback(new Error('Not allowed by CORS'));
  },
  credentials: true,
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization']
};

app.use(cors(corsOptions));
app.options('*', cors(corsOptions));

/**
 * =========================
 * RATE LIMITING
 * =========================
 */
const limiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 200,
  message: { success: false, message: 'Too many requests.' }
});

const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 10,
  message: { success: false, message: 'Too many login attempts.' }
});

app.use(limiter);

/**
 * =========================
 * BODY PARSER
 * =========================
 */
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true }));

/**
 * =========================
 * HEALTH CHECK
 * =========================
 */
app.get('/', (req, res) => {
  res.json({
    success: true,
    message: '🏫 EduTrack Kenya School Management API',
    version: '1.0.0',
    school: process.env.SCHOOL_NAME,
    status: 'running'
  });
});

/**
 * =========================
 * ROUTES
 * =========================
 */
app.use('/api/auth',       authLimiter, authRoutes);
app.use('/api/students',   studentRoutes);
app.use('/api/fees',       feeRoutes);
app.use('/api/academics',  academicRoutes);
app.use('/api/health',     healthRoutes);
app.use('/api/reports',    reportRoutes);
app.use('/api/attendance', attendanceRoutes);

/**
 * =========================
 * 404 HANDLER
 * =========================
 */
app.use((req, res) => {
  res.status(404).json({
    success: false,
    message: `Route ${req.method} ${req.path} not found.`
  });
});

/**
 * =========================
 * ERROR HANDLER
 * =========================
 */
app.use((err, req, res, next) => {
  console.error('❌ Error:', err.message);

  res.status(500).json({
    success: false,
    message: process.env.NODE_ENV === 'development'
      ? err.message
      : 'Internal server error.'
  });
});

/**
 * =========================
 * START SERVER
 * =========================
 */
app.listen(PORT, () => {
  console.log('\n════════════════════════════════════════════');
  console.log(`  🏫  EduTrack Kenya — API Server`);
  console.log(`  🚀  Running on: http://localhost:${PORT}`);
  console.log(`  🌍  Environment: ${process.env.NODE_ENV || 'development'}`);
  console.log(`  🏛️   School: ${process.env.SCHOOL_NAME}`);
  console.log('════════════════════════════════════════════\n');
});

module.exports = app;