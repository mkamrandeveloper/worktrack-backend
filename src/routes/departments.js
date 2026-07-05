const express = require('express');
const { v4: uuidv4 } = require('uuid');
const { dbGet, dbRun, dbAll } = require('../database');
const { requireAuth, requireManagerOrAbove, requireAdminOrAbove, requireStaff } = require('../middleware/auth');

const router = express.Router();
// Departments are internal company data — never exposed to external CLIENT users.
router.use(requireAuth, requireStaff);

// ── GET /api/departments ─────────────────────────────────────────────────────
router.get('/', async (req, res) => {
  try {
    const deps = await dbAll(
      `SELECT d.*, COUNT(u.id) as member_count
       FROM departments d
       LEFT JOIN users u ON u.department_id = d.id
       WHERE d.organization_id = ?
       GROUP BY d.id
       ORDER BY d.name`,
      [req.user.organization_id]
    );
    res.json(deps);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── POST /api/departments ────────────────────────────────────────────────────
router.post('/', requireManagerOrAbove, async (req, res) => {
  try {
    const { name, description } = req.body;
    if (!name) return res.status(400).json({ error: 'Department name is required' });
    const id = uuidv4();
    await dbRun(
      'INSERT INTO departments (id, organization_id, name, description) VALUES (?, ?, ?, ?)',
      [id, req.user.organization_id, name, description || null]
    );
    const dep = await dbGet('SELECT * FROM departments WHERE id = ?', [id]);
    res.status(201).json(dep);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── PATCH /api/departments/:id ───────────────────────────────────────────────
router.patch('/:id', requireManagerOrAbove, async (req, res) => {
  try {
    const { name, description } = req.body;
    await dbRun(
      'UPDATE departments SET name=COALESCE(?,name), description=COALESCE(?,description) WHERE id=? AND organization_id=?',
      [name || null, description || null, req.params.id, req.user.organization_id]
    );
    const dep = await dbGet('SELECT * FROM departments WHERE id = ?', [req.params.id]);
    res.json(dep);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── DELETE /api/departments/:id ──────────────────────────────────────────────
router.delete('/:id', requireAdminOrAbove, async (req, res) => {
  try {
    await dbRun(
      'DELETE FROM departments WHERE id=? AND organization_id=?',
      [req.params.id, req.user.organization_id]
    );
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
