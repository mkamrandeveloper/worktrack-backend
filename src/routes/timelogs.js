const express = require('express');
const { v4: uuidv4 } = require('uuid');
const { dbGet, dbRun, dbAll } = require('../database');
const { requireAuth, requireStaff, resolveTargetUserId } = require('../middleware/auth');

const router = express.Router();
router.use(requireAuth, requireStaff);

// Helper: get or create today's attendance record
async function ensureAttendanceRecord(userId, orgId, date) {
  let record = await dbGet(
    'SELECT * FROM attendance WHERE user_id=? AND date=?',
    [userId, date]
  );
  if (!record) {
    const id = uuidv4();
    await dbRun(
      `INSERT INTO attendance (id, user_id, organization_id, date, status)
       VALUES (?, ?, ?, ?, 'present')`,
      [id, userId, orgId, date]
    );
    record = await dbGet('SELECT * FROM attendance WHERE id=?', [id]);
  }
  return record;
}

// ── POST /api/timelogs/clock-in ──────────────────────────────────────────────
router.post('/clock-in', async (req, res) => {
  try {
    const userId = req.user.id;
    const orgId = req.user.organization_id;
    const today = new Date().toISOString().split('T')[0];
    const now = new Date().toISOString();

    // Check not already clocked in
    const lastLog = await dbGet(
      `SELECT * FROM time_logs WHERE user_id=? AND type IN ('clock_in','clock_out')
       ORDER BY timestamp DESC LIMIT 1`,
      [userId]
    );
    if (lastLog && lastLog.type === 'clock_in') {
      return res.status(400).json({ error: 'Already clocked in' });
    }

    const id = uuidv4();
    await dbRun(
      `INSERT INTO time_logs (id, user_id, organization_id, type, timestamp) VALUES (?, ?, ?, 'clock_in', ?)`,
      [id, userId, orgId, now]
    );

    // Update attendance record
    const attendance = await ensureAttendanceRecord(userId, orgId, today);
    await dbRun(
      'UPDATE attendance SET clock_in_time=?, status=? WHERE id=?',
      [now, 'present', attendance.id]
    );

    res.json({ success: true, timestamp: now, logId: id });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── POST /api/timelogs/clock-out ─────────────────────────────────────────────
router.post('/clock-out', async (req, res) => {
  try {
    const userId = req.user.id;
    const orgId = req.user.organization_id;
    const today = new Date().toISOString().split('T')[0];
    const now = new Date().toISOString();

    const lastLog = await dbGet(
      `SELECT * FROM time_logs WHERE user_id=? AND type IN ('clock_in','clock_out')
       ORDER BY timestamp DESC LIMIT 1`,
      [userId]
    );
    if (!lastLog || lastLog.type === 'clock_out') {
      return res.status(400).json({ error: 'Not clocked in' });
    }

    const id = uuidv4();
    await dbRun(
      `INSERT INTO time_logs (id, user_id, organization_id, type, timestamp) VALUES (?, ?, ?, 'clock_out', ?)`,
      [id, userId, orgId, now]
    );

    // Calculate worked seconds
    const clockInTime = new Date(lastLog.timestamp).getTime();
    const workedSeconds = Math.round((Date.now() - clockInTime) / 1000);

    const attendance = await ensureAttendanceRecord(userId, orgId, today);
    await dbRun(
      `UPDATE attendance SET
        clock_out_time=?,
        total_work_seconds=total_work_seconds+?
       WHERE id=?`,
      [now, workedSeconds, attendance.id]
    );

    res.json({ success: true, timestamp: now, workedSeconds });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── POST /api/timelogs/break-start ───────────────────────────────────────────
router.post('/break-start', async (req, res) => {
  try {
    const id = uuidv4();
    const now = new Date().toISOString();
    await dbRun(
      `INSERT INTO time_logs (id, user_id, organization_id, type, timestamp) VALUES (?, ?, ?, 'break_start', ?)`,
      [id, req.user.id, req.user.organization_id, now]
    );
    res.json({ success: true, timestamp: now });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── POST /api/timelogs/break-end ─────────────────────────────────────────────
router.post('/break-end', async (req, res) => {
  try {
    const userId = req.user.id;
    const today = new Date().toISOString().split('T')[0];
    const now = new Date().toISOString();

    const breakStart = await dbGet(
      `SELECT * FROM time_logs WHERE user_id=? AND type='break_start'
       ORDER BY timestamp DESC LIMIT 1`,
      [userId]
    );

    const id = uuidv4();
    await dbRun(
      `INSERT INTO time_logs (id, user_id, organization_id, type, timestamp) VALUES (?, ?, ?, 'break_end', ?)`,
      [id, userId, req.user.organization_id, now]
    );

    if (breakStart) {
      const breakSeconds = Math.round((Date.now() - new Date(breakStart.timestamp).getTime()) / 1000);
      const attendance = await dbGet('SELECT * FROM attendance WHERE user_id=? AND date=?', [userId, today]);
      if (attendance) {
        await dbRun(
          'UPDATE attendance SET total_break_seconds=total_break_seconds+? WHERE id=?',
          [breakSeconds, attendance.id]
        );
      }
    }

    res.json({ success: true, timestamp: now });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── GET /api/timelogs ─────────────────────────────────────────────────────────
router.get('/', async (req, res) => {
  try {
    const { from, to } = req.query;
    const orgId = req.user.organization_id;

    // Managers+ may target any user via ?userId=; everyone else is pinned to self.
    const targetUserId = resolveTargetUserId(req);

    let query = `
      SELECT tl.*, t.title as task_title, p.name as project_name
      FROM time_logs tl
      LEFT JOIN tasks t ON t.id = tl.task_id
      LEFT JOIN projects p ON p.id = tl.project_id
      WHERE tl.organization_id=? AND tl.user_id=?`;
    const params = [orgId, targetUserId];

    if (from) { query += ' AND tl.timestamp >= ?'; params.push(from); }
    if (to) { query += ' AND tl.timestamp <= ?'; params.push(to); }
    query += ' ORDER BY tl.timestamp DESC LIMIT 500';

    const logs = await dbAll(query, params);
    res.json(logs);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
