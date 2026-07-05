const express = require('express');
const bcrypt = require('bcryptjs');
const { v4: uuidv4 } = require('uuid');
const { dbGet, dbRun, dbAll } = require('../database');
const {
  requireAuth, requireManagerOrAbove, generateAccessToken, generateRefreshToken,
} = require('../middleware/auth');
const { sendClientInvitation } = require('../services/emailService');

const router = express.Router();

// ── GET /client-portal — Public client portal page ────────────────────────────
// This is served as a standalone HTML page (no auth required)
router.get('/portal', async (req, res) => {
  const { token } = req.query;
  if (!token) return res.status(400).send('<h1>Invalid invitation link</h1>');

  try {
    const project = await dbGet(
      'SELECT p.*, o.name as org_name FROM projects p JOIN organizations o ON o.id=p.organization_id WHERE p.client_invite_token=?',
      [token]
    );

    if (!project) return res.status(404).send('<h1>Invalid or expired invitation link</h1>');

    // Mark as accepted
    await dbRun('UPDATE projects SET client_invite_accepted=1 WHERE id=?', [project.id]);

    const tasks = await dbAll(
      `SELECT title, status, priority, deadline, estimated_hours, logged_hours FROM tasks
       WHERE project_id=? ORDER BY status, created_at`,
      [project.id]
    );

    const completedTasks = tasks.filter(t => t.status === 'DONE').length;
    const progressPercent = tasks.length > 0 ? Math.round((completedTasks / tasks.length) * 100) : 0;

    // Build a clean HTML portal
    const taskRows = tasks.map(t => `
      <tr>
        <td style="padding:12px 16px; border-bottom:1px solid #e5e7eb; font-weight:500">${t.title}</td>
        <td style="padding:12px 16px; border-bottom:1px solid #e5e7eb;">
          <span style="padding:4px 10px; border-radius:9999px; font-size:12px; font-weight:600;
            background:${t.status==='DONE'?'#dcfce7':t.status==='IN_PROGRESS'?'#dbeafe':'#f3f4f6'};
            color:${t.status==='DONE'?'#166534':t.status==='IN_PROGRESS'?'#1e40af':'#374151'}">
            ${t.status.replace('_',' ')}
          </span>
        </td>
        <td style="padding:12px 16px; border-bottom:1px solid #e5e7eb; color:#6b7280">
          ${t.deadline ? new Date(t.deadline).toLocaleDateString() : '—'}
        </td>
        <td style="padding:12px 16px; border-bottom:1px solid #e5e7eb; color:#6b7280">
          ${t.logged_hours || 0}h / ${t.estimated_hours || 0}h
        </td>
      </tr>
    `).join('');

    res.send(`
      <!DOCTYPE html>
      <html lang="en">
      <head>
        <meta charset="UTF-8" />
        <meta name="viewport" content="width=device-width, initial-scale=1.0" />
        <title>${project.name} — Client Portal | WorkTrack</title>
        <style>
          * { box-sizing: border-box; margin: 0; padding: 0; }
          body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; background: #f9fafb; color: #111827; }
          .header { background: #7c3aed; padding: 24px 40px; color: white; }
          .header h1 { font-size: 20px; font-weight: 600; }
          .header p { font-size: 14px; opacity: 0.8; margin-top: 4px; }
          .container { max-width: 960px; margin: 40px auto; padding: 0 24px; }
          .card { background: white; border-radius: 12px; border: 1px solid #e5e7eb; padding: 24px; margin-bottom: 24px; }
          .card h2 { font-size: 16px; font-weight: 600; margin-bottom: 16px; color: #374151; }
          .kpi-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(160px, 1fr)); gap: 16px; margin-bottom: 24px; }
          .kpi { background: white; border: 1px solid #e5e7eb; border-radius: 12px; padding: 20px; text-align: center; }
          .kpi .value { font-size: 32px; font-weight: 700; color: #7c3aed; }
          .kpi .label { font-size: 13px; color: #6b7280; margin-top: 4px; }
          .progress-bar-wrap { background: #f3f4f6; border-radius: 9999px; height: 12px; overflow: hidden; }
          .progress-bar-fill { background: #7c3aed; height: 100%; border-radius: 9999px; transition: width 1s ease; }
          table { width: 100%; border-collapse: collapse; }
          th { text-align: left; padding: 12px 16px; font-size: 12px; text-transform: uppercase; color: #6b7280; letter-spacing: 0.05em; border-bottom: 2px solid #e5e7eb; }
          .footer { text-align: center; color: #9ca3af; font-size: 12px; padding: 40px 0; }
        </style>
      </head>
      <body>
        <div class="header">
          <h1>📊 ${project.name}</h1>
          <p>${project.org_name} · Client Project Portal</p>
        </div>
        <div class="container">
          <div class="kpi-grid">
            <div class="kpi"><div class="value">${progressPercent}%</div><div class="label">Overall Progress</div></div>
            <div class="kpi"><div class="value">${tasks.length}</div><div class="label">Total Tasks</div></div>
            <div class="kpi"><div class="value">${completedTasks}</div><div class="label">Completed</div></div>
            <div class="kpi"><div class="value">${project.deadline ? new Date(project.deadline).toLocaleDateString() : 'TBD'}</div><div class="label">Deadline</div></div>
          </div>

          <div class="card">
            <h2>Project Completion</h2>
            <div style="margin-bottom:8px; display:flex; justify-content:space-between; font-size:14px;">
              <span>${completedTasks} of ${tasks.length} tasks completed</span>
              <strong>${progressPercent}%</strong>
            </div>
            <div class="progress-bar-wrap">
              <div class="progress-bar-fill" style="width:${progressPercent}%"></div>
            </div>
          </div>

          ${project.description ? `
          <div class="card">
            <h2>Project Description</h2>
            <p style="color:#6b7280; line-height:1.6">${project.description}</p>
          </div>` : ''}

          <div class="card">
            <h2>Deliverables & Tasks</h2>
            <table>
              <thead>
                <tr>
                  <th>Task</th><th>Status</th><th>Deadline</th><th>Hours</th>
                </tr>
              </thead>
              <tbody>${taskRows || '<tr><td colspan="4" style="padding:20px;text-align:center;color:#9ca3af">No tasks yet</td></tr>'}</tbody>
            </table>
          </div>
        </div>
        <div class="footer">Powered by WorkTrack · Confidential — for authorized clients only</div>
      </body>
      </html>
    `);
  } catch (err) {
    res.status(500).send('<h1>Server error</h1>');
  }
});

// ── POST /api/clients/invite ───────────────────────────────────────────────────
router.post('/invite', requireAuth, requireManagerOrAbove, async (req, res) => {
  try {
    const { projectId, clientEmail, clientName } = req.body;
    if (!projectId || !clientEmail) return res.status(400).json({ error: 'projectId and clientEmail required' });

    const project = await dbGet('SELECT * FROM projects WHERE id=? AND organization_id=?', [projectId, req.user.organization_id]);
    if (!project) return res.status(404).json({ error: 'Project not found' });

    const token = project.client_invite_token || uuidv4();
    await dbRun('UPDATE projects SET client_invite_token=?, client_email=? WHERE id=?', [token, clientEmail, projectId]);

    const baseUrl = process.env.APP_BASE_URL || 'http://localhost:3001';
    await sendClientInvitation({
      to: clientEmail,
      clientName: clientName || 'Client',
      projectName: project.name,
      orgName: 'WorkTrack',
      inviteUrl: `${baseUrl}/client-portal?token=${token}`,
      inviteToken: token,
    });

    res.json({ success: true, portalUrl: `${baseUrl}/client-portal?token=${token}` });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── POST /api/clients/accept ──────────────────────────────────────────────────
// Client accepts an invitation from inside the desktop app: sets a password,
// which provisions (or updates) their CLIENT user account and links them to
// every project invited under their email. Returns auth tokens so the app can
// log them straight in.
router.post('/accept', async (req, res) => {
  try {
    const { token, password, name } = req.body;
    if (!token || !password) return res.status(400).json({ error: 'token and password are required' });
    if (String(password).length < 6) return res.status(400).json({ error: 'Password must be at least 6 characters' });

    const project = await dbGet('SELECT * FROM projects WHERE client_invite_token=?', [token]);
    if (!project) return res.status(404).json({ error: 'Invalid or expired invitation' });
    if (!project.client_email) return res.status(400).json({ error: 'Invitation has no client email' });

    const email = project.client_email.toLowerCase();
    const passwordHash = await bcrypt.hash(password, 12);

    let user = await dbGet('SELECT * FROM users WHERE LOWER(email)=?', [email]);
    if (user && user.role !== 'CLIENT') {
      return res.status(409).json({ error: 'This email is already registered to a staff account' });
    }

    if (!user) {
      const userId = uuidv4();
      await dbRun(
        `INSERT INTO users (id, organization_id, name, email, password_hash, role, status)
         VALUES (?, ?, ?, ?, ?, 'CLIENT', 'ACTIVE')`,
        [userId, project.organization_id, name || project.client_name || 'Client', email, passwordHash]
      );
      user = await dbGet('SELECT * FROM users WHERE id=?', [userId]);
    } else {
      await dbRun('UPDATE users SET password_hash=?, status=? WHERE id=?', [passwordHash, 'ACTIVE', user.id]);
    }

    // Link the client to every project invited under this email (same org).
    const invitedProjects = await dbAll(
      'SELECT id FROM projects WHERE LOWER(client_email)=? AND organization_id=?',
      [email, project.organization_id]
    );
    for (const p of invitedProjects) {
      await dbRun(
        'INSERT INTO project_members (project_id, user_id, role) VALUES (?, ?, ?) ON CONFLICT (project_id, user_id) DO NOTHING',
        [p.id, user.id, 'client']
      );
    }
    await dbRun('UPDATE projects SET client_invite_accepted=1 WHERE client_invite_token=?', [token]);

    const org = await dbGet('SELECT * FROM organizations WHERE id=?', [project.organization_id]);
    const accessToken = generateAccessToken(user);
    const refreshToken = await generateRefreshToken(user.id);

    res.json({
      tokens: { accessToken, refreshToken, expiresAt: Date.now() + 86400000 },
      user: { id: user.id, name: user.name, email: user.email, role: user.role, organizationId: user.organization_id },
      organization: org ? { id: org.id, name: org.name, plan: 'professional' } : null,
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── GET /api/clients/projects ─────────────────────────────────────────────────
// The logged-in CLIENT's invited projects, with progress + task rollup.
router.get('/projects', requireAuth, async (req, res) => {
  try {
    if (req.user.role !== 'CLIENT') return res.status(403).json({ error: 'Client access required' });
    const projects = await dbAll(
      `SELECT p.*, o.name as org_name,
        (SELECT COUNT(*) FROM tasks t WHERE t.project_id=p.id) as task_count,
        (SELECT COUNT(*) FROM tasks t WHERE t.project_id=p.id AND t.status='DONE') as completed_count
       FROM project_members pm
       JOIN projects p ON p.id = pm.project_id
       JOIN organizations o ON o.id = p.organization_id
       WHERE pm.user_id=? AND pm.role='client'
       ORDER BY p.created_at DESC`,
      [req.user.id]
    );
    const enriched = projects.map(p => ({
      ...p,
      progress_percent: p.task_count > 0 ? Math.round((p.completed_count / p.task_count) * 100) : 0,
    }));
    res.json(enriched);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
