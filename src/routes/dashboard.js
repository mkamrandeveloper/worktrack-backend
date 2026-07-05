const express = require('express');
const { dbGet, dbAll } = require('../database');
const { requireAuth } = require('../middleware/auth');

const router = express.Router();
router.use(requireAuth);

router.get('/me', async (req, res) => {
  try {
    const orgId = req.user.organization_id;
    const userId = req.user.id;
    const { period } = req.query; // 'daily', 'weekly', 'monthly'

    const now = new Date();
    let dateFrom = new Date(now);
    
    if (period === 'monthly') {
      dateFrom.setDate(now.getDate() - 30);
    } else if (period === 'weekly') {
      dateFrom.setDate(now.getDate() - 7);
    } else {
      dateFrom = new Date(now); // daily (today)
    }
    
    const strDateFrom = dateFrom.toISOString().split('T')[0];
    const strDateTo = now.toISOString().split('T')[0];

    // Fetch aggregate attendance stats for the period
    const attendanceStats = await dbGet(
      `SELECT
        SUM(total_work_seconds) as total_work_seconds,
        SUM(total_break_seconds) as total_break_seconds,
        SUM(total_overtime_seconds) as total_overtime_seconds,
        SUM(total_idle_seconds) as total_idle_seconds
       FROM attendance
       WHERE user_id=? AND organization_id=? AND date BETWEEN ? AND ?`,
      [userId, orgId, strDateFrom, strDateTo]
    );

    // Fetch today's clock-in / clock-out
    const todayRec = await dbGet(
      `SELECT clock_in_time, clock_out_time, status as attendance_status 
       FROM attendance 
       WHERE user_id=? AND organization_id=? AND date=?`,
      [userId, orgId, strDateTo]
    );

    // Real-time status
    const liveStatusRec = await dbGet(
      `SELECT status, timestamp FROM activity_heartbeats WHERE user_id=? ORDER BY timestamp DESC LIMIT 1`,
      [userId]
    );

    // Fetch active timer session
    const activeSession = await dbGet(
      `SELECT t.title as current_task 
       FROM sessions s JOIN tasks t ON t.id=s.task_id 
       WHERE s.user_id=? AND s.status='running' LIMIT 1`,
      [userId]
    );

    // Historical chart data (group by date)
    const history = await dbAll(
      `SELECT date, total_work_seconds, total_break_seconds, total_overtime_seconds
       FROM attendance
       WHERE user_id=? AND organization_id=? AND date BETWEEN ? AND ?
       ORDER BY date ASC`,
      [userId, orgId, strDateFrom, strDateTo]
    );

    // Real-time status logic
    const lastSeen = liveStatusRec?.timestamp ? new Date(liveStatusRec.timestamp).getTime() : 0;
    const secondsAgo = (Date.now() - lastSeen) / 1000;

    let realTimeStatus = 'offline';
    if (activeSession) {
      realTimeStatus = 'working';
    } else if (secondsAgo < 120 && liveStatusRec) {
      realTimeStatus = liveStatusRec.status || 'active'; // could be 'break' if custom mapped
    } else if (todayRec?.clock_out_time) {
      realTimeStatus = 'clocked_out';
    }

    const chartData = history.map(h => ({
      date: h.date,
      workHours: h.total_work_seconds ? Math.round(h.total_work_seconds / 36) / 100 : 0,
      breakHours: h.total_break_seconds ? Math.round(h.total_break_seconds / 36) / 100 : 0,
      overtimeHours: h.total_overtime_seconds ? Math.round(h.total_overtime_seconds / 36) / 100 : 0,
    }));

    const workSecs = attendanceStats?.total_work_seconds || 0;
    const breakSecs = attendanceStats?.total_break_seconds || 0;
    const otSecs = attendanceStats?.total_overtime_seconds || 0;
    const idleSecs = attendanceStats?.total_idle_seconds || 0;

    // Productivity heuristic: bounded between 0 and 100
    let productivityScore = 0;
    if (workSecs > 0) {
        productivityScore = Math.round(((workSecs - breakSecs) / workSecs) * 100);
        if (productivityScore < 0) productivityScore = 0;
        if (productivityScore > 100) productivityScore = 100;
    }

    res.json({
      period,
      totalWorkingHours: Math.round(workSecs / 36) / 100,
      totalBreakHours: Math.round(breakSecs / 36) / 100,
      totalOvertimeHours: Math.round(otSecs / 36) / 100,
      totalIdleHours: Math.round(idleSecs / 36) / 100,
      clockInTime: todayRec?.clock_in_time || null,
      clockOutTime: todayRec?.clock_out_time || null,
      attendanceStatus: todayRec?.attendance_status || 'absent',
      realTimeStatus,
      currentTask: activeSession?.current_task || null,
      productivityScore,
      chartData
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
