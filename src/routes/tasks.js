const express = require('express');
const { v4: uuidv4 } = require('uuid');
const { dbGet, dbRun, dbAll } = require('../database');
const { requireAuth, requireStaff } = require('../middleware/auth');
const { emitToOrg } = require('../socket');
const router = express.Router();

async function emitTimerActivity(orgId, userId, taskId, status) {
  const task = await dbGet(
    `SELECT t.id, t.title, t.project_id, p.name as project_name FROM tasks t
     LEFT JOIN projects p ON p.id = t.project_id WHERE t.id=?`,
    [taskId]
  );
  emitToOrg(orgId, 'org:timer', {
    userId, taskId, taskTitle: task?.title, projectId: task?.project_id, projectName: task?.project_name,
    status, timestamp: new Date().toISOString(),
  });
}

// Timer/task endpoints are for staff only — external CLIENT users never track time.
router.use(requireAuth, requireStaff);

// ── GET /api/tasks/assigned ───────────────────────────────────────────────────
router.get('/assigned', async (req, res) => {
  try {
    const tasks = await dbAll(
      `SELECT *,
        ROUND(MAX(0, estimated_hours - logged_hours), 2) as remainingHours,
        CASE WHEN estimated_hours > 0 THEN MIN(100, ROUND((logged_hours / estimated_hours) * 100)) ELSE 0 END as progressPercent
       FROM tasks WHERE assignee_id=? ORDER BY created_at DESC`,
      [req.user.id]
    );
    res.json(tasks);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── POST /api/tasks/:taskId/sessions/start ────────────────────────────────────
router.post('/:taskId/sessions/start', async (req, res) => {
  try {
    const { taskId } = req.params;
    const task = await dbGet('SELECT * FROM tasks WHERE id=? AND assignee_id=?', [taskId, req.user.id]);
    if (!task) return res.status(404).json({ error: 'Task not found' });

    // Close any existing open session
    await dbRun(
      `UPDATE sessions SET ended_at=CURRENT_TIMESTAMP, status='stopped' WHERE user_id=? AND status='running'`,
      [req.user.id]
    );

    const sessionId = uuidv4();
    await dbRun(
      `INSERT INTO sessions (id, task_id, user_id, started_at, status) VALUES (?, ?, ?, CURRENT_TIMESTAMP, 'running')`,
      [sessionId, taskId, req.user.id]
    );
    await dbRun(`UPDATE tasks SET status='IN_PROGRESS' WHERE id=?`, [taskId]);
    emitTimerActivity(req.user.organization_id, req.user.id, taskId, 'running');

    res.json({ sessionId, startTime: new Date().toISOString() });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── POST /api/sessions/:sessionId/stop ───────────────────────────────────────
router.post('/:sessionId/stop', async (req, res) => {
  try {
    const { sessionId } = req.params;
    const session = await dbGet('SELECT * FROM sessions WHERE id=? AND user_id=?', [sessionId, req.user.id]);
    if (!session) return res.status(404).json({ error: 'Session not found' });

    const now = new Date();
    const startedAt = new Date(session.started_at);
    const durationMs = now - startedAt - (session.paused_duration || 0);
    const hoursWorked = durationMs / 3600000;

    await dbRun(
      `UPDATE sessions SET ended_at=?, status='stopped' WHERE id=?`,
      [now.toISOString(), sessionId]
    );
    // Accumulate logged hours
    await dbRun(
      `UPDATE tasks SET logged_hours = logged_hours + ?, status=CASE WHEN logged_hours + ? >= estimated_hours THEN 'DONE' ELSE status END WHERE id=?`,
      [hoursWorked, hoursWorked, session.task_id]
    );
    emitTimerActivity(req.user.organization_id, req.user.id, session.task_id, 'stopped');

    res.json({ success: true, hoursWorked, endTime: now.toISOString() });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── POST /api/sessions/:sessionId/pause ──────────────────────────────────────
router.post('/:sessionId/pause', async (req, res) => {
  try {
    await dbRun(`UPDATE sessions SET status='paused' WHERE id=? AND user_id=?`, [req.params.sessionId, req.user.id]);
    const session = await dbGet('SELECT task_id FROM sessions WHERE id=?', [req.params.sessionId]);
    if (session) emitTimerActivity(req.user.organization_id, req.user.id, session.task_id, 'paused');
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── POST /api/sessions/:sessionId/resume ─────────────────────────────────────
router.post('/:sessionId/resume', async (req, res) => {
  try {
    await dbRun(`UPDATE sessions SET status='running' WHERE id=? AND user_id=?`, [req.params.sessionId, req.user.id]);
    const session = await dbGet('SELECT task_id FROM sessions WHERE id=?', [req.params.sessionId]);
    if (session) emitTimerActivity(req.user.organization_id, req.user.id, session.task_id, 'running');
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── POST /api/sessions/:sessionId/break/start ────────────────────────────────
router.post('/:sessionId/break/start', async (req, res) => {
  try {
    await dbRun(`UPDATE sessions SET status='on_break' WHERE id=? AND user_id=?`, [req.params.sessionId, req.user.id]);
    const session = await dbGet('SELECT task_id FROM sessions WHERE id=?', [req.params.sessionId]);
    if (session) emitTimerActivity(req.user.organization_id, req.user.id, session.task_id, 'on_break');
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── POST /api/sessions/:sessionId/break/end ──────────────────────────────────
router.post('/:sessionId/break/end', async (req, res) => {
  try {
    await dbRun(`UPDATE sessions SET status='running' WHERE id=? AND user_id=?`, [req.params.sessionId, req.user.id]);
    const session = await dbGet('SELECT task_id FROM sessions WHERE id=?', [req.params.sessionId]);
    if (session) emitTimerActivity(req.user.organization_id, req.user.id, session.task_id, 'running');
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
