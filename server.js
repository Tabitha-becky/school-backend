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

app.use(helmet());
app.use(cors({
  origin: process.env.NODE_ENV === 'production'
    ? ['https://yourdomain.com']
    : ['http://localhost:3000', 'http://localhost:5173'],
  credentials: true,
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization'],
}));

const limiter = rateLimit({ windowMs: 15 * 60 * 1000, max: 200, message: { success: false, message: 'Too many requests.' } });
const authLimiter = rateLimit({ windowMs: 15 * 60 * 1000, max: 10, message: { success: false, message: 'Too many login attempts.' } });

app.use(limiter);
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true }));

app.get('/', (req, res) => {
  res.json({ success: true, message: '🏫 EduTrack Kenya School Management API', version: '1.0.0', school: process.env.SCHOOL_NAME, status: 'running' });
});

app.use('/api/auth',       authLimiter, authRoutes);
app.use('/api/students',   studentRoutes);
app.use('/api/fees',       feeRoutes);
app.use('/api/academics',  academicRoutes);
app.use('/api/health',     healthRoutes);
app.use('/api/reports',    reportRoutes);
app.use('/api/attendance', attendanceRoutes);

app.use((req, res) => res.status(404).json({ success: false, message: `Route ${req.method} ${req.path} not found.` }));
app.use((err, req, res, next) => {
  console.error('Unhandled error:', err);
  res.status(500).json({ success: false, message: process.env.NODE_ENV === 'development' ? err.message : 'Internal server error.' });
});

app.listen(PORT, () => {
  console.log('\n════════════════════════════════════════════');
  console.log(`  🏫  EduTrack Kenya — API Server`);
  console.log(`  🚀  Running on: http://localhost:${PORT}`);
  console.log(`  🌍  Environment: ${process.env.NODE_ENV || 'development'}`);
  console.log(`  🏛️   School: ${process.env.SCHOOL_NAME}`);
  console.log('════════════════════════════════════════════\n');
});

module.exports = app;