const express = require('express');
const { dbGet, dbRun, dbAll } = require('../database');
const { requireAuth, requireManagerOrAbove, requireStaff, resolveTargetUserId } = require('../middleware/auth');

const router = express.Router();
router.use(requireAuth, requireStaff);

const LOG_LABELS = {
  clock_in: 'Clocked In',
  clock_out: 'Clocked Out',
  break_start: 'Break Started',
  break_end: 'Break Ended',
  manual: 'Manual Entry',
};

// Helper: Build daily timesheet entry from attendance + timelogs, including a
// merged chronological activity timeline for the drill-down detail view.
async function buildDailyEntry(userId, orgId, date, includeTimeline = false) {
  const attendance = await dbGet(
    'SELECT * FROM attendance WHERE user_id=? AND date=?',
    [userId, date]
  );

  const logs = await dbAll(
    `SELECT * FROM time_logs WHERE user_id=? AND timestamp::date=?::date ORDER BY timestamp`,
    [userId, date]
  );

  const tasks = await dbAll(
    `SELECT DISTINCT t.id, t.title, t.status, t.project_id, p.name as project_name
     FROM sessions s
     JOIN tasks t ON t.id = s.task_id
     LEFT JOIN projects p ON p.id = t.project_id
     WHERE s.user_id=? AND s.started_at::date=?::date`,
    [userId, date]
  );

  const entry = {
    date,
    attendance: attendance || { status: 'absent', total_work_seconds: 0, total_break_seconds: 0 },
    logs,
    tasks,
    workHours: attendance ? Math.round(attendance.total_work_seconds / 36) / 100 : 0,
    breakHours: attendance ? Math.round(attendance.total_break_seconds / 36) / 100 : 0,
    idleHours: attendance ? Math.round((attendance.total_idle_seconds || 0) / 36) / 100 : 0,
    overtimeHours: attendance ? Math.round((attendance.total_overtime_seconds || 0) / 36) / 100 : 0,
  };

  if (includeTimeline) {
    const sessions = await dbAll(
      `SELECT s.id, s.started_at, s.ended_at, s.status, t.title as task_title, p.name as project_name
       FROM sessions s JOIN tasks t ON t.id = s.task_id LEFT JOIN projects p ON p.id = t.project_id
       WHERE s.user_id=? AND s.started_at::date=?::date ORDER BY s.started_at`,
      [userId, date]
    );

    const logEvents = logs.map((l) => ({
      timestamp: l.timestamp,
      type: l.type,
      label: LOG_LABELS[l.type] || l.type,
    }));
    const sessionEvents = sessions.flatMap((s) => {
      const events = [{
        timestamp: s.started_at,
        type: 'session_start',
        label: `Started working — ${s.task_title}${s.project_name ? ` (${s.project_name})` : ''}`,
      }];
      if (s.ended_at) {
        events.push({
          timestamp: s.ended_at,
          type: 'session_end',
          label: `Stopped working — ${s.task_title}${s.project_name ? ` (${s.project_name})` : ''}`,
        });
      }
      return events;
    });

    entry.timeline = [...logEvents, ...sessionEvents].sort(
      (a, b) => new Date(a.timestamp) - new Date(b.timestamp)
    );

    // Pair up break_start/break_end into durations for the detail view.
    const breaks = [];
    let openBreak = null;
    for (const l of logs) {
      if (l.type === 'break_start') openBreak = l.timestamp;
      else if (l.type === 'break_end' && openBreak) {
        breaks.push({ start: openBreak, end: l.timestamp });
        openBreak = null;
      }
    }
    if (openBreak) breaks.push({ start: openBreak, end: null });
    entry.breaks = breaks;
  }

  return entry;
}

// ── GET /api/timesheets/daily ─────────────────────────────────────────────────
router.get('/daily', async (req, res) => {
  try {
    const userId = resolveTargetUserId(req);
    const date = req.query.date || new Date().toISOString().split('T')[0];
    // /daily is the dedicated single-day drill-down target — always include the
    // full chronological timeline (clock events + break pairs + task sessions).
    const entry = await buildDailyEntry(userId, req.user.organization_id, date, true);
    res.json(entry);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── GET /api/timesheets/weekly ─────────────────────────────────────────────────
router.get('/weekly', async (req, res) => {
  try {
    const userId = resolveTargetUserId(req);
    const orgId = req.user.organization_id;

    // Get start of the requested week (default: current week)
    const weekStart = req.query.weekStart
      ? new Date(req.query.weekStart)
      : (() => {
          const d = new Date();
          d.setDate(d.getDate() - d.getDay());
          return d;
        })();

    const days = [];
    for (let i = 0; i < 7; i++) {
      const d = new Date(weekStart);
      d.setDate(d.getDate() + i);
      days.push(d.toISOString().split('T')[0]);
    }

    const entries = await Promise.all(days.map(date => buildDailyEntry(userId, orgId, date)));

    const totals = entries.reduce((acc, e) => ({
      totalWorkHours: acc.totalWorkHours + e.workHours,
      totalBreakHours: acc.totalBreakHours + e.breakHours,
      totalIdleHours: acc.totalIdleHours + e.idleHours,
      totalOvertimeHours: acc.totalOvertimeHours + e.overtimeHours,
    }), { totalWorkHours: 0, totalBreakHours: 0, totalIdleHours: 0, totalOvertimeHours: 0 });

    res.json({ weekStart: days[0], weekEnd: days[6], days: entries, totals });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── GET /api/timesheets/monthly ───────────────────────────────────────────────
router.get('/monthly', async (req, res) => {
  try {
    const userId = resolveTargetUserId(req);
    const orgId = req.user.organization_id;

    const year = parseInt(req.query.year || new Date().getFullYear());
    const month = parseInt(req.query.month || (new Date().getMonth() + 1));

    const daysInMonth = new Date(year, month, 0).getDate();
    const days = [];
    for (let d = 1; d <= daysInMonth; d++) {
      days.push(`${year}-${String(month).padStart(2,'0')}-${String(d).padStart(2,'0')}`);
    }

    const records = await dbAll(
      `SELECT * FROM attendance WHERE user_id=? AND date LIKE ?`,
      [userId, `${year}-${String(month).padStart(2,'0')}-%`]
    );

    const recordMap = {};
    for (const r of records) recordMap[r.date] = r;

    const summary = days.map(date => {
      const rec = recordMap[date];
      const workSecs = rec?.total_work_seconds || 0;
      const idleSecs = rec?.total_idle_seconds || 0;
      return {
        date,
        status: rec?.status || 'absent',
        workHours: rec ? Math.round(workSecs / 36) / 100 : 0,
        breakHours: rec ? Math.round(rec.total_break_seconds / 36) / 100 : 0,
        overtimeHours: rec ? Math.round((rec.total_overtime_seconds || 0) / 36) / 100 : 0,
        idleHours: rec ? Math.round(idleSecs / 36) / 100 : 0,
        productivity: workSecs > 0 ? Math.max(0, Math.min(100, Math.round(((workSecs - idleSecs) / workSecs) * 100))) : 0,
        clockIn: rec?.clock_in_time || null,
        clockOut: rec?.clock_out_time || null,
      };
    });

    const presentSummary = summary.filter((d) => d.status !== 'absent');
    const totals = summary.reduce((acc, d) => ({
      presentDays: acc.presentDays + (d.status === 'present' ? 1 : 0),
      absentDays: acc.absentDays + (d.status === 'absent' ? 1 : 0),
      lateDays: acc.lateDays + (d.status === 'late' ? 1 : 0),
      totalWorkHours: Math.round((acc.totalWorkHours + d.workHours) * 100) / 100,
      totalBreakHours: Math.round((acc.totalBreakHours + d.breakHours) * 100) / 100,
      totalIdleHours: Math.round((acc.totalIdleHours + d.idleHours) * 100) / 100,
      totalOvertimeHours: Math.round((acc.totalOvertimeHours + d.overtimeHours) * 100) / 100,
    }), { presentDays: 0, absentDays: 0, lateDays: 0, totalWorkHours: 0, totalBreakHours: 0, totalIdleHours: 0, totalOvertimeHours: 0 });
    totals.avgProductivity = presentSummary.length
      ? Math.round(presentSummary.reduce((s, d) => s + d.productivity, 0) / presentSummary.length)
      : 0;

    res.json({ year, month, days: summary, totals });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── GET /api/timesheets/team ──────────────────────────────────────────────────
// Manager view of all team members' today status
router.get('/team', requireManagerOrAbove, async (req, res) => {
  try {
    const today = req.query.date || new Date().toISOString().split('T')[0];
    const orgId = req.user.organization_id;

    const employees = await dbAll(
      `SELECT u.id, u.name, u.email, u.role, u.status,
        a.status as attendance_status, a.clock_in_time, a.clock_out_time,
        a.total_work_seconds, a.total_break_seconds
       FROM users u
       LEFT JOIN attendance a ON a.user_id=u.id AND a.date=?
       WHERE u.organization_id=? AND u.status='ACTIVE'
       ORDER BY u.name`,
      [today, orgId]
    );

    res.json(employees);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
