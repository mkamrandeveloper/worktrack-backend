/**
 * Email Service — WorkTrack Enterprise
 *
 * Requires the following .env variables to activate:
 *   SMTP_HOST=smtp.gmail.com
 *   SMTP_PORT=587
 *   SMTP_USER=your@email.com
 *   SMTP_PASS=your-app-password
 *   SMTP_FROM=WorkTrack <no-reply@worktrack.io>
 *   APP_BASE_URL=http://localhost:3001
 */

const nodemailer = require('nodemailer');

let transporter = null;

function getTransporter() {
  if (transporter) return transporter;

  if (!process.env.SMTP_HOST || !process.env.SMTP_USER || !process.env.SMTP_PASS) {
    console.warn('[EmailService] SMTP not configured — emails will not be sent');
    return null;
  }

  transporter = nodemailer.createTransport({
    host: process.env.SMTP_HOST,
    port: parseInt(process.env.SMTP_PORT || '587'),
    secure: process.env.SMTP_PORT === '465',
    auth: {
      user: process.env.SMTP_USER,
      pass: process.env.SMTP_PASS,
    },
  });

  return transporter;
}

/**
 * Send a generic email.
 * Returns true if sent, false if SMTP not configured.
 */
async function sendEmail({ to, subject, html }) {
  const t = getTransporter();
  if (!t) return false;

  try {
    await t.sendMail({
      from: process.env.SMTP_FROM || 'WorkTrack <no-reply@worktrack.io>',
      to,
      subject,
      html,
    });
    console.log(`[EmailService] Email sent to ${to}: ${subject}`);
    return true;
  } catch (err) {
    console.error('[EmailService] Failed to send email:', err.message);
    return false;
  }
}

/**
 * Send employee credential email when manager adds a new employee.
 */
async function sendEmployeeCredentials({ to, name, orgName, email, password, loginUrl }) {
  return sendEmail({
    to,
    subject: `Welcome to ${orgName} — Your WorkTrack Credentials`,
    html: `
      <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto;">
        <div style="background: #7c3aed; padding: 32px; border-radius: 12px 12px 0 0;">
          <h1 style="color: white; margin: 0; font-size: 24px;">Welcome to WorkTrack</h1>
        </div>
        <div style="background: #f9fafb; padding: 32px; border-radius: 0 0 12px 12px; border: 1px solid #e5e7eb;">
          <p style="color: #374151; font-size: 16px;">Hi <strong>${name}</strong>,</p>
          <p style="color: #6b7280;">You have been added to <strong>${orgName}</strong> on WorkTrack. Use the credentials below to sign in.</p>
          
          <div style="background: white; border: 1px solid #e5e7eb; border-radius: 8px; padding: 20px; margin: 24px 0;">
            <p style="margin: 0 0 8px 0; color: #374151;"><strong>Email:</strong> ${email}</p>
            <p style="margin: 0; color: #374151;"><strong>Password:</strong> ${password}</p>
          </div>
          
          <p style="color: #ef4444; font-size: 14px;">⚠️ Please change your password after your first login.</p>
          
          <a href="${loginUrl || '#'}" style="display: inline-block; background: #7c3aed; color: white; padding: 12px 24px; border-radius: 8px; text-decoration: none; font-weight: 600; margin-top: 16px;">
            Open WorkTrack Desktop
          </a>
          
          <p style="color: #9ca3af; font-size: 12px; margin-top: 24px;">This email was sent by WorkTrack. If you did not expect this, please contact your manager.</p>
        </div>
      </div>
    `,
  });
}

/**
 * Send client portal invitation email.
 */
async function sendClientInvitation({ to, clientName, projectName, orgName, inviteUrl, inviteToken }) {
  return sendEmail({
    to,
    subject: `You've been invited to view the "${projectName}" project`,
    html: `
      <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto;">
        <div style="background: #0ea5e9; padding: 32px; border-radius: 12px 12px 0 0;">
          <h1 style="color: white; margin: 0; font-size: 24px;">Project Invitation</h1>
        </div>
        <div style="background: #f9fafb; padding: 32px; border-radius: 0 0 12px 12px; border: 1px solid #e5e7eb;">
          <p style="color: #374151; font-size: 16px;">Hi <strong>${clientName}</strong>,</p>
          <p style="color: #6b7280;"><strong>${orgName}</strong> has invited you to follow the progress of <strong>${projectName}</strong> on WorkTrack.</p>

          <p style="color: #374151; margin-top: 24px;"><strong>To access your project:</strong></p>
          <ol style="color: #6b7280; line-height: 1.7;">
            <li>Open the <strong>WorkTrack Desktop</strong> app and choose <strong>“Accept a client invitation.”</strong></li>
            <li>Enter the invitation code below and set your password.</li>
            <li>Sign in any time with your email (<strong>${to}</strong>) and that password.</li>
          </ol>

          ${inviteToken ? `
          <div style="background: white; border: 1px dashed #0ea5e9; border-radius: 8px; padding: 16px; margin: 20px 0; text-align: center;">
            <div style="font-size: 12px; color: #6b7280; text-transform: uppercase; letter-spacing: 0.05em;">Invitation Code</div>
            <div style="font-size: 18px; font-weight: 700; color: #0369a1; font-family: monospace; word-break: break-all; margin-top: 6px;">${inviteToken}</div>
          </div>` : ''}

          <p style="color: #6b7280; margin-top: 8px;">Prefer a quick web preview? <a href="${inviteUrl}" style="color: #0ea5e9;">Open the read-only project portal →</a></p>

          <p style="color: #9ca3af; font-size: 12px; margin-top: 32px;">This invitation is unique to you. Do not share the code with others.</p>
        </div>
      </div>
    `,
  });
}

module.exports = { sendEmail, sendEmployeeCredentials, sendClientInvitation };
