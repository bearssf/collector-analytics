'use strict';

const crypto = require('crypto');
const bcrypt = require('bcryptjs');
const { query, queryRaw } = require('./db');

const TOKEN_BYTES = 32;
const EXPIRY_HOURS = 1;

async function ensurePasswordResetSchema(getPool) {
  await queryRaw(
    getPool,
    `CREATE TABLE IF NOT EXISTS password_reset_tokens (
      id INT AUTO_INCREMENT PRIMARY KEY,
      user_id INT NOT NULL,
      token_hash CHAR(64) NOT NULL,
      expires_at DATETIME(6) NOT NULL,
      used_at DATETIME(6) NULL,
      created_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
      UNIQUE KEY uq_prt_hash (token_hash),
      INDEX ix_prt_user (user_id),
      INDEX ix_prt_expires (expires_at),
      CONSTRAINT fk_prt_user FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`
  );
}

function hashToken(raw) {
  return crypto.createHash('sha256').update(String(raw).trim(), 'utf8').digest('hex');
}

/**
 * @param {function} getPool
 * @param {number} userId
 */
async function deletePendingTokensForUser(getPool, userId) {
  await query(
    getPool,
    `DELETE FROM password_reset_tokens WHERE user_id = @uid AND used_at IS NULL`,
    { uid: userId }
  );
}

/**
 * @param {function} getPool
 * @param {number} userId
 * @returns {Promise<{ rawToken: string, expiresAt: Date }>}
 */
async function createPasswordResetToken(getPool, userId) {
  const rawToken = crypto.randomBytes(TOKEN_BYTES).toString('hex');
  const tokenHash = hashToken(rawToken);
  const expiresAt = new Date(Date.now() + EXPIRY_HOURS * 60 * 60 * 1000);
  await deletePendingTokensForUser(getPool, userId);
  await query(
    getPool,
    `INSERT INTO password_reset_tokens (user_id, token_hash, expires_at) VALUES (@uid, @th, @exp)`,
    { uid: userId, th: tokenHash, exp: expiresAt }
  );
  return { rawToken, expiresAt };
}

/**
 * @param {function} getPool
 * @param {string} email
 * @returns {Promise<number | null>}
 */
async function findUserIdByEmail(getPool, email) {
  const em = String(email || '')
    .trim()
    .toLowerCase();
  if (!em) return null;
  const r = await query(getPool, `SELECT id FROM users WHERE email = @email LIMIT 1`, { email: em });
  return r.recordset && r.recordset[0] ? Number(r.recordset[0].id) : null;
}

/**
 * @param {function} getPool
 * @param {string} rawToken
 * @returns {Promise<{ id: number, userId: number } | null>}
 */
async function findValidTokenRow(getPool, rawToken) {
  if (!rawToken || String(rawToken).length < 16) return null;
  const th = hashToken(rawToken);
  const r = await query(
    getPool,
    `SELECT id, user_id FROM password_reset_tokens
     WHERE token_hash = @th AND used_at IS NULL AND expires_at > CURRENT_TIMESTAMP(6) LIMIT 1`,
    { th }
  );
  const row = r.recordset && r.recordset[0];
  if (!row) return null;
  return { id: row.id, userId: Number(row.user_id) };
}

/**
 * @param {function} getPool
 * @param {string} rawToken
 * @param {string} newPassword
 */
async function resetPasswordWithToken(getPool, rawToken, newPassword) {
  const pw = String(newPassword || '');
  if (pw.length < 8) return { ok: false, error: 'Password must be at least 8 characters.' };

  const row = await findValidTokenRow(getPool, rawToken);
  if (!row) return { ok: false, error: 'This reset link is invalid or has expired. Request a new one.' };

  const passwordHash = await bcrypt.hash(pw, 10);
  await query(getPool, `UPDATE users SET password_hash = @ph WHERE id = @id`, {
    ph: passwordHash,
    id: row.userId,
  });
  await query(getPool, `UPDATE password_reset_tokens SET used_at = CURRENT_TIMESTAMP(6) WHERE id = @tid`, {
    tid: row.id,
  });
  await deletePendingTokensForUser(getPool, row.userId);
  return { ok: true };
}

module.exports = {
  ensurePasswordResetSchema,
  createPasswordResetToken,
  findUserIdByEmail,
  findValidTokenRow,
  resetPasswordWithToken,
  EXPIRY_HOURS,
};
