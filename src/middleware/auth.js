const jwt = require('jsonwebtoken');
const { dbGet, dbRun } = require('../database');
const { v4: uuidv4 } = require('uuid');
require('dotenv').config();

const JWT_SECRET = process.env.JWT_SECRET;
const JWT_EXPIRES_IN = process.env.JWT_EXPIRES_IN || '24h';

function generateAccessToken(user) {
  return jwt.sign(
    { sub: user.id, email: user.email, role: user.role, orgId: user.organization_id },
    JWT_SECRET,
    { expiresIn: JWT_EXPIRES_IN }
  );
}

async function generateRefreshToken(userId) {
  const token = uuidv4();
  const expiresAt = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString();
  const id = uuidv4();
  await dbRun(
    `INSERT INTO refresh_tokens (id, user_id, token, expires_at) VALUES (?, ?, ?, ?)`,
    [id, userId, token, expiresAt]
  );
  return token;
}

async function requireAuth(req, res, next) {
  const authHeader = req.headers['authorization'];
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return res.status(401).json({ error: 'No token provided' });
  }
  const token = authHeader.slice(7);
  try {
    const decoded = jwt.verify(token, JWT_SECRET);
    const user = await dbGet('SELECT * FROM users WHERE id = ?', [decoded.sub]);
    if (!user) return res.status(401).json({ error: 'User not found' });
    req.user = user;
    next();
  } catch (err) {
    if (err.name === 'TokenExpiredError') {
      return res.status(401).json({ error: 'Token expired', code: 'TOKEN_EXPIRED' });
    }
    return res.status(401).json({ error: 'Invalid token' });
  }
}

function requireManager(req, res, next) {
  if (req.user?.role !== 'MANAGER') {
    return res.status(403).json({ error: 'Manager access required' });
  }
  next();
}

// ── Generic role gate ─────────────────────────────────────────────────────────
// requireRole('OWNER','ADMIN') → 403 unless the user has one of the listed roles.
function requireRole(...roles) {
  return (req, res, next) => {
    if (!roles.includes(req.user?.role)) {
      return res.status(403).json({ error: `Access requires role: ${roles.join(' / ')}` });
    }
    next();
  };
}

// Blocks external CLIENT users from internal/staff data. Employees are allowed
// (their own data is enforced via resolveTargetUserId below).
const requireStaff = requireRole('OWNER', 'ADMIN', 'MANAGER', 'EMPLOYEE');

function requireClient(req, res, next) {
  if (req.user?.role !== 'CLIENT') {
    return res.status(403).json({ error: 'Client access required' });
  }
  next();
}

// True for roles allowed to view *other* users' data.
function canViewOthers(role) {
  return ['OWNER', 'ADMIN', 'MANAGER'].includes(role);
}

// Resolve which user's data a request may read. Managers+ may target any
// user via ?userId=; everyone else is pinned to themselves.
function resolveTargetUserId(req) {
  const requested = req.query?.userId || req.body?.userId;
  if (requested && canViewOthers(req.user?.role)) return requested;
  return req.user.id;
}

// ── Enterprise Role Middleware ────────────────────────────────────────────────

function requireOwner(req, res, next) {
  if (req.user?.role !== 'OWNER') {
    return res.status(403).json({ error: 'Owner access required' });
  }
  next();
}

function requireAdminOrAbove(req, res, next) {
  const allowed = ['OWNER', 'ADMIN'];
  if (!allowed.includes(req.user?.role)) {
    return res.status(403).json({ error: 'Admin access required' });
  }
  next();
}

function requireManagerOrAbove(req, res, next) {
  const allowed = ['OWNER', 'ADMIN', 'MANAGER'];
  if (!allowed.includes(req.user?.role)) {
    return res.status(403).json({ error: 'Manager access required' });
  }
  next();
}

module.exports = {
  generateAccessToken,
  generateRefreshToken,
  requireAuth,
  requireManager,
  requireOwner,
  requireAdminOrAbove,
  requireManagerOrAbove,
  requireRole,
  requireStaff,
  requireClient,
  canViewOthers,
  resolveTargetUserId,
};
