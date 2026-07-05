// Postgres lowercases unquoted identifiers and returns snake_case columns
// as-is, but the desktop app's shared Task type is camelCase throughout.
// Every query that returns a task the frontend consumes directly should
// select through this fragment (requires the tasks table aliased as `t`,
// and a `LEFT JOIN users u ON u.id = t.assignee_id` for assigneeName).
const TASK_SELECT_FIELDS = `
  t.*,
  t.assignee_id as "assigneeId",
  t.estimated_hours as "estimatedHours",
  t.logged_hours as "loggedHours",
  t.project_id as "projectId",
  t.project_name as "projectName",
  t.organization_id as "organizationId",
  t.created_by as "createdBy",
  t.custom_screenshot_interval as "customScreenshotInterval",
  u.name as "assigneeName",
  ROUND(GREATEST(0, t.estimated_hours - t.logged_hours)::numeric, 2) as "remainingHours",
  CASE WHEN t.estimated_hours > 0
    THEN LEAST(100, ROUND((t.logged_hours / t.estimated_hours * 100)::numeric))
    ELSE 0
  END as "progressPercent"
`;

module.exports = { TASK_SELECT_FIELDS };
