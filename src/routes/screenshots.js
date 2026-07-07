const express = require('express');
const multer = require('multer');
const { v4: uuidv4 } = require('uuid');
const { dbGet, dbRun, dbAll } = require('../database');
const { requireAuth, requireManagerOrAbove, canViewOthers } = require('../middleware/auth');
const { uploadScreenshot, downloadScreenshot } = require('../services/driveService');
const router = express.Router();

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 10 * 1024 * 1024 } });

router.use(requireAuth);

// ── GET /api/screenshots ──────────────────────────────────────────────────────
// Unified, role-scoped listing behind the new dedicated Screenshots page.
// OWNER/ADMIN/MANAGER: org-wide, optionally filtered to one employee (?userId=).
// EMPLOYEE: always pinned to themselves regardless of ?userId=.
// CLIENT: only screenshots whose task belongs to one of their invited projects.
router.get('/', async (req, res) => {
  try {
    const { userId, projectId, from, to, limit, offset } = req.query;
    const role = req.user.role;
    const lim = Math.min(parseInt(limit || '40', 10) || 40, 200);
    const off = parseInt(offset || '0', 10) || 0;

    const conditions = ['u.organization_id = ?', "s.upload_status = 'uploaded'"];
    const params = [req.user.organization_id];

    if (canViewOthers(role)) {
      if (userId) {
        conditions.push('s.user_id = ?');
        params.push(userId);
      }
    } else if (role === 'CLIENT') {
      conditions.push('t.project_id IN (SELECT project_id FROM project_members WHERE user_id = ?)');
      params.push(req.user.id);
    } else {
      conditions.push('s.user_id = ?');
      params.push(req.user.id);
    }

    if (projectId) {
      conditions.push('t.project_id = ?');
      params.push(projectId);
    }
    if (from) {
      conditions.push('s.captured_at >= ?::timestamp');
      params.push(from);
    }
    if (to) {
      conditions.push('s.captured_at <= ?::timestamp');
      params.push(to);
    }

    params.push(lim, off);

    const screenshots = await dbAll(
      `SELECT
         s.id,
         s.captured_at as "capturedAt",
         s.upload_status as "uploadStatus",
         s.drive_file_id as "driveFileId",
         s.drive_file_url as "driveFileUrl",
         s.user_id as "userId",
         u.name as "employeeName",
         s.task_id as "taskId",
         t.title as "taskTitle",
         t.project_id as "projectId",
         p.name as "projectName"
       FROM screenshots s
       JOIN users u ON u.id = s.user_id
       LEFT JOIN tasks t ON t.id = s.task_id
       LEFT JOIN projects p ON p.id = t.project_id
       WHERE ${conditions.join(' AND ')}
       ORDER BY s.captured_at DESC
       LIMIT ? OFFSET ?`,
      params
    );

    res.json(screenshots);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── GET /api/screenshots/breaks ───────────────────────────────────────────────
// Break intervals for the Screenshots page's timeline, so a gap in captures
// reads as "on break" instead of looking like missing/failed data. Not
// project-scoped (breaks aren't tied to a project) — CLIENT gets none.
router.get('/breaks', async (req, res) => {
  try {
    const { userId, from, to } = req.query;
    const role = req.user.role;

    if (role === 'CLIENT') return res.json([]);

    const conditions = ["tl.organization_id = ?", "tl.type IN ('break_start','break_end')"];
    const params = [req.user.organization_id];

    if (canViewOthers(role)) {
      if (userId) {
        conditions.push('tl.user_id = ?');
        params.push(userId);
      }
    } else {
      conditions.push('tl.user_id = ?');
      params.push(req.user.id);
    }
    if (from) {
      conditions.push('tl.timestamp >= ?::timestamp');
      params.push(from);
    }
    if (to) {
      conditions.push('tl.timestamp <= ?::timestamp');
      params.push(to);
    }

    const rows = await dbAll(
      `SELECT tl.user_id as "userId", u.name as "employeeName", tl.type, tl.timestamp
       FROM time_logs tl
       JOIN users u ON u.id = tl.user_id
       WHERE ${conditions.join(' AND ')}
       ORDER BY tl.user_id, tl.timestamp ASC`,
      params
    );

    // Pair each break_start with the next break_end for that same user.
    const breaks = [];
    const openByUser = {};
    for (const row of rows) {
      if (row.type === 'break_start') {
        openByUser[row.userId] = row;
      } else if (row.type === 'break_end' && openByUser[row.userId]) {
        breaks.push({
          userId: row.userId,
          employeeName: row.employeeName,
          start: openByUser[row.userId].timestamp,
          end: row.timestamp,
        });
        delete openByUser[row.userId];
      }
    }
    // Any still-open break (no matching end yet) is an ongoing break.
    for (const userId of Object.keys(openByUser)) {
      breaks.push({
        userId,
        employeeName: openByUser[userId].employeeName,
        start: openByUser[userId].timestamp,
        end: null,
      });
    }

    res.json(breaks);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── GET /api/screenshots/:id/image ────────────────────────────────────────────
// Streams the raw image bytes from Drive so files never need to be made
// Drive-shareable — access is gated entirely by our own RBAC below.
router.get('/:id/image', async (req, res) => {
  try {
    const row = await dbGet(
      `SELECT s.id, s.drive_file_id, s.user_id, u.organization_id as org_id, t.project_id as project_id
       FROM screenshots s
       JOIN users u ON u.id = s.user_id
       LEFT JOIN tasks t ON t.id = s.task_id
       WHERE s.id = ?`,
      [req.params.id]
    );
    if (!row || !row.drive_file_id) return res.status(404).json({ error: 'Screenshot not found' });
    if (row.org_id !== req.user.organization_id) return res.status(403).json({ error: 'Forbidden' });

    if (!canViewOthers(req.user.role)) {
      if (req.user.role === 'CLIENT') {
        if (!row.project_id) return res.status(403).json({ error: 'Forbidden' });
        const member = await dbGet(
          'SELECT 1 FROM project_members WHERE project_id=? AND user_id=?',
          [row.project_id, req.user.id]
        );
        if (!member) return res.status(403).json({ error: 'Forbidden' });
      } else if (row.user_id !== req.user.id) {
        return res.status(403).json({ error: 'Forbidden' });
      }
    }

    const stream = await downloadScreenshot(row.drive_file_id);
    res.setHeader('Content-Type', 'image/jpeg');
    res.setHeader('Cache-Control', 'private, max-age=3600');
    stream.on('error', () => res.status(502).end());
    stream.pipe(res);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── POST /api/screenshots/upload ──────────────────────────────────────────────
// Called by the desktop app's ScreenshotService after capturing
router.post('/upload', upload.single('screenshot'), async (req, res) => {
  try {
    const userId = req.user.id;
    const { taskId, sessionId } = req.body;

    if (!req.file) return res.status(400).json({ error: 'No screenshot file provided' });

    const screenshotId = uuidv4();
    const filename = `screenshot_${new Date().toISOString().replace(/[:.]/g, '-')}.png`;

    // Save pending record immediately
    await dbRun(
      `INSERT INTO screenshots (id, session_id, user_id, task_id, captured_at, upload_status) VALUES (?, ?, ?, ?, CURRENT_TIMESTAMP, 'uploading')`,
      [screenshotId, sessionId || null, userId, taskId || null]
    );

    // Upload to Google Drive asynchronously
    uploadScreenshot(userId, req.file.buffer, filename)
      .then(async ({ fileId, fileUrl }) => {
        await dbRun(
          `UPDATE screenshots SET drive_file_id=?, drive_file_url=?, upload_status='uploaded' WHERE id=?`,
          [fileId, fileUrl, screenshotId]
        );
      })
      .catch(async (err) => {
        console.error(`Drive upload failed for ${screenshotId}:`, err.message);
        await dbRun(
          `UPDATE screenshots SET upload_status='failed', error=? WHERE id=?`,
          [err.message, screenshotId]
        );
      });

    res.json({ screenshotId, status: 'uploading', message: 'Screenshot received, uploading to Drive.' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── GET /api/screenshots/recent ───────────────────────────────────────────────
// Used by the Settings page to verify screenshots are working
router.get('/recent', async (req, res) => {
  try {
    const userId = req.user.id;
    const screenshots = await dbAll(
      `SELECT id, captured_at as "capturedAt", upload_status as "uploadStatus",
              drive_file_url as "driveFileUrl", error, task_id as "taskId"
       FROM screenshots
       WHERE user_id=? ORDER BY captured_at DESC LIMIT 10`,
      [userId]
    );
    res.json(screenshots);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── GET /api/screenshots/employee/:userId ─────────────────────────────────────
// Owner/Admin/Manager can view screenshots of a specific employee (same org).
router.get('/employee/:userId', requireManagerOrAbove, async (req, res) => {
  try {
    const target = await dbGet('SELECT id FROM users WHERE id=? AND organization_id=?', [req.params.userId, req.user.organization_id]);
    if (!target) return res.status(404).json({ error: 'Employee not found' });
    const screenshots = await dbAll(
      `SELECT id, captured_at as "capturedAt", upload_status as "uploadStatus",
              drive_file_url as "driveFileUrl", task_id as "taskId"
       FROM screenshots
       WHERE user_id=? ORDER BY captured_at DESC LIMIT 50`,
      [req.params.userId]
    );
    res.json(screenshots);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── GET /api/screenshots/project/:projectId ───────────────────────────────────
// Screenshots captured against a project's tasks. Accessible to managers+ or to
// any member of the project (including invited CLIENT users). Org-scoped.
router.get('/project/:projectId', async (req, res) => {
  try {
    const orgId = req.user.organization_id;
    const project = await dbGet('SELECT id FROM projects WHERE id=? AND organization_id=?', [req.params.projectId, orgId]);
    if (!project) return res.status(404).json({ error: 'Project not found' });

    if (!canViewOthers(req.user.role)) {
      const member = await dbGet(
        'SELECT 1 FROM project_members WHERE project_id=? AND user_id=?',
        [req.params.projectId, req.user.id]
      );
      if (!member) return res.status(403).json({ error: 'Not a member of this project' });
    }

    const screenshots = await dbAll(
      `SELECT s.id, s.captured_at as "capturedAt", s.upload_status as "uploadStatus",
              s.drive_file_url as "driveFileUrl", s.task_id as "taskId", u.name as "employeeName"
       FROM screenshots s
       JOIN tasks t ON t.id = s.task_id
       LEFT JOIN users u ON u.id = s.user_id
       WHERE t.project_id=? AND t.organization_id=? AND s.upload_status='uploaded'
       ORDER BY s.captured_at DESC LIMIT 100`,
      [req.params.projectId, orgId]
    );
    res.json(screenshots);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
