const express = require('express');
const bcrypt = require('bcryptjs');
const { v4: uuidv4 } = require('uuid');
const { dbGet, dbRun, dbAll } = require('../database');
const { generateAccessToken, generateRefreshToken } = require('../middleware/auth');
const { isDriveConfigured, setupOrgFolders } = require('../services/driveService');
const router = express.Router();

// ── POST /api/auth/signup/create-org ─────────────────────────────────────────
router.post('/signup/create-org', async (req, res) => {
  try {
    const { name, email, password, orgName, teamSize } = req.body;
    if (!name || !email || !password || !orgName) {
      return res.status(400).json({ error: 'All fields are required' });
    }

    const existing = await dbGet('SELECT id FROM users WHERE email = ?', [email.toLowerCase()]);
    if (existing) return res.status(409).json({ error: 'Email already registered' });

    const existingOrg = await dbGet('SELECT id FROM organizations WHERE name = ?', [orgName]);
    if (existingOrg) return res.status(409).json({ error: 'Organization name already taken' });

    const passwordHash = await bcrypt.hash(password, 12);
    const orgId = uuidv4();
    const userId = uuidv4();

    await dbRun(
      `INSERT INTO organizations (id, name, team_size) VALUES (?, ?, ?)`,
      [orgId, orgName, teamSize || 10]
    );
    await dbRun(
      `INSERT INTO users (id, organization_id, name, email, password_hash, role, status) VALUES (?, ?, ?, ?, ?, 'OWNER', 'ACTIVE')`,
      [userId, orgId, name, email.toLowerCase(), passwordHash]
    );

    // Every org shares one pre-authorized Drive account — provision its
    // folder structure right away, without any manual "connect" step.
    if (isDriveConfigured()) {
      setupOrgFolders(orgId).catch((err) => console.error('Auto Drive folder setup failed:', err.message));
    }

    const user = await dbGet('SELECT * FROM users WHERE id = ?', [userId]);
    const org = await dbGet('SELECT * FROM organizations WHERE id = ?', [orgId]);

    const accessToken = generateAccessToken(user);
    const refreshToken = await generateRefreshToken(userId);

    return res.status(201).json({
      tokens: { accessToken, refreshToken, expiresAt: Date.now() + 86400000 },
      user: { id: user.id, name: user.name, email: user.email, role: user.role, organizationId: user.organization_id },
      organization: {
        id: org.id, name: org.name, plan: 'professional',
        screenshotInterval: org.screenshot_interval, teamSize: org.team_size,
        driveFolderUrl: org.drive_folder_url,
      }
    });
  } catch (err) {
    console.error('Signup error:', err);
    res.status(500).json({ error: err.message });
  }
});

// ── POST /api/auth/signup/join-org ────────────────────────────────────────────
router.post('/signup/join-org', async (req, res) => {
  try {
    const { name, email, password, organizationId } = req.body;
    if (!name || !email || !password || !organizationId) {
      return res.status(400).json({ error: 'All fields are required' });
    }

    const org = await dbGet('SELECT id FROM organizations WHERE id = ?', [organizationId]);
    if (!org) return res.status(404).json({ error: 'Organization not found' });

    const existing = await dbGet('SELECT id FROM users WHERE email = ?', [email.toLowerCase()]);
    if (existing) return res.status(409).json({ error: 'Email already registered' });

    const passwordHash = await bcrypt.hash(password, 12);
    const userId = uuidv4();

    await dbRun(
      `INSERT INTO users (id, organization_id, name, email, password_hash, role, status) VALUES (?, ?, ?, ?, ?, 'EMPLOYEE', 'PENDING')`,
      [userId, organizationId, name, email.toLowerCase(), passwordHash]
    );

    return res.status(201).json({ message: 'Join request sent. Await manager approval.' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── GET /api/auth/orgs ────────────────────────────────────────────────────────
router.get('/orgs', async (req, res) => {
  try {
    const orgs = await dbAll('SELECT id, name, team_size as "teamSize" FROM organizations ORDER BY name');
    res.json(orgs);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── POST /api/auth/login ──────────────────────────────────────────────────────
router.post('/login', async (req, res) => {
  try {
    const { email, password } = req.body;
    if (!email || !password) return res.status(400).json({ error: 'Email and password required' });

    const user = await dbGet('SELECT * FROM users WHERE email = ?', [email.toLowerCase()]);
    if (!user) return res.status(401).json({ error: 'Invalid email or password' });

    const valid = await bcrypt.compare(password, user.password_hash);
    if (!valid) return res.status(401).json({ error: 'Invalid email or password' });

    if (user.status === 'PENDING') {
      return res.status(403).json({ error: 'Your account is pending manager approval.' });
    }
    if (user.status === 'REJECTED') {
      return res.status(403).json({ error: 'Your join request was rejected.' });
    }

    const org = await dbGet('SELECT * FROM organizations WHERE id = ?', [user.organization_id]);
    const accessToken = generateAccessToken(user);
    const refreshToken = await generateRefreshToken(user.id);

    res.json({
      tokens: { accessToken, refreshToken, expiresAt: Date.now() + 86400000 },
      user: { id: user.id, name: user.name, email: user.email, role: user.role, organizationId: user.organization_id },
      organization: org ? {
        id: org.id, name: org.name, plan: 'professional',
        screenshotInterval: org.screenshot_interval, teamSize: org.team_size,
        driveFolderUrl: org.drive_folder_url,
      } : null
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── POST /api/auth/refresh ────────────────────────────────────────────────────
router.post('/refresh', async (req, res) => {
  try {
    const { refreshToken } = req.body;
    if (!refreshToken) return res.status(400).json({ error: 'Refresh token required' });

    const tokenRow = await dbGet(
      `SELECT rt.*, u.* FROM refresh_tokens rt JOIN users u ON rt.user_id = u.id WHERE rt.token = ? AND rt.expires_at > CURRENT_TIMESTAMP`,
      [refreshToken]
    );
    if (!tokenRow) return res.status(401).json({ error: 'Invalid or expired refresh token' });

    const user = { id: tokenRow.user_id, email: tokenRow.email, role: tokenRow.role, organization_id: tokenRow.organization_id };
    const newAccessToken = generateAccessToken(user);
    const newRefreshToken = await generateRefreshToken(user.id);

    // Invalidate old refresh token
    await dbRun('DELETE FROM refresh_tokens WHERE token = ?', [refreshToken]);

    res.json({ tokens: { accessToken: newAccessToken, refreshToken: newRefreshToken, expiresAt: Date.now() + 86400000 } });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── POST /api/auth/logout ─────────────────────────────────────────────────────
router.post('/logout', async (req, res) => {
  try {
    const { refreshToken } = req.body;
    if (refreshToken) {
      await dbRun('DELETE FROM refresh_tokens WHERE token = ?', [refreshToken]);
    }
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── GET /api/auth/me ──────────────────────────────────────────────────────────
router.get('/me', require('../middleware/auth').requireAuth, async (req, res) => {
  const org = await dbGet('SELECT * FROM organizations WHERE id = ?', [req.user.organization_id]);
  res.json({
    user: { id: req.user.id, name: req.user.name, email: req.user.email, role: req.user.role, organizationId: req.user.organization_id },
    organization: org ? {
      id: org.id, name: org.name,
      screenshotInterval: org.screenshot_interval, teamSize: org.team_size,
      driveFolderUrl: org.drive_folder_url,
    } : null
  });
});

module.exports = router;
