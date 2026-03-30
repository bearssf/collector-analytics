'use strict';

const { EXPIRY_HOURS } = require('./passwordReset');

let nodemailer;
try {
  nodemailer = require('nodemailer');
} catch {
  nodemailer = null;
}

function isMailConfigured() {
  return !!(process.env.SMTP_HOST && process.env.MAIL_FROM);
}

/**
 * @param {{ to: string, subject: string, text: string, html: string }} opts
 * @returns {Promise<{ ok: boolean, skipped?: boolean, error?: string }>}
 */
async function sendMail(opts) {
  if (!nodemailer) {
    return { ok: false, skipped: true, error: 'nodemailer not installed' };
  }
  if (!isMailConfigured()) {
    return { ok: false, skipped: true, error: 'SMTP not configured' };
  }
  const port = parseInt(process.env.SMTP_PORT || '587', 10);
  const secure =
    process.env.SMTP_SECURE === '1' ||
    process.env.SMTP_SECURE === 'true' ||
    port === 465;
  const transporter = nodemailer.createTransport({
    host: process.env.SMTP_HOST,
    port,
    secure,
    auth:
      process.env.SMTP_USER || process.env.SMTP_PASS
        ? {
            user: process.env.SMTP_USER || '',
            pass: process.env.SMTP_PASS || '',
          }
        : undefined,
  });
  const from = String(process.env.MAIL_FROM || process.env.SMTP_USER || '').trim();
  await transporter.sendMail({
    from,
    to: opts.to,
    subject: opts.subject,
    text: opts.text,
    html: opts.html,
  });
  return { ok: true };
}

/**
 * @param {{ to: string, resetUrl: string }} opts
 */
async function sendPasswordResetEmail(opts) {
  const appName = 'AcademiqForge';
  const subject = `Reset your ${appName} password`;
  const text = [
    `We received a request to reset your ${appName} password.`,
    '',
    `Open this link within ${EXPIRY_HOURS} hour(s) (it expires after that):`,
    '',
    opts.resetUrl,
    '',
    `If you did not request this, you can ignore this email.`,
  ].join('\n');
  const html = `<p>We received a request to reset your <strong>${appName}</strong> password.</p>
<p><a href="${opts.resetUrl}">Reset your password</a></p>
<p style="color:#666;font-size:13px;">If the button does not work, paste this URL into your browser:<br>${opts.resetUrl}</p>
<p style="color:#666;font-size:13px;">If you did not request this, you can ignore this email.</p>`;
  return sendMail({ to: opts.to, subject, text, html });
}

module.exports = {
  isMailConfigured,
  sendMail,
  sendPasswordResetEmail,
};
