'use strict';

const { query } = require('./db');
const { ensureResearchStage1Tables } = require('./schema');

/**
 * @param {function} getPool
 * @param {number} userId
 * @param {number} durationMs
 */
async function recordStage1BedrockRun(getPool, userId, durationMs) {
  await ensureResearchStage1Tables(getPool);
  await query(
    getPool,
    `INSERT INTO research_stage1_bedrock_runs (user_id, duration_ms) VALUES (@uid, @ms)`,
    { uid: userId, ms: Math.max(0, Math.round(Number(durationMs)) || 0) }
  );
}

/**
 * @param {function} getPool
 * @param {number} userId
 * @param {number} [limit]
 * @returns {Promise<{ id: number, duration_ms: number, created_at: Date|string }[]>}
 */
async function listStage1BedrockRuns(getPool, userId, limit = 500) {
  await ensureResearchStage1Tables(getPool);
  const lim = Math.min(2000, Math.max(1, Math.round(Number(limit)) || 500));
  const r = await query(
    getPool,
    `SELECT id, duration_ms, created_at
     FROM research_stage1_bedrock_runs
     WHERE user_id = @uid
     ORDER BY created_at DESC
     LIMIT ${lim}`,
    { uid: userId }
  );
  return r.recordset || [];
}

/**
 * Persist finalized Stage 1 plan for downstream Stage 2.
 * @param {function} getPool
 * @param {number} userId
 * @param {object} plan
 */
async function saveStage1FinalPlan(getPool, userId, plan) {
  await ensureResearchStage1Tables(getPool);
  const json = JSON.stringify(plan);
  await query(
    getPool,
    `INSERT INTO research_stage1_final_plans (user_id, plan_json) VALUES (@uid, @j)`,
    { uid: userId, j: json }
  );
}

async function getLatestStage1FinalPlan(getPool, userId) {
  await ensureResearchStage1Tables(getPool);
  const r = await query(
    getPool,
    `SELECT plan_json FROM research_stage1_final_plans WHERE user_id = @uid ORDER BY created_at DESC LIMIT 1`,
    { uid: userId }
  );
  return (r.recordset && r.recordset[0]) || null;
}

module.exports = {
  recordStage1BedrockRun,
  listStage1BedrockRuns,
  saveStage1FinalPlan,
  getLatestStage1FinalPlan,
};
