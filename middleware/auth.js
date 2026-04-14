// ─────────────────────────────────────────────────────────────
//  middleware/auth.js — JWT Authentication & Role Guards
// ─────────────────────────────────────────────────────────────
const jwt = require('jsonwebtoken');

// ── Verify JWT token ──────────────────────────────────────────
const authenticate = (req, res, next) => {
  // Token must be in:  Authorization: Bearer <token>
  const authHeader = req.headers['authorization'];
  const token = authHeader && authHeader.split(' ')[1];

  if (!token) {
    return res.status(401).json({
      success: false,
      message: 'Access denied. Please log in.',
    });
  }

  try {
    const decoded = jwt.verify(token, process.env.JWT_SECRET);
    req.user = decoded;   // { id, email, role, name }
    next();
  } catch (err) {
    return res.status(401).json({
      success: false,
      message: 'Invalid or expired token. Please log in again.',
    });
  }
};

// ── Role-based access guard ───────────────────────────────────
// Usage: authorize('admin', 'principal')
const authorize = (...roles) => {
  return (req, res, next) => {
    if (!roles.includes(req.user.role)) {
      return res.status(403).json({
        success: false,
        message: `Access denied. Required role: ${roles.join(' or ')}.`,
      });
    }
    next();
  };
};

module.exports = { authenticate, authorize };