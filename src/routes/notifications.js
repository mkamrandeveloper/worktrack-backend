const express = require('express');
const { v4: uuidv4 } = require('uuid');
const { dbGet, dbRun, dbAll } = require('../database');
const { requireAuth } = require('../middleware/auth');

const router = express.Router();
router.use(requireAuth);

// Helper to create a notification
async function createNotification(userId, orgId, type, title, message, data = {}) {
  const id = uuidv4();
  await dbRun(
    `INSERT INTO notifications (id, user_id, organization_id, type, title, message, data)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
    [id, userId, orgId, type, title, message, JSON.stringify(data)]
  );
  return id;
}

// ── GET /api/notifications ────────────────────────────────────────────────────
router.get('/', async (req, res) => {
  try {
    const { unreadOnly, limit } = req.query;
    let query = 'SELECT * FROM notifications WHERE user_id=?';
    const params = [req.user.id];

    if (unreadOnly === 'true') {
      query += ' AND is_read=0';
    }
    query += ' ORDER BY created_at DESC LIMIT ?';
    params.push(parseInt(limit || '50'));

    const notifications = await dbAll(query, params);
    const unreadCount = await dbGet(
      'SELECT COUNT(*) as count FROM notifications WHERE user_id=? AND is_read=0',
      [req.user.id]
    );

    res.json({ notifications, unreadCount: unreadCount?.count || 0 });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── POST /api/notifications/:id/read ─────────────────────────────────────────
router.post('/:id/read', async (req, res) => {
  try {
    await dbRun(
      'UPDATE notifications SET is_read=1 WHERE id=? AND user_id=?',
      [req.params.id, req.user.id]
    );
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── POST /api/notifications/read-all ─────────────────────────────────────────
router.post('/read-all', async (req, res) => {
  try {
    await dbRun(
      'UPDATE notifications SET is_read=1 WHERE user_id=?',
      [req.user.id]
    );
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Export the helper for use in other routes
module.exports = router;
module.exports.createNotification = createNotification;
