require('dotenv').config();
const express = require('express');
const cors = require('cors');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');

const { initSchema } = require('./src/database');
const authRoutes = require('./src/routes/auth');
const managerRoutes = require('./src/routes/manager');
const taskRoutes = require('./src/routes/tasks');
const screenshotRoutes = require('./src/routes/screenshots');
const driveRoutes = require('./src/routes/drive');
const activityRoutes = require('./src/routes/activity');
// ── Enterprise Routes ────────────────────────────────────────────────────────
const projectRoutes = require('./src/routes/projects');
const departmentRoutes = require('./src/routes/departments');
const timelogRoutes = require('./src/routes/timelogs');
const timesheetRoutes = require('./src/routes/timesheets');
const attendanceRoutes = require('./src/routes/attendance');
const notificationRoutes = require('./src/routes/notifications');
const reportRoutes = require('./src/routes/reports');
const clientRoutes = require('./src/routes/clients');

const { setIO } = require('./src/socket');

const app = express();
const httpServer = http.createServer(app);
const io = new Server(httpServer, {
  cors: { origin: '*', methods: ['GET', 'POST'] }
});
setIO(io);

// ── Middleware ─────────────────────────────────────────────────────────────────
app.use(cors());
app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ extended: true }));

// Request logger (production-friendly)
app.use((req, _res, next) => {
  console.log(`[${new Date().toISOString()}] ${req.method} ${req.path}`);
  next();
});

// ── Routes ─────────────────────────────────────────────────────────────────────
app.get('/', (_req, res) => res.json({ status: 'WorkTrack Production API', version: '1.0.0' }));
app.get('/health', (_req, res) => res.json({ status: 'ok', timestamp: new Date().toISOString() }));

app.use('/api/auth', authRoutes);
app.use('/api/manager', managerRoutes);
app.use('/api/tasks', taskRoutes);
app.use('/api/sessions', taskRoutes);
app.use('/api/screenshots', screenshotRoutes);
app.use('/api/drive', driveRoutes);
app.use('/api/activity', activityRoutes);
// ── Enterprise Routes ────────────────────────────────────────────────────────
app.use('/api/projects', projectRoutes);
app.use('/api/departments', departmentRoutes);
app.use('/api/timelogs', timelogRoutes);
app.use('/api/timesheets', timesheetRoutes);
app.use('/api/attendance', attendanceRoutes);
app.use('/api/notifications', notificationRoutes);
app.use('/api/reports', reportRoutes);
app.use('/api/clients', clientRoutes);
app.use('/api/dashboard', require('./src/routes/dashboard'));
app.use('/client-portal', clientRoutes); // Public portal page (no /api prefix)

// ── WebSocket ─────────────────────────────────────────────────────────────────
io.on('connection', (socket) => {
  console.log(`[WS] Client connected: ${socket.id}`);

  // Accepts either a plain userId string (legacy) or { userId, organizationId }.
  socket.on('join', (payload) => {
    const userId = typeof payload === 'string' ? payload : payload?.userId;
    const organizationId = typeof payload === 'object' ? payload?.organizationId : null;
    if (userId) socket.join(userId);
    if (organizationId) socket.join(`org:${organizationId}`);
    console.log(`[WS] joined rooms — user=${userId || '—'} org=${organizationId || '—'}`);
  });

  socket.on('timer:start', (data) => io.to(data.userId).emit('timer:start', data));
  socket.on('timer:stop', (data) => io.to(data.userId).emit('timer:stop', data));
  socket.on('timer:pause', (data) => io.to(data.userId).emit('timer:pause', data));
  socket.on('timer:resume', (data) => io.to(data.userId).emit('timer:resume', data));

  socket.on('disconnect', () => {
    console.log(`[WS] Client disconnected: ${socket.id}`);
  });
});

// ── Error handler ─────────────────────────────────────────────────────────────
app.use((err, req, res, _next) => {
  console.error('[Error]', err.message);
  res.status(500).json({ error: 'Internal server error' });
});

// ── Start ─────────────────────────────────────────────────────────────────────
const PORT = parseInt(process.env.PORT || '3001', 10);

async function start() {
  try {
    await initSchema();
    console.log('✅ Database schema initialized');

    httpServer.listen(PORT, () => {
      console.log(`\n🚀 WorkTrack Production Backend running on http://localhost:${PORT}`);
      console.log(`   Database: PostgreSQL (${(process.env.DATABASE_URL || 'local dev').replace(/:[^:@]+@/, ':****@')})`);
      console.log(`   Google Drive: ${process.env.GOOGLE_CLIENT_ID ? 'Configured ✅' : 'Not configured ❌'}`);
      console.log(`   Environment: ${process.env.NODE_ENV || 'development'}\n`);
    });
  } catch (err) {
    console.error('Failed to start server:', err);
    process.exit(1);
  }
}

start();

module.exports = { app, io };
