const crypto = require('crypto');
const { query } = require('./db');
const { getProjectBundle } = require('./projectService');
const { isBedrockConfigured } = require('./bedrockReview');
const {
  versionIdFromBundle,
  buildSectionAwareDocument,
  runResearchAnatomyEvaluation,
  countWords,
  MIN_REVIEW_WORDS,
} = require('./researchAnatomyPipeline');
const { getObjectText, expectedKeyPrefix, isS3Configured } = require('./researchAnatomyS3');

const COOLDOWN_DAYS = 7;

function randomSuffix() {
  return `${Date.now()}-${crypto.randomBytes(8).toString('hex')}.txt`;
}

async function getLatestRun(getPool, projectId, userId) {
  const r = await query(
    getPool,
    `SELECT id, status, results_json, error_message, cooldown_until, s3_key, content_version, created_at, updated_at
     FROM research_anatomy_runs
     WHERE project_id = @pid AND user_id = @uid
     ORDER BY id DESC
     LIMIT 1`,
    { pid: projectId, uid: userId }
  );
  return r.recordset[0] || null;
}

async function getLatestCompleteRun(getPool, projectId, userId) {
  const r = await query(
    getPool,
    `SELECT id, status, results_json, error_message, cooldown_until, created_at, updated_at
     FROM research_anatomy_runs
     WHERE project_id = @pid AND user_id = @uid AND status = 'complete'
     ORDER BY id DESC
     LIMIT 1`,
    { pid: projectId, uid: userId }
  );
  return r.recordset[0] || null;
}

async function hasCompletedReview(getPool, projectId, userId) {
  const r = await query(
    getPool,
    `SELECT COUNT(*) AS n FROM research_anatomy_runs
     WHERE project_id = @pid AND user_id = @uid AND status = 'complete'`,
    { pid: projectId, uid: userId }
  );
  return ((r.recordset[0] && r.recordset[0].n) || 0) > 0;
}

async function isCooldownActive(getPool, projectId, userId) {
  const r = await query(
    getPool,
    `SELECT cooldown_until FROM research_anatomy_runs
     WHERE project_id = @pid AND user_id = @uid AND status = 'complete'
       AND cooldown_until IS NOT NULL
     ORDER BY id DESC
     LIMIT 1`,
    { pid: projectId, uid: userId }
  );
  const row = r.recordset[0];
  if (!row || !row.cooldown_until) return { active: false, until: null };
  const until = new Date(row.cooldown_until);
  return { active: until > new Date(), until };
}

function parseResultsJson(row) {
  if (!row || !row.results_json) return null;
  try {
    return JSON.parse(row.results_json);
  } catch {
    return null;
  }
}

async function insertRun(getPool, { userId, projectId, s3Key, contentVersion, status }) {
  const ins = await query(
    getPool,
    `INSERT INTO research_anatomy_runs (user_id, project_id, s3_key, content_version, status, review_requested_at)
     VALUES (@uid, @pid, @s3, @ver, @st, NOW(6))`,
    {
      uid: userId,
      pid: projectId,
      s3: s3Key || null,
      ver: contentVersion || null,
      st: status || 'processing',
    }
  );
  const id = ins.insertId != null ? Number(ins.insertId) : null;
  return id;
}

async function updateRunComplete(getPool, runId, resultsObj, wordCount) {
  const json = JSON.stringify(resultsObj);
  const wc = wordCount != null && Number.isFinite(Number(wordCount)) ? Math.max(0, Math.floor(Number(wordCount))) : null;
  await query(
    getPool,
    `UPDATE research_anatomy_runs
     SET status = 'complete',
         results_json = @rj,
         error_message = NULL,
         cooldown_until = DATE_ADD(NOW(6), INTERVAL ${COOLDOWN_DAYS} DAY),
         review_completed_at = NOW(6),
         word_count = @wc,
         updated_at = NOW(6)
     WHERE id = @id`,
    { id: runId, rj: json, wc }
  );
}

async function updateRunFailed(getPool, runId, message) {
  await query(
    getPool,
    `UPDATE research_anatomy_runs
     SET status = 'failed',
         error_message = @msg,
         updated_at = NOW(6)
     WHERE id = @id`,
    { id: runId, msg: String(message || 'error').slice(0, 2000) }
  );
}

function validateS3KeyForUser(key, userId, projectId) {
  const prefix = expectedKeyPrefix({ userId, projectId });
  const k = String(key || '');
  return k.startsWith(prefix) && k.length < 512 && !/\.\./.test(k);
}

/**
 * Background processing: load text from S3 or bundle, run evaluation, persist.
 */
async function processResearchAnatomyRun(getPool, runId, userId, projectId, opts) {
  const { textFromS3Key, bundle } = opts;
  let fullText = '';

  try {
    if (textFromS3Key && isS3Configured()) {
      fullText = await getObjectText(textFromS3Key);
    }
    if (!fullText.trim() && bundle) {
      fullText = buildSectionAwareDocument(bundle);
    }
    if (!fullText.trim()) {
      throw new Error('No document text available for review.');
    }

    const evaluation = await runResearchAnatomyEvaluation(fullText);
    const wc = countWords(fullText);
    await updateRunComplete(getPool, runId, evaluation, wc);
  } catch (e) {
    await updateRunFailed(getPool, runId, e.message || String(e));
  }
}

function scheduleProcessResearchAnatomyRun(getPool, runId, userId, projectId, opts) {
  setImmediate(() => {
    processResearchAnatomyRun(getPool, runId, userId, projectId, opts).catch((err) => {
      console.error('research_anatomy run', runId, err);
    });
  });
}

/**
 * Start a new run after optional S3 upload: creates DB row and schedules pipeline.
 */
async function startResearchAnatomyReview(getPool, userId, projectId, s3Key) {
  const bundle = await getProjectBundle(getPool, projectId, userId);
  if (!bundle) return { ok: false, status: 404, error: 'not_found' };

  const assembled = buildSectionAwareDocument(bundle);
  const wc = countWords(assembled);
  if (wc < MIN_REVIEW_WORDS) {
    return { ok: false, status: 400, error: 'insufficient_words', wordCount: wc };
  }

  if (!isBedrockConfigured()) {
    return { ok: false, status: 503, error: 'bedrock_not_configured' };
  }

  const cd = await isCooldownActive(getPool, projectId, userId);
  if (cd.active) {
    return { ok: false, status: 429, error: 'cooldown', cooldownUntil: cd.until };
  }

  const version = versionIdFromBundle(bundle);
  const pending = await query(
    getPool,
    `SELECT id FROM research_anatomy_runs
     WHERE project_id = @pid AND user_id = @uid AND status = 'processing'
     ORDER BY id DESC LIMIT 1`,
    { pid: projectId, uid: userId }
  );
  if (pending.recordset[0]) {
    return {
      ok: true,
      runId: pending.recordset[0].id,
      status: 'processing',
      deduped: true,
    };
  }

  const runId = await insertRun(getPool, {
    userId,
    projectId,
    s3Key: s3Key || null,
    contentVersion: version,
    status: 'processing',
  });

  scheduleProcessResearchAnatomyRun(getPool, runId, userId, projectId, {
    textFromS3Key: s3Key || null,
    bundle,
  });

  return { ok: true, runId, status: 'processing', contentVersion: version };
}

module.exports = {
  getLatestRun,
  getLatestCompleteRun,
  hasCompletedReview,
  isCooldownActive,
  parseResultsJson,
  insertRun,
  updateRunComplete,
  updateRunFailed,
  validateS3KeyForUser,
  processResearchAnatomyRun,
  scheduleProcessResearchAnatomyRun,
  startResearchAnatomyReview,
  randomSuffix,
  COOLDOWN_DAYS,
  MIN_REVIEW_WORDS,
};
