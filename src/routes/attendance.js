const express = require('express');
const { v4: uuidv4 } = require('uuid');
const { dbGet, dbRun, dbAll } = require('../database');
const { requireAuth, requireManagerOrAbove } = require('../middleware/auth');

const router = express.Router();
router.use(requireAuth);

// ── GET /api/attendance/live ──────────────────────────────────────────────────
// Real-time status of all employees (powered by heartbeat data)
router.get('/live', requireManagerOrAbove, async (req, res) => {
  try {
    const today = new Date().toISOString().split('T')[0];
    const orgId = req.user.organization_id;

    const employees = await dbAll(
      `SELECT
        u.id, u.name, u.email, u.role,
        a.status as attendance_status, a.clock_in_time, a.clock_out_time,
        a.total_work_seconds, a.total_break_seconds, a.total_overtime_seconds,
        -- Last heartbeat (activity status)
        (SELECT h.status FROM activity_heartbeats h WHERE h.user_id=u.id
         ORDER BY h.timestamp DESC LIMIT 1) as live_status,
        (SELECT h.timestamp FROM activity_heartbeats h WHERE h.user_id=u.id
         ORDER BY h.timestamp DESC LIMIT 1) as last_seen,
        -- Current task
        (SELECT t.title FROM sessions s JOIN tasks t ON t.id=s.task_id
         WHERE s.user_id=u.id AND s.status='running' LIMIT 1) as current_task,
        (SELECT p.name FROM sessions s JOIN tasks t ON t.id=s.task_id
         JOIN projects p ON p.id=t.project_id
         WHERE s.user_id=u.id AND s.status='running' LIMIT 1) as current_project
       FROM users u
       LEFT JOIN attendance a ON a.user_id=u.id AND a.date=?
       WHERE u.organization_id=? AND u.status='ACTIVE' AND u.role='EMPLOYEE'
       ORDER BY u.name`,
      [today, orgId]
    );

    // Add derived display status
    const now = Date.now();
    const enriched = employees.map(emp => {
      const lastSeen = emp.last_seen ? new Date(emp.last_seen).getTime() : 0;
      const secondsAgo = (now - lastSeen) / 1000;

      let displayStatus = 'offline';
      if (emp.clock_out_time && !emp.clock_in_time) {
        displayStatus = 'clocked_out';
      } else if (secondsAgo < 120) {
        displayStatus = emp.live_status || 'active';
      } else if (secondsAgo < 600) {
        displayStatus = 'idle';
      } else {
        displayStatus = 'offline';
      }

      return {
        id: emp.id,
        name: emp.name,
        email: emp.email,
        role: emp.role,
        attendanceStatus: emp.attendance_status,
        clockInTime: emp.clock_in_time,
        clockOutTime: emp.clock_out_time,
        totalWorkSeconds: emp.total_work_seconds || 0,
        totalBreakSeconds: emp.total_break_seconds || 0,
        liveStatus: emp.live_status,
        lastSeen: emp.last_seen,
        currentTask: emp.current_task,
        currentProject: emp.current_project,
        displayStatus: displayStatus,
        workHours: emp.total_work_seconds ? Math.round(emp.total_work_seconds / 36) / 100 : 0,
        breakHours: emp.total_break_seconds ? Math.round(emp.total_break_seconds / 36) / 100 : 0,
      };
    });

    res.json(enriched);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── GET /api/attendance/history ───────────────────────────────────────────────
router.get('/history', requireManagerOrAbove, async (req, res) => {
  try {
    const { from, to, userId } = req.query;
    const orgId = req.user.organization_id;

    let query = `
      SELECT a.*, u.name as user_name, u.email
      FROM attendance a JOIN users u ON u.id=a.user_id
      WHERE a.organization_id=?`;
    const params = [orgId];

    if (userId) { query += ' AND a.user_id=?'; params.push(userId); }
    if (from) { query += ' AND a.date>=?'; params.push(from); }
    if (to) { query += ' AND a.date<=?'; params.push(to); }
    query += ' ORDER BY a.date DESC, u.name LIMIT 500';

    const records = await dbAll(query, params);
    res.json(records);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── GET /api/attendance/summary ───────────────────────────────────────────────
// Summary stats for a given period
router.get('/summary', requireManagerOrAbove, async (req, res) => {
  try {
    const today = new Date().toISOString().split('T')[0];
    const orgId = req.user.organization_id;

    const stats = await dbGet(
      `SELECT
        COUNT(DISTINCT CASE WHEN a.status='present' THEN a.user_id END) as present_today,
        COUNT(DISTINCT u.id) as total_employees,
        COUNT(DISTINCT CASE WHEN a.status='late' THEN a.user_id END) as late_today
       FROM users u
       LEFT JOIN attendance a ON a.user_id=u.id AND a.date=?
       WHERE u.organization_id=? AND u.status='ACTIVE' AND u.role='EMPLOYEE'`,
      [today, orgId]
    );

    res.json(stats);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
