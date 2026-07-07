const express = require('express');
const { v4: uuidv4 } = require('uuid');
const { dbGet, dbRun, dbAll } = require('../database');
const { requireAuth, requireManagerOrAbove, requireAdminOrAbove, canViewOthers } = require('../middleware/auth');
const { sendClientInvitation } = require('../services/emailService');
const { createNotification } = require('./notifications');
const { emitToUser } = require('../socket');
const { TASK_SELECT_FIELDS } = require('../utils/taskSelect');

const router = express.Router();
router.use(requireAuth);

// ── GET /api/projects ─────────────────────────────────────────────────────────
router.get('/', async (req, res) => {
  try {
    const orgId = req.user.organization_id;
    const userId = req.user.id;
    const role = req.user.role;

    let projects;
    if (['OWNER', 'ADMIN', 'MANAGER'].includes(role)) {
      projects = await dbAll(
        `SELECT p.*,
          u.name as manager_name,
          (SELECT COUNT(*) FROM project_members pm WHERE pm.project_id = p.id) as member_count,
          (SELECT COUNT(*) FROM tasks t WHERE t.project_id = p.id) as task_count
         FROM projects p
         LEFT JOIN users u ON u.id = p.manager_id
         WHERE p.organization_id = ?
         ORDER BY p.created_at DESC`,
        [orgId]
      );
    } else {
      // Employees see only their projects
      projects = await dbAll(
        `SELECT p.*,
          u.name as manager_name,
          (SELECT COUNT(*) FROM project_members pm2 WHERE pm2.project_id = p.id) as member_count,
          (SELECT COUNT(*) FROM tasks t WHERE t.project_id = p.id) as task_count
         FROM projects p
         LEFT JOIN users u ON u.id = p.manager_id
         INNER JOIN project_members pm ON pm.project_id = p.id AND pm.user_id = ?
         WHERE p.organization_id = ?
         ORDER BY p.created_at DESC`,
        [userId, orgId]
      );
    }
    res.json(projects);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── GET /api/projects/:id ─────────────────────────────────────────────────────
router.get('/:id', async (req, res) => {
  try {
    const project = await dbGet(
      'SELECT p.*, u.name as manager_name FROM projects p LEFT JOIN users u ON u.id = p.manager_id WHERE p.id=? AND p.organization_id=?',
      [req.params.id, req.user.organization_id]
    );
    if (!project) return res.status(404).json({ error: 'Project not found' });

    // Employees and clients may only read projects they belong to.
    if (!canViewOthers(req.user.role)) {
      const member = await dbGet(
        'SELECT 1 FROM project_members WHERE project_id=? AND user_id=?',
        [req.params.id, req.user.id]
      );
      if (!member) return res.status(403).json({ error: 'Not a member of this project' });
    }

    const members = await dbAll(
      `SELECT u.id, u.name, u.email, u.role, u.status, pm.role as project_role
       FROM project_members pm
       JOIN users u ON u.id = pm.user_id
       WHERE pm.project_id = ?`,
      [req.params.id]
    );

    const tasks = await dbAll(
      `SELECT t.*, u.name as assignee_name FROM tasks t
       LEFT JOIN users u ON u.id = t.assignee_id
       WHERE t.project_id = ? AND t.organization_id = ?
       ORDER BY t.created_at DESC`,
      [req.params.id, req.user.organization_id]
    );

    res.json({ ...project, members, tasks });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── POST /api/projects ────────────────────────────────────────────────────────
router.post('/', requireManagerOrAbove, async (req, res) => {
  try {
    const {
      name, description, clientName, clientEmail, companyName,
      budget, priority, status, startDate, deadline,
      estimatedHours, departmentId, notes, memberIds
    } = req.body;

    if (!name) return res.status(400).json({ error: 'Project name is required' });

    const id = uuidv4();
    const inviteToken = clientEmail ? uuidv4() : null;

    await dbRun(
      `INSERT INTO projects (
        id, organization_id, name, description, client_name, client_email, company_name,
        budget, priority, status, start_date, deadline, estimated_hours, manager_id,
        department_id, client_invite_token, notes
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        id, req.user.organization_id, name, description || null,
        clientName || null, clientEmail || null, companyName || null,
        budget || 0, priority || 'MEDIUM', status || 'ACTIVE',
        startDate || null, deadline || null, estimatedHours || 0,
        req.user.id, departmentId || null, inviteToken, notes || null
      ]
    );

    // Add project members
    if (memberIds && Array.isArray(memberIds)) {
      for (const uid of memberIds) {
        await dbRun(
          'INSERT INTO project_members (project_id, user_id) VALUES (?, ?) ON CONFLICT (project_id, user_id) DO NOTHING',
          [id, uid]
        );
      }
    }
    // Always add the manager as a member
    await dbRun(
      'INSERT INTO project_members (project_id, user_id, role) VALUES (?, ?, ?) ON CONFLICT (project_id, user_id) DO NOTHING',
      [id, req.user.id, 'manager']
    );

    // Send client invitation if email provided. Fire-and-forget: SMTP (especially
    // Gmail from a cloud IP) can stall well past the client's request timeout,
    // which would otherwise block project creation from ever completing its
    // response even though the project row is already committed.
    if (clientEmail && inviteToken) {
      const org = await dbGet('SELECT name FROM organizations WHERE id=?', [req.user.organization_id]);
      const baseUrl = process.env.APP_BASE_URL || 'http://localhost:3001';
      sendClientInvitation({
        to: clientEmail,
        clientName: clientName || 'Client',
        projectName: name,
        orgName: org?.name || 'WorkTrack',
        inviteUrl: `${baseUrl}/client-portal?token=${inviteToken}`,
        inviteToken,
      }).catch((err) => console.warn('Client invitation email failed:', err.message));
    }

    const project = await dbGet('SELECT * FROM projects WHERE id = ?', [id]);
    res.status(201).json(project);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── PATCH /api/projects/:id ───────────────────────────────────────────────────
router.patch('/:id', requireManagerOrAbove, async (req, res) => {
  try {
    const {
      name, description, status, priority, budget, deadline,
      estimatedHours, actualHours, clientName, clientEmail, notes
    } = req.body;

    await dbRun(
      `UPDATE projects SET
        name=COALESCE(?,name), description=COALESCE(?,description),
        status=COALESCE(?,status), priority=COALESCE(?,priority),
        budget=COALESCE(?,budget), deadline=COALESCE(?,deadline),
        estimated_hours=COALESCE(?,estimated_hours), actual_hours=COALESCE(?,actual_hours),
        client_name=COALESCE(?,client_name), client_email=COALESCE(?,client_email),
        notes=COALESCE(?,notes), updated_at=CURRENT_TIMESTAMP
       WHERE id=? AND organization_id=?`,
      [
        name||null, description||null, status||null, priority||null,
        budget??null, deadline||null, estimatedHours??null, actualHours??null,
        clientName||null, clientEmail||null, notes||null,
        req.params.id, req.user.organization_id
      ]
    );
    const project = await dbGet('SELECT * FROM projects WHERE id = ?', [req.params.id]);
    res.json(project);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── DELETE /api/projects/:id ──────────────────────────────────────────────────
router.delete('/:id', requireAdminOrAbove, async (req, res) => {
  try {
    await dbRun(
      'DELETE FROM projects WHERE id=? AND organization_id=?',
      [req.params.id, req.user.organization_id]
    );
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── POST /api/projects/:id/members ────────────────────────────────────────────
router.post('/:id/members', requireManagerOrAbove, async (req, res) => {
  try {
    const project = await dbGet('SELECT id FROM projects WHERE id=? AND organization_id=?', [req.params.id, req.user.organization_id]);
    if (!project) return res.status(404).json({ error: 'Project not found' });

    const { userId, role } = req.body;
    await dbRun(
      'INSERT INTO project_members (project_id, user_id, role) VALUES (?, ?, ?) ON CONFLICT (project_id, user_id) DO NOTHING',
      [req.params.id, userId, role || 'member']
    );
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── DELETE /api/projects/:id/members/:userId ──────────────────────────────────
router.delete('/:id/members/:userId', requireManagerOrAbove, async (req, res) => {
  try {
    const project = await dbGet('SELECT id FROM projects WHERE id=? AND organization_id=?', [req.params.id, req.user.organization_id]);
    if (!project) return res.status(404).json({ error: 'Project not found' });

    await dbRun(
      'DELETE FROM project_members WHERE project_id=? AND user_id=?',
      [req.params.id, req.params.userId]
    );
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── GET /api/projects/:id/tasks ───────────────────────────────────────────────
// Tasks belonging to a project. Managers+ see all; members see their project's.
router.get('/:id/tasks', async (req, res) => {
  try {
    const orgId = req.user.organization_id;
    const project = await dbGet('SELECT id FROM projects WHERE id=? AND organization_id=?', [req.params.id, orgId]);
    if (!project) return res.status(404).json({ error: 'Project not found' });

    if (!canViewOthers(req.user.role)) {
      const member = await dbGet('SELECT 1 FROM project_members WHERE project_id=? AND user_id=?', [req.params.id, req.user.id]);
      if (!member) return res.status(403).json({ error: 'Not a member of this project' });
    }

    const tasks = await dbAll(
      `SELECT ${TASK_SELECT_FIELDS} FROM tasks t
       LEFT JOIN users u ON u.id = t.assignee_id
       WHERE t.project_id=? AND t.organization_id=? ORDER BY t.created_at DESC`,
      [req.params.id, orgId]
    );
    res.json(tasks);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── POST /api/projects/:id/tasks ──────────────────────────────────────────────
// Create a task inside a project (the merged Task module lives here now).
router.post('/:id/tasks', requireManagerOrAbove, async (req, res) => {
  try {
    const orgId = req.user.organization_id;
    const project = await dbGet('SELECT id, name FROM projects WHERE id=? AND organization_id=?', [req.params.id, orgId]);
    if (!project) return res.status(404).json({ error: 'Project not found' });

    const { title, description, assigneeId, estimatedHours, priority, deadline } = req.body;
    if (!title) return res.status(400).json({ error: 'Task title is required' });

    const id = uuidv4();
    await dbRun(
      `INSERT INTO tasks (id, organization_id, project_id, project_name, assignee_id, created_by, title, description, status, priority, estimated_hours, deadline)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'TODO', ?, ?, ?)`,
      [id, orgId, project.id, project.name, assigneeId || null, req.user.id, title, description || '', priority || 'MEDIUM', estimatedHours || 1, deadline || null]
    );
    // Ensure the assignee is a project member so scoping lets them see it.
    if (assigneeId) {
      await dbRun('INSERT INTO project_members (project_id, user_id) VALUES (?, ?) ON CONFLICT (project_id, user_id) DO NOTHING', [project.id, assigneeId]);
    }

    const task = await dbGet(
      `SELECT ${TASK_SELECT_FIELDS} FROM tasks t LEFT JOIN users u ON u.id=t.assignee_id WHERE t.id=?`,
      [id]
    );

    if (assigneeId) {
      createNotification(
        assigneeId, orgId, 'task_assigned', 'New Task Assigned',
        `You've been assigned "${title}" in ${project.name}.`, { taskId: id, projectId: project.id }
      ).catch((err) => console.warn('Notification create failed:', err.message));
      emitToUser(assigneeId, 'task:assigned', { task });
    }

    res.status(201).json(task);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── PATCH /api/projects/:id/tasks/:taskId ─────────────────────────────────────
// Managers+ may edit any field; an assignee may update the status of their task.
router.patch('/:id/tasks/:taskId', async (req, res) => {
  try {
    const orgId = req.user.organization_id;
    const task = await dbGet('SELECT * FROM tasks WHERE id=? AND project_id=? AND organization_id=?', [req.params.taskId, req.params.id, orgId]);
    if (!task) return res.status(404).json({ error: 'Task not found' });

    const isManager = canViewOthers(req.user.role);
    if (!isManager && task.assignee_id !== req.user.id) {
      return res.status(403).json({ error: 'You can only update tasks assigned to you' });
    }

    const { title, description, status, priority, estimatedHours, deadline, assigneeId } = req.body;
    if (isManager) {
      await dbRun(
        `UPDATE tasks SET
          title=COALESCE(?,title), description=COALESCE(?,description),
          status=COALESCE(?,status), priority=COALESCE(?,priority),
          estimated_hours=COALESCE(?,estimated_hours), deadline=COALESCE(?,deadline),
          assignee_id=COALESCE(?,assignee_id), updated_at=CURRENT_TIMESTAMP
         WHERE id=?`,
        [title || null, description || null, status || null, priority || null, estimatedHours ?? null, deadline || null, assigneeId || null, req.params.taskId]
      );
      if (assigneeId) {
        await dbRun('INSERT INTO project_members (project_id, user_id) VALUES (?, ?) ON CONFLICT (project_id, user_id) DO NOTHING', [req.params.id, assigneeId]);
      }
    } else {
      // Assignee may only move the status.
      await dbRun('UPDATE tasks SET status=COALESCE(?,status), updated_at=CURRENT_TIMESTAMP WHERE id=?', [status || null, req.params.taskId]);
    }

    const updated = await dbGet(
      `SELECT ${TASK_SELECT_FIELDS} FROM tasks t LEFT JOIN users u ON u.id=t.assignee_id WHERE t.id=?`,
      [req.params.taskId]
    );

    if (assigneeId && assigneeId !== task.assignee_id) {
      createNotification(
        assigneeId, orgId, 'task_assigned', 'Task Assigned To You',
        `You've been assigned "${updated.title}".`, { taskId: updated.id, projectId: req.params.id }
      ).catch((err) => console.warn('Notification create failed:', err.message));
      emitToUser(assigneeId, 'task:assigned', { task: updated });
    }

    res.json(updated);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
