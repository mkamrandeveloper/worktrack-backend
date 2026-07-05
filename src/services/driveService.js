const { google } = require('googleapis');
const { dbGet, dbRun, dbAll } = require('../database');
const { v4: uuidv4 } = require('uuid');
require('dotenv').config();

function getOAuthClient() {
  return new google.auth.OAuth2(
    process.env.GOOGLE_CLIENT_ID,
    process.env.GOOGLE_CLIENT_SECRET,
    process.env.GOOGLE_REDIRECT_URI
  );
}

function getDriveClient(tokens) {
  const auth = getOAuthClient();
  auth.setCredentials(tokens);
  return google.drive({ version: 'v3', auth });
}

// Generate the OAuth URL for the manager to open
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

// Exchange auth code for tokens and save them
async function handleOAuthCallback(code, organizationId) {
  const client = getOAuthClient();
  const { tokens } = await client.getToken(code);
  
  const existing = await dbGet('SELECT id FROM drive_tokens WHERE organization_id = ?', [organizationId]);
  if (existing) {
    await dbRun(
      `UPDATE drive_tokens SET access_token=?, refresh_token=?, expiry_date=?, updated_at=CURRENT_TIMESTAMP WHERE organization_id=?`,
      [tokens.access_token, tokens.refresh_token, tokens.expiry_date, organizationId]
    );
  } else {
    await dbRun(
      `INSERT INTO drive_tokens (id, organization_id, access_token, refresh_token, expiry_date) VALUES (?,?,?,?,?)`,
      [uuidv4(), organizationId, tokens.access_token, tokens.refresh_token, tokens.expiry_date]
    );
  }
  return tokens;
}

async function getTokensForOrg(organizationId) {
  const row = await dbGet('SELECT * FROM drive_tokens WHERE organization_id = ?', [organizationId]);
  if (!row) return null;

  // Auto-refresh if expired
  const client = getOAuthClient();
  client.setCredentials({
    access_token: row.access_token,
    refresh_token: row.refresh_token,
    expiry_date: row.expiry_date
  });

  // Refresh proactively if within 5 minutes of expiry
  if (row.expiry_date && Date.now() > row.expiry_date - 300000) {
    try {
      const { credentials } = await client.refreshAccessToken();
      await dbRun(
        `UPDATE drive_tokens SET access_token=?, expiry_date=?, updated_at=CURRENT_TIMESTAMP WHERE organization_id=?`,
        [credentials.access_token, credentials.expiry_date, organizationId]
      );
      return credentials;
    } catch (err) {
      console.error('Token refresh failed:', err.message);
    }
  }

  return { access_token: row.access_token, refresh_token: row.refresh_token, expiry_date: row.expiry_date };
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
  const tokens = await getTokensForOrg(organizationId);
  if (!tokens) throw new Error('Drive not connected for this organization');

  const drive = getDriveClient(tokens);
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

  const tokens = await getTokensForOrg(user.organization_id);
  if (!tokens) return; // Drive not connected yet, skip

  const drive = getDriveClient(tokens);
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

  const tokens = await getTokensForOrg(user.organization_id);
  if (!tokens) throw new Error('Drive not connected');

  const drive = getDriveClient(tokens);

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
    media: { mimeType: 'image/png', body: stream },
    fields: 'id, webViewLink',
  });

  return { fileId: res.data.id, fileUrl: res.data.webViewLink };
}

module.exports = {
  getAuthUrl,
  handleOAuthCallback,
  getTokensForOrg,
  setupOrgFolders,
  setupEmployeeFolder,
  uploadScreenshot,
};
