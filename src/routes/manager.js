const express = require('express');
const bcrypt = require('bcryptjs');
const { v4: uuidv4 } = require('uuid');
const { dbGet, dbRun, dbAll } = require('../database');
const { requireAuth, requireManager, requireManagerOrAbove, requireAdminOrAbove } = require('../middleware/auth');
const { setupEmployeeFolder } = require('../services/driveService');
const { sendEmployeeCredentials } = require('../services/emailService');
const { createNotification } = require('./notifications');
const { TASK_SELECT_FIELDS } = require('../utils/taskSelect');
const router = express.Router();

// All manager routes require auth + manager-or-above role
router.use(requireAuth, requireManagerOrAbove);

// ── GET /api/manager/team ─────────────────────────────────────────────────────
router.get('/team', async (req, res) => {
  try {
    const orgId = req.user.organization_id;

    const members = await dbAll(
      `SELECT id, name, email, status, drive_folder_url as "driveFolderUrl" FROM users
       WHERE organization_id=? AND role='EMPLOYEE' AND status='ACTIVE' ORDER BY name`,
      [orgId]
    );

    const requests = await dbAll(
      `SELECT id, name, email, status FROM users
       WHERE organization_id=? AND status='PENDING' ORDER BY created_at DESC`,
      [orgId]
    );

    res.json({ members, requests });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── GET /api/manager/tasks ────────────────────────────────────────────────────
// Org-wide task listing (read-only) — tasks are only ever created inside a
// project (see projects.js POST /:id/tasks); there is no standalone
// task-creation route here anymore.
router.get('/tasks', async (req, res) => {
  try {
    const orgId = req.user.organization_id;
    const tasks = await dbAll(
      `SELECT ${TASK_SELECT_FIELDS}, u.email as "assigneeEmail"
       FROM tasks t LEFT JOIN users u ON t.assignee_id = u.id
       WHERE t.organization_id=? ORDER BY t.created_at DESC`,
      [orgId]
    );
    res.json(tasks);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── POST /api/manager/requests/:userId/approve ────────────────────────────────
router.post('/requests/:userId/approve', async (req, res) => {
  try {
    const { userId } = req.params;
    const user = await dbGet('SELECT * FROM users WHERE id=? AND organization_id=?', [userId, req.user.organization_id]);
    if (!user) return res.status(404).json({ error: 'User not found' });

    await dbRun(`UPDATE users SET status='ACTIVE' WHERE id=?`, [userId]);

    // Setup their Google Drive folder (non-blocking)
    setupEmployeeFolder(userId).catch(err => console.warn('Drive folder setup failed:', err.message));

    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── POST /api/manager/requests/:userId/reject ─────────────────────────────────
router.post('/requests/:userId/reject', async (req, res) => {
  try {
    const { userId } = req.params;
    await dbRun(`UPDATE users SET status='REJECTED' WHERE id=? AND organization_id=?`, [userId, req.user.organization_id]);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── POST /api/manager/employees ── Add employee directly ─────────────────────
router.post('/employees', async (req, res) => {
  try {
    const { name, email, password, departmentId, position } = req.body;
    if (!name || !email || !password) return res.status(400).json({ error: 'Name, email and password are required' });

    const existing = await dbGet('SELECT id FROM users WHERE email = ?', [email.toLowerCase()]);
    if (existing) return res.status(409).json({ error: 'Email already registered' });

    const passwordHash = await bcrypt.hash(password, 12);
    const userId = uuidv4();
    const orgId = req.user.organization_id;

    await dbRun(
      `INSERT INTO users (id, organization_id, name, email, password_hash, role, status, department_id, position)
       VALUES (?, ?, ?, ?, ?, 'EMPLOYEE', 'ACTIVE', ?, ?)`,
      [userId, orgId, name, email.toLowerCase(), passwordHash, departmentId || null, position || null]
    );

    // Setup Drive folder (non-blocking)
    setupEmployeeFolder(userId).catch(err => console.warn('Drive folder setup failed:', err.message));

    // Send credentials email (non-blocking)
    const org = await dbGet('SELECT name FROM organizations WHERE id=?', [orgId]);
    sendEmployeeCredentials({
      to: email.toLowerCase(),
      name,
      orgName: org?.name || 'WorkTrack',
      email: email.toLowerCase(),
      password,
    }).catch(err => console.warn('Email send failed:', err.message));

    // Create notification for the manager
    createNotification(req.user.id, orgId, 'employee_added', 'New Employee Added',
      `${name} has been added to your team.`, { employeeId: userId }
    ).catch(() => {});

    res.status(201).json({
      employee: { id: userId, name, email: email.toLowerCase(), role: 'EMPLOYEE', status: 'ACTIVE' },
      credentials: { email: email.toLowerCase(), password }
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── GET /api/manager/employees/:id/tasks ─────────────────────────────────────
router.get('/employees/:id/tasks', async (req, res) => {
  try {
    const tasks = await dbAll(
      `SELECT ${TASK_SELECT_FIELDS} FROM tasks t
       LEFT JOIN users u ON u.id = t.assignee_id
       WHERE t.assignee_id=? AND t.organization_id=? ORDER BY t.created_at DESC`,
      [req.params.id, req.user.organization_id]
    );
    res.json(tasks);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── GET /api/manager/members ── All staff with roles (for role management) ────
router.get('/members', async (req, res) => {
  try {
    const members = await dbAll(
      `SELECT id, name, email, role, status, department_id, position
       FROM users
       WHERE organization_id=? AND role != 'CLIENT'
       ORDER BY CASE role WHEN 'OWNER' THEN 0 WHEN 'ADMIN' THEN 1 WHEN 'MANAGER' THEN 2 ELSE 3 END, name`,
      [req.user.organization_id]
    );
    res.json(members);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── PATCH /api/manager/members/:id/role ── Change a user's role ───────────────
// Owner/Admin only. Enforces the single-Owner rule: the sole OWNER can neither
// be demoted here nor can a second OWNER be minted.
const ASSIGNABLE_ROLES = ['ADMIN', 'MANAGER', 'EMPLOYEE'];
router.patch('/members/:id/role', requireAdminOrAbove, async (req, res) => {
  try {
    const { role } = req.body;
    if (!ASSIGNABLE_ROLES.includes(role)) {
      return res.status(400).json({ error: `role must be one of: ${ASSIGNABLE_ROLES.join(', ')}` });
    }

    const target = await dbGet('SELECT * FROM users WHERE id=? AND organization_id=?', [req.params.id, req.user.organization_id]);
    if (!target) return res.status(404).json({ error: 'User not found' });
    if (target.role === 'OWNER') {
      return res.status(403).json({ error: 'The organization Owner cannot be reassigned' });
    }
    if (target.role === 'CLIENT') {
      return res.status(400).json({ error: 'Client accounts cannot be given a staff role' });
    }

    await dbRun('UPDATE users SET role=? WHERE id=?', [role, req.params.id]);
    const updated = await dbGet('SELECT id, name, email, role, status FROM users WHERE id=?', [req.params.id]);
    res.json(updated);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── GET /api/organizations/settings ──────────────────────────────────────────
router.get('/org-settings', async (req, res) => {
  try {
    const org = await dbGet('SELECT screenshot_interval, team_size, drive_folder_url FROM organizations WHERE id=?', [req.user.organization_id]);
    res.json(org || { screenshot_interval: 1, team_size: 10 });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── POST /api/organizations/settings ─────────────────────────────────────────
router.post('/org-settings', async (req, res) => {
  try {
    const { screenshotInterval, teamSize } = req.body;
    await dbRun(
      `UPDATE organizations SET screenshot_interval=COALESCE(?,screenshot_interval), team_size=COALESCE(?,team_size) WHERE id=?`,
      [screenshotInterval || null, teamSize || null, req.user.organization_id]
    );
    const org = await dbGet('SELECT screenshot_interval, team_size FROM organizations WHERE id=?', [req.user.organization_id]);
    res.json(org);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
