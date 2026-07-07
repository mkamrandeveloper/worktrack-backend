const express = require('express');
const { dbGet } = require('../database');
const { requireAuth, requireOwner } = require('../middleware/auth');
const { isDriveConfigured, getAuthUrl, exchangeAuthCode } = require('../services/driveService');
const router = express.Router();

router.use(requireAuth);

// Every organization automatically shares one Google Drive account (set up
// once via GOOGLE_DEFAULT_REFRESH_TOKEN) — there's no per-org connect step.
// The routes below only exist to rotate that shared account if its refresh
// token is ever revoked, so they're restricted to OWNER and don't touch the
// per-org state that the old per-org-connect flow used to manage.

// ── GET /api/drive/auth-url ───────────────────────────────────────────────────
router.get('/auth-url', requireOwner, async (req, res) => {
  try {
    const url = getAuthUrl();
    res.json({ url });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── POST /api/drive/callback ──────────────────────────────────────────────────
// Returns the new refresh token for the caller to set as
// GOOGLE_DEFAULT_REFRESH_TOKEN — it is intentionally not persisted anywhere
// automatically since it applies to every organization, not just the caller's.
router.post('/callback', requireOwner, async (req, res) => {
  try {
    const { code } = req.body;
    if (!code) return res.status(400).json({ error: 'Authorization code required' });

    const tokens = await exchangeAuthCode(code);
    res.json({
      success: true,
      refreshToken: tokens.refresh_token,
      message: 'Set this as GOOGLE_DEFAULT_REFRESH_TOKEN and restart the server to rotate the shared Drive account.',
    });
  } catch (err) {
    console.error('Drive callback error:', err);
    res.status(500).json({ error: err.message });
  }
});

// ── GET /api/drive/status ─────────────────────────────────────────────────────
router.get('/status', async (req, res) => {
  try {
    const org = await dbGet('SELECT drive_folder_url FROM organizations WHERE id=?', [req.user.organization_id]);
    res.json({
      connected: isDriveConfigured(),
      orgFolderUrl: org?.drive_folder_url || null,
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
