const express = require('express');
const { dbRun } = require('../database');
const { requireAuth } = require('../middleware/auth');
const { emitToOrg } = require('../socket');
const router = express.Router();

router.use(requireAuth);

// ── POST /api/activity/heartbeat ──────────────────────────────────────────────
router.post('/heartbeat', async (req, res) => {
  try {
    const { status, taskId, sessionId } = req.body;
    const userId = req.user.id;
    const orgId = req.user.organization_id;
    const id = Date.now().toString() + Math.random().toString(36).substr(2, 9);
    const timestamp = new Date().toISOString();

    await dbRun(
      `INSERT INTO activity_heartbeats (id, user_id, organization_id, status, task_id, session_id)
       VALUES (?, ?, ?, ?, ?, ?)`,
      [id, userId, orgId, status || 'active', taskId || null, sessionId || null]
    );

    emitToOrg(orgId, 'org:presence', {
      userId, name: req.user.name, status: status || 'active', timestamp,
    });

    res.json({ received: true, timestamp });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
