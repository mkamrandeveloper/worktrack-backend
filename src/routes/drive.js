const express = require('express');
const { dbGet } = require('../database');
const { requireAuth, requireManagerOrAbove } = require('../middleware/auth');
const { getAuthUrl, handleOAuthCallback, setupOrgFolders, getTokensForOrg } = require('../services/driveService');
const router = express.Router();

router.use(requireAuth);

// ── GET /api/drive/auth-url ───────────────────────────────────────────────────
router.get('/auth-url', requireManagerOrAbove, async (req, res) => {
  try {
    const url = getAuthUrl();
    res.json({ url });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── POST /api/drive/callback ──────────────────────────────────────────────────
router.post('/callback', requireManagerOrAbove, async (req, res) => {
  try {
    const { code } = req.body;
    if (!code) return res.status(400).json({ error: 'Authorization code required' });

    await handleOAuthCallback(code, req.user.organization_id);
    
    // Setup folder structure
    const { orgFolderUrl } = await setupOrgFolders(req.user.organization_id);

    res.json({ success: true, orgFolderUrl });
  } catch (err) {
    console.error('Drive callback error:', err);
    res.status(500).json({ error: err.message });
  }
});

// ── GET /api/drive/status ─────────────────────────────────────────────────────
router.get('/status', async (req, res) => {
  try {
    const tokens = await getTokensForOrg(req.user.organization_id);
    const org = await dbGet('SELECT drive_folder_url FROM organizations WHERE id=?', [req.user.organization_id]);
    res.json({
      connected: !!tokens,
      orgFolderUrl: org?.drive_folder_url || null
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
