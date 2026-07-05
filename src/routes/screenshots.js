const express = require('express');
const multer = require('multer');
const { v4: uuidv4 } = require('uuid');
const { dbGet, dbRun, dbAll } = require('../database');
const { requireAuth, requireManagerOrAbove, canViewOthers } = require('../middleware/auth');
const { uploadScreenshot } = require('../services/driveService');
const router = express.Router();

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 10 * 1024 * 1024 } });

router.use(requireAuth);

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
      `SELECT id, captured_at, upload_status, drive_file_url, error, task_id FROM screenshots
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
      `SELECT id, captured_at, upload_status, drive_file_url, task_id FROM screenshots
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
      `SELECT s.id, s.captured_at, s.upload_status, s.drive_file_url, s.task_id, u.name as employee_name
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
