const express = require('express');
const ExcelJS = require('exceljs');
const { dbGet, dbRun, dbAll } = require('../database');
const { requireAuth, requireManagerOrAbove } = require('../middleware/auth');

const router = express.Router();
router.use(requireAuth, requireManagerOrAbove);

// ── Timesheet report helpers ──────────────────────────────────────────────────
const isoDay = (d) => d.toISOString().split('T')[0];

function periodRange(period, from, to) {
  const today = new Date();
  if (from && to) return { from, to };
  if (period === 'daily') return { from: from || isoDay(today), to: to || isoDay(today) };
  if (period === 'monthly') {
    const start = new Date(today.getFullYear(), today.getMonth(), 1);
    return { from: from || isoDay(start), to: to || isoDay(today) };
  }
  // weekly (default): last 7 days
  const start = new Date(today); start.setDate(today.getDate() - 6);
  return { from: from || isoDay(start), to: to || isoDay(today) };
}

async function buildTimesheetRows(orgId, from, to, userId, projectId) {
  const params = [orgId, from, to];
  let q = `
    SELECT a.date, a.user_id, u.name as employee_name, u.email,
      a.clock_in_time, a.clock_out_time,
      a.total_work_seconds, a.total_break_seconds, a.total_idle_seconds, a.total_overtime_seconds,
      a.status,
      (SELECT STRING_AGG(DISTINCT p.name, ', ') FROM sessions s
        JOIN tasks t ON t.id = s.task_id JOIN projects p ON p.id = t.project_id
        WHERE s.user_id = a.user_id AND s.started_at::date = a.date::date) as projects
    FROM attendance a JOIN users u ON u.id = a.user_id
    WHERE a.organization_id=? AND a.date BETWEEN ? AND ?`;
  if (userId) { q += ' AND a.user_id=?'; params.push(userId); }
  if (projectId) {
    q += ` AND EXISTS (SELECT 1 FROM sessions s JOIN tasks t ON t.id=s.task_id
           WHERE s.user_id=a.user_id AND s.started_at::date=a.date::date AND t.project_id=?)`;
    params.push(projectId);
  }
  q += ' ORDER BY a.date DESC, u.name';

  const rows = await dbAll(q, params);
  const hrs = (s) => Math.round(((s || 0) / 3600) * 100) / 100;
  const clock = (t) => (t ? new Date(t).toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit' }) : '—');
  return rows.map((r) => {
    const work = r.total_work_seconds || 0;
    const idle = r.total_idle_seconds || 0;
    const productivity = work > 0 ? Math.max(0, Math.min(100, Math.round(((work - idle) / work) * 100))) : 0;
    return {
      employeeName: r.employee_name,
      email: r.email,
      projects: r.projects || '—',
      date: r.date,
      clockIn: clock(r.clock_in_time),
      clockOut: clock(r.clock_out_time),
      workHours: hrs(work),
      breakHours: hrs(r.total_break_seconds),
      overtimeHours: hrs(r.total_overtime_seconds),
      idleHours: hrs(idle),
      productivity,
      status: r.status,
    };
  });
}

// ── GET /api/reports/timesheet ── Daily/Weekly/Monthly report data ────────────
router.get('/timesheet', async (req, res) => {
  try {
    const { period, from, to, userId, projectId } = req.query;
    const range = periodRange(period, from, to);
    const rows = await buildTimesheetRows(req.user.organization_id, range.from, range.to, userId, projectId);

    const summary = rows.reduce((a, r) => ({
      workHours: Math.round((a.workHours + r.workHours) * 100) / 100,
      breakHours: Math.round((a.breakHours + r.breakHours) * 100) / 100,
      overtimeHours: Math.round((a.overtimeHours + r.overtimeHours) * 100) / 100,
      idleHours: Math.round((a.idleHours + r.idleHours) * 100) / 100,
    }), { workHours: 0, breakHours: 0, overtimeHours: 0, idleHours: 0 });
    const avgProductivity = rows.length ? Math.round(rows.reduce((s, r) => s + r.productivity, 0) / rows.length) : 0;

    res.json({ period: period || 'weekly', range, rows, summary: { ...summary, avgProductivity, entries: rows.length } });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── GET /api/reports/timesheet.xlsx ── Formatted Excel export ─────────────────
router.get('/timesheet.xlsx', async (req, res) => {
  try {
    const { period, from, to, userId, projectId } = req.query;
    const range = periodRange(period, from, to);
    const rows = await buildTimesheetRows(req.user.organization_id, range.from, range.to, userId, projectId);
    const org = await dbGet('SELECT name FROM organizations WHERE id=?', [req.user.organization_id]);

    const wb = new ExcelJS.Workbook();
    wb.creator = 'WorkTrack';
    wb.created = new Date();
    const ws = wb.addWorksheet('Timesheet Report', { views: [{ state: 'frozen', ySplit: 3 }] });

    // Title band
    ws.mergeCells('A1:J1');
    ws.getCell('A1').value = `${org?.name || 'WorkTrack'} — Timesheet Report`;
    ws.getCell('A1').font = { bold: true, size: 14, color: { argb: 'FF7C3AED' } };
    ws.mergeCells('A2:J2');
    ws.getCell('A2').value = `Period: ${range.from} to ${range.to}  ·  Generated ${new Date().toLocaleString('en-US')}`;
    ws.getCell('A2').font = { size: 10, color: { argb: 'FF6B7280' } };

    const headers = ['Employee', 'Project', 'Date', 'Clock-In', 'Clock-Out', 'Working Hours', 'Break', 'Overtime', 'Idle', 'Productivity %'];
    const headerRow = ws.getRow(3);
    headers.forEach((h, i) => { headerRow.getCell(i + 1).value = h; });
    headerRow.height = 20;
    headerRow.eachCell((c) => {
      c.font = { bold: true, color: { argb: 'FFFFFFFF' } };
      c.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF7C3AED' } };
      c.alignment = { vertical: 'middle', horizontal: 'left' };
    });

    const widths = [24, 28, 14, 12, 12, 14, 10, 12, 10, 14];
    widths.forEach((w, i) => { ws.getColumn(i + 1).width = w; });

    rows.forEach((r) => {
      ws.addRow([r.employeeName, r.projects, r.date, r.clockIn, r.clockOut, r.workHours, r.breakHours, r.overtimeHours, r.idleHours, r.productivity]);
    });
    // Number formats for the hour columns + productivity
    [6, 7, 8, 9].forEach((col) => { ws.getColumn(col).numFmt = '0.00'; });
    ws.getColumn(10).numFmt = '0"%"';

    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', `attachment; filename="worktrack-timesheet-${range.from}_${range.to}.xlsx"`);
    await wb.xlsx.write(res);
    res.end();
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── GET /api/reports/overview ─────────────────────────────────────────────────
router.get('/overview', async (req, res) => {
  try {
    const orgId = req.user.organization_id;
    const { from, to } = req.query;
    const dateFrom = from || new Date(Date.now() - 30 * 86400000).toISOString().split('T')[0];
    const dateTo = to || new Date().toISOString().split('T')[0];

    const [employeeCount, taskStats, attendanceStats, projectStats] = await Promise.all([
      dbGet(`SELECT COUNT(*) as total FROM users WHERE organization_id=? AND status='ACTIVE' AND role='EMPLOYEE'`, [orgId]),
      dbGet(`SELECT
        COUNT(*) as total,
        SUM(CASE WHEN status='DONE' THEN 1 ELSE 0 END) as completed,
        SUM(CASE WHEN status='IN_PROGRESS' THEN 1 ELSE 0 END) as in_progress,
        AVG(logged_hours) as avg_hours
       FROM tasks WHERE organization_id=? AND created_at BETWEEN ? AND ?`,
        [orgId, dateFrom, dateTo]
      ),
      dbGet(`SELECT
        SUM(total_work_seconds) as total_work_seconds,
        SUM(total_break_seconds) as total_break_seconds,
        COUNT(DISTINCT CASE WHEN status='present' THEN user_id END) as unique_present,
        AVG(total_work_seconds) as avg_work_seconds
       FROM attendance WHERE organization_id=? AND date BETWEEN ? AND ?`,
        [orgId, dateFrom, dateTo]
      ),
      dbGet(`SELECT COUNT(*) as total,
        SUM(CASE WHEN status='ACTIVE' THEN 1 ELSE 0 END) as active,
        SUM(CASE WHEN status='COMPLETED' THEN 1 ELSE 0 END) as completed
       FROM projects WHERE organization_id=?`, [orgId]
      ),
    ]);

    res.json({
      period: { from: dateFrom, to: dateTo },
      employees: employeeCount,
      tasks: {
        ...taskStats,
        completion_rate: taskStats.total > 0
          ? Math.round((taskStats.completed / taskStats.total) * 100)
          : 0,
      },
      attendance: {
        ...attendanceStats,
        total_work_hours: attendanceStats.total_work_seconds
          ? Math.round(attendanceStats.total_work_seconds / 3600 * 10) / 10
          : 0,
      },
      projects: projectStats,
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── GET /api/reports/employee/:id ─────────────────────────────────────────────
router.get('/employee/:id', async (req, res) => {
  try {
    const orgId = req.user.organization_id;
    const { from, to } = req.query;
    const dateFrom = from || new Date(Date.now() - 30 * 86400000).toISOString().split('T')[0];
    const dateTo = to || new Date().toISOString().split('T')[0];
    const userId = req.params.id;

    const user = await dbGet('SELECT id, name, email, role, status FROM users WHERE id=? AND organization_id=?', [userId, orgId]);
    if (!user) return res.status(404).json({ error: 'Employee not found' });

    const [tasks, attendance, timeLogs] = await Promise.all([
      dbAll(`SELECT t.*, p.name as project_name FROM tasks t
             LEFT JOIN projects p ON p.id=t.project_id
             WHERE t.assignee_id=? AND t.organization_id=?
             ORDER BY t.created_at DESC`, [userId, orgId]
      ),
      dbAll(`SELECT * FROM attendance WHERE user_id=? AND date BETWEEN ? AND ? ORDER BY date`,
        [userId, dateFrom, dateTo]
      ),
      dbAll(`SELECT type, timestamp FROM time_logs WHERE user_id=? AND timestamp::date BETWEEN ?::date AND ?::date ORDER BY timestamp`,
        [userId, dateFrom, dateTo]
      ),
    ]);

    const attendanceSummary = attendance.reduce((acc, a) => ({
      totalWorkHours: acc.totalWorkHours + (a.total_work_seconds / 3600),
      totalBreakHours: acc.totalBreakHours + (a.total_break_seconds / 3600),
      presentDays: acc.presentDays + (a.status === 'present' ? 1 : 0),
      lateDays: acc.lateDays + (a.status === 'late' ? 1 : 0),
    }), { totalWorkHours: 0, totalBreakHours: 0, presentDays: 0, lateDays: 0 });

    res.json({
      user,
      period: { from: dateFrom, to: dateTo },
      tasks: { list: tasks, completed: tasks.filter(t => t.status === 'DONE').length, total: tasks.length },
      attendance: { daily: attendance, summary: attendanceSummary },
      timeLogs,
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── GET /api/reports/project/:id ──────────────────────────────────────────────
router.get('/project/:id', async (req, res) => {
  try {
    const orgId = req.user.organization_id;
    const project = await dbGet('SELECT * FROM projects WHERE id=? AND organization_id=?', [req.params.id, orgId]);
    if (!project) return res.status(404).json({ error: 'Project not found' });

    const [tasks, members] = await Promise.all([
      dbAll(`SELECT t.*, u.name as assignee_name FROM tasks t
             LEFT JOIN users u ON u.id=t.assignee_id
             WHERE t.project_id=? ORDER BY t.status, t.created_at`, [req.params.id]
      ),
      dbAll(`SELECT u.id, u.name, u.email, pm.role FROM project_members pm
             JOIN users u ON u.id=pm.user_id WHERE pm.project_id=?`, [req.params.id]
      ),
    ]);

    const taskSummary = {
      total: tasks.length,
      completed: tasks.filter(t => t.status === 'DONE').length,
      inProgress: tasks.filter(t => t.status === 'IN_PROGRESS').length,
      todo: tasks.filter(t => t.status === 'TODO').length,
      totalLoggedHours: tasks.reduce((s, t) => s + (t.logged_hours || 0), 0),
      totalEstimatedHours: tasks.reduce((s, t) => s + (t.estimated_hours || 0), 0),
    };

    const progressPercent = taskSummary.total > 0
      ? Math.round((taskSummary.completed / taskSummary.total) * 100)
      : 0;

    res.json({ project, tasks, members, taskSummary, progressPercent });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── GET /api/reports/attendance ───────────────────────────────────────────────
router.get('/attendance', async (req, res) => {
  try {
    const orgId = req.user.organization_id;
    const { from, to } = req.query;
    const dateFrom = from || new Date(Date.now() - 30 * 86400000).toISOString().split('T')[0];
    const dateTo = to || new Date().toISOString().split('T')[0];

    const records = await dbAll(
      `SELECT a.*, u.name, u.email FROM attendance a
       JOIN users u ON u.id=a.user_id
       WHERE a.organization_id=? AND a.date BETWEEN ? AND ?
       ORDER BY a.date DESC, u.name`,
      [orgId, dateFrom, dateTo]
    );

    res.json({
      period: { from: dateFrom, to: dateTo },
      records,
      summary: {
        totalPresent: records.filter(r => r.status === 'present').length,
        totalAbsent: records.filter(r => r.status === 'absent').length,
        totalLate: records.filter(r => r.status === 'late').length,
      },
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── GET /api/reports/productivity ─────────────────────────────────────────────
router.get('/productivity', async (req, res) => {
  try {
    const orgId = req.user.organization_id;
    const { from, to } = req.query;
    const dateFrom = from || new Date(Date.now() - 7 * 86400000).toISOString().split('T')[0];
    const dateTo = to || new Date().toISOString().split('T')[0];

    const employees = await dbAll(
      `SELECT u.id, u.name, u.email,
        SUM(a.total_work_seconds) as work_seconds,
        SUM(a.total_break_seconds) as break_seconds,
        SUM(a.total_idle_seconds) as idle_seconds,
        COUNT(CASE WHEN a.status='present' THEN 1 END) as present_days
       FROM users u
       LEFT JOIN attendance a ON a.user_id=u.id AND a.date BETWEEN ? AND ?
       WHERE u.organization_id=? AND u.role='EMPLOYEE' AND u.status='ACTIVE'
       GROUP BY u.id
       ORDER BY work_seconds DESC`,
      [dateFrom, dateTo, orgId]
    );

    const enriched = employees.map(e => ({
      ...e,
      workHours: Math.round((e.work_seconds || 0) / 360) / 10,
      breakHours: Math.round((e.break_seconds || 0) / 360) / 10,
      idleHours: Math.round((e.idle_seconds || 0) / 360) / 10,
      productivityScore: e.work_seconds
        ? Math.round(((e.work_seconds - (e.idle_seconds || 0)) / e.work_seconds) * 100)
        : 0,
    }));

    res.json({ period: { from: dateFrom, to: dateTo }, employees: enriched });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
