const { google } = require('googleapis');
const { dbGet, dbRun, dbAll } = require('../database');
require('dotenv').config();

function getOAuthClient() {
  return new google.auth.OAuth2(
    process.env.GOOGLE_CLIENT_ID,
    process.env.GOOGLE_CLIENT_SECRET,
    process.env.GOOGLE_REDIRECT_URI
  );
}

function isDriveConfigured() {
  return !!process.env.GOOGLE_DEFAULT_REFRESH_TOKEN;
}

// Every organization shares one Google Drive account (authorized once via
// GOOGLE_DEFAULT_REFRESH_TOKEN) — orgs are separated by folder structure
// (WorkTrack/<Org Name>/<Employee Name>), not by separate Drive connections.
// The googleapis client auto-refreshes the access token from the refresh
// token on demand, so there's nothing else to manage here.
function getDriveClient() {
  if (!isDriveConfigured()) {
    throw new Error('Drive is not configured on this server (missing GOOGLE_DEFAULT_REFRESH_TOKEN)');
  }
  const auth = getOAuthClient();
  auth.setCredentials({ refresh_token: process.env.GOOGLE_DEFAULT_REFRESH_TOKEN });
  return google.drive({ version: 'v3', auth });
}

// Generate the OAuth consent URL — only needed to rotate the shared
// account's refresh token if it's ever revoked (owner-only maintenance).
function getAuthUrl() {
  const client = getOAuthClient();
  return client.generateAuthUrl({
    access_type: 'offline',
    prompt: 'consent',
    scope: [
      'https://www.googleapis.com/auth/drive.file',
      'https://www.googleapis.com/auth/drive.metadata.readonly'
    ]
  });
}

// Exchange a fresh auth code for a new refresh token. This does not persist
// anything — rotating the shared account requires updating the
// GOOGLE_DEFAULT_REFRESH_TOKEN secret and restarting the server.
async function exchangeAuthCode(code) {
  const client = getOAuthClient();
  const { tokens } = await client.getToken(code);
  return tokens;
}

// Ensure folder exists (by name under parent), create if missing
async function ensureFolder(drive, name, parentId = null) {
  const query = parentId
    ? `mimeType='application/vnd.google-apps.folder' and name='${name}' and '${parentId}' in parents and trashed=false`
    : `mimeType='application/vnd.google-apps.folder' and name='${name}' and trashed=false`;
  
  const res = await drive.files.list({ q: query, fields: 'files(id, webViewLink)', spaces: 'drive' });
  if (res.data.files.length > 0) {
    return res.data.files[0];
  }
  
  const meta = { name, mimeType: 'application/vnd.google-apps.folder' };
  if (parentId) meta.parents = [parentId];
  const created = await drive.files.create({ resource: meta, fields: 'id, webViewLink' });
  return created.data;
}

// Setup Drive folder structure: WorkTrack > OrgName > EmployeeName
async function setupOrgFolders(organizationId) {
  const drive = getDriveClient();
  const org = await dbGet('SELECT * FROM organizations WHERE id = ?', [organizationId]);
  if (!org) throw new Error('Organization not found');

  // Root WorkTrack folder
  const rootFolder = await ensureFolder(drive, 'WorkTrack');

  // Org folder under WorkTrack
  const orgFolder = await ensureFolder(drive, org.name, rootFolder.id);

  // Save org folder info
  await dbRun(
    'UPDATE organizations SET drive_folder_id=?, drive_folder_url=? WHERE id=?',
    [orgFolder.id, orgFolder.webViewLink, organizationId]
  );

  // Create subfolder for each active employee
  const employees = await dbAll(
    `SELECT * FROM users WHERE organization_id=? AND role='EMPLOYEE' AND status='ACTIVE'`,
    [organizationId]
  );

  for (const emp of employees) {
    if (!emp.drive_folder_id) {
      const empFolder = await ensureFolder(drive, emp.name, orgFolder.id);
      await dbRun(
        'UPDATE users SET drive_folder_id=?, drive_folder_url=? WHERE id=?',
        [empFolder.id, empFolder.webViewLink, emp.id]
      );
    }
  }

  return { orgFolderUrl: orgFolder.webViewLink };
}

// Setup folder for a single employee (called when approved)
async function setupEmployeeFolder(userId) {
  const user = await dbGet('SELECT * FROM users WHERE id = ?', [userId]);
  if (!user) throw new Error('User not found');
  if (!isDriveConfigured()) return; // Drive not configured on this server, skip

  const drive = getDriveClient();
  const org = await dbGet('SELECT * FROM organizations WHERE id = ?', [user.organization_id]);

  // Ensure root and org folders exist
  const rootFolder = await ensureFolder(drive, 'WorkTrack');
  const orgFolder = await ensureFolder(drive, org.name, rootFolder.id);

  // Create employee folder
  const empFolder = await ensureFolder(drive, user.name, orgFolder.id);
  await dbRun(
    'UPDATE users SET drive_folder_id=?, drive_folder_url=? WHERE id=?',
    [empFolder.id, empFolder.webViewLink, userId]
  );

  return empFolder;
}

// Upload a screenshot buffer to the employee's Drive folder
async function uploadScreenshot(userId, imageBuffer, filename) {
  const user = await dbGet('SELECT * FROM users WHERE id = ?', [userId]);
  if (!user) throw new Error('User not found');

  const drive = getDriveClient();

  // Ensure employee folder
  let folderId = user.drive_folder_id;
  if (!folderId) {
    const folder = await setupEmployeeFolder(userId);
    folderId = folder?.id;
  }

  const { Readable } = require('stream');
  const stream = new Readable();
  stream.push(imageBuffer);
  stream.push(null);

  const res = await drive.files.create({
    resource: {
      name: filename,
      parents: folderId ? [folderId] : undefined,
    },
    media: { mimeType: 'image/jpeg', body: stream },
    fields: 'id, webViewLink',
  });

  return { fileId: res.data.id, fileUrl: res.data.webViewLink };
}

// Stream a screenshot's raw image bytes from Drive (used by the image-proxy
// route so the app never needs to make Drive files publicly shareable —
// access is gated by our own RBAC, not Drive's sharing settings).
async function downloadScreenshot(driveFileId) {
  const drive = getDriveClient();
  const res = await drive.files.get(
    { fileId: driveFileId, alt: 'media' },
    { responseType: 'stream' }
  );
  return res.data; // readable stream
}

module.exports = {
  isDriveConfigured,
  getAuthUrl,
  exchangeAuthCode,
  setupOrgFolders,
  setupEmployeeFolder,
  uploadScreenshot,
  downloadScreenshot,
};
