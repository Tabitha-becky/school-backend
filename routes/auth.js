// ─────────────────────────────────────────────────────────────
//  routes/auth.js — FIXED VERSION (Login, Register, Profile)
// ─────────────────────────────────────────────────────────────

const express = require('express');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const { query } = require('../config/db');
const { authenticate, authorize } = require('../middleware/auth');

const router = express.Router();

// ─────────────────────────────────────────────────────────────
//  JWT HELPER
// ─────────────────────────────────────────────────────────────
const signToken = (user) => {
  return jwt.sign(
    {
      id: user.id,
      email: user.email,
      role: user.role,
      name: user.name
    },
    process.env.JWT_SECRET,
    { expiresIn: process.env.JWT_EXPIRES_IN || '7d' }
  );
};

// ─────────────────────────────────────────────────────────────
//  LOGIN
// ─────────────────────────────────────────────────────────────
router.post('/login', async (req, res) => {
  try {
    const { email, password } = req.body;

    if (!email || !password) {
      return res.status(400).json({
        success: false,
        message: 'Email and password are required.'
      });
    }

    // SAFE QUERY (removed is_active to avoid DB crash)
    const result = await query(
      'SELECT * FROM users WHERE email = $1',
      [email.toLowerCase().trim()]
    );

    if (!result || result.rows.length === 0) {
      return res.status(401).json({
        success: false,
        message: 'Invalid email or password.'
      });
    }

    const user = result.rows[0];

    // Safety check
    if (!user.password_hash) {
      return res.status(500).json({
        success: false,
        message: 'User password missing in database.'
      });
    }

    // Compare password
    const passwordMatch = await bcrypt.compare(password, user.password_hash);

    if (!passwordMatch) {
      return res.status(401).json({
        success: false,
        message: 'Invalid email or password.'
      });
    }

    const token = signToken(user);

    return res.json({
      success: true,
      message: `Welcome back, ${user.name}!`,
      token,
      user: {
        id: user.id,
        name: user.name,
        email: user.email,
        role: user.role,
        phone: user.phone
      }
    });

  } catch (err) {
    console.error('❌ LOGIN ERROR:', err);
    return res.status(500).json({
      success: false,
      message: 'Internal server error. Check backend logs.'
    });
  }
});

// ─────────────────────────────────────────────────────────────
//  REGISTER (ADMIN ONLY)
// ─────────────────────────────────────────────────────────────
router.post(
  '/register',
  authenticate,
  authorize('admin', 'principal'),
  async (req, res) => {
    try {
      const { name, email, password, role = 'teacher', phone } = req.body;

      if (!name || !email || !password) {
        return res.status(400).json({
          success: false,
          message: 'Name, email, and password are required.'
        });
      }

      const existing = await query(
        'SELECT id FROM users WHERE email = $1',
        [email.toLowerCase().trim()]
      );

      if (existing.rows.length > 0) {
        return res.status(409).json({
          success: false,
          message: 'User already exists.'
        });
      }

      const hashedPassword = await bcrypt.hash(password, 12);

      const result = await query(
        `INSERT INTO users (name, email, password, role, phone)
         VALUES ($1, $2, $3, $4, $5)
         RETURNING id, name, email, role, phone, created_at`,
        [name.trim(), email.toLowerCase().trim(), hashedPassword, role, phone]
      );

      return res.status(201).json({
        success: true,
        message: `User ${name} created successfully.`,
        user: result.rows[0]
      });

    } catch (err) {
      console.error('❌ REGISTER ERROR:', err);
      return res.status(500).json({
        success: false,
        message: 'Internal server error.'
      });
    }
  }
);

// ─────────────────────────────────────────────────────────────
//  GET PROFILE
// ─────────────────────────────────────────────────────────────
router.get('/me', authenticate, async (req, res) => {
  try {
    const result = await query(
      'SELECT id, name, email, role, phone, created_at FROM users WHERE id = $1',
      [req.user.id]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({
        success: false,
        message: 'User not found.'
      });
    }

    res.json({
      success: true,
      user: result.rows[0]
    });

  } catch (err) {
    console.error(err);
    res.status(500).json({
      success: false,
      message: 'Server error.'
    });
  }
});

// ─────────────────────────────────────────────────────────────
//  CHANGE PASSWORD
// ─────────────────────────────────────────────────────────────
router.put('/change-password', authenticate, async (req, res) => {
  try {
    const { currentPassword, newPassword } = req.body;

    if (!currentPassword || !newPassword) {
      return res.status(400).json({
        success: false,
        message: 'Both passwords required.'
      });
    }

    const result = await query(
      'SELECT password FROM users WHERE id = $1',
      [req.user.id]
    );

    const user = result.rows[0];

    const isMatch = await bcrypt.compare(currentPassword, user.password);

    if (!isMatch) {
      return res.status(400).json({
        success: false,
        message: 'Current password is incorrect.'
      });
    }

    const hashed = await bcrypt.hash(newPassword, 12);

    await query(
      'UPDATE users SET password = $1, updated_at = NOW() WHERE id = $2',
      [hashed, req.user.id]
    );

    res.json({
      success: true,
      message: 'Password updated successfully.'
    });

  } catch (err) {
    console.error(err);
    res.status(500).json({
      success: false,
      message: 'Server error.'
    });
  }
});

// ─────────────────────────────────────────────────────────────
//  STAFF LIST (ADMIN ONLY)
// ─────────────────────────────────────────────────────────────
router.get('/staff', authenticate, authorize('admin', 'principal'), async (req, res) => {
  try {
    const result = await query(
      'SELECT id, name, email, role, phone, is_active, created_at FROM users ORDER BY name'
    );

    res.json({
      success: true,
      data: result.rows
    });

  } catch (err) {
    console.error(err);
    res.status(500).json({
      success: false,
      message: 'Server error.'
    });
  }
});

module.exports = router;