'use strict';

const { query } = require('./db');
const { ensureResearchStage2Table } = require('./schema');

/**
 * @param {function} getPool
 * @param {number} userId
 * @param {string} projectType
 * @param {object[]} corpus
 * @param {object} statistics
 */
async function saveStage2Corpus(getPool, userId, projectType, corpus, statistics) {
  await ensureResearchStage2Table(getPool);
  await query(
    getPool,
    `INSERT INTO research_stage2_corpus (user_id, project_type, corpus_json, statistics_json)
     VALUES (@uid, @pt, @c, @s)`,
    {
      uid: userId,
      pt: String(projectType || 'dissertation').slice(0, 32),
      c: JSON.stringify(corpus),
      s: JSON.stringify(statistics),
    }
  );
}

/**
 * @returns {Promise<{ corpus: object[], statistics: object, project_type: string, created_at: Date|string } | null>}
 */
async function getLatestStage2Corpus(getPool, userId) {
  await ensureResearchStage2Table(getPool);
  const r = await query(
    getPool,
    `SELECT corpus_json, statistics_json, project_type, created_at
     FROM research_stage2_corpus
     WHERE user_id = @uid
     ORDER BY created_at DESC
     LIMIT 1`,
    { uid: userId }
  );
  const row = r.recordset && r.recordset[0];
  if (!row) return null;
  let corpus;
  let statistics;
  try {
    corpus = JSON.parse(String(row.corpus_json || '[]'));
    statistics = JSON.parse(String(row.statistics_json || '{}'));
  } catch (e) {
    return null;
  }
  return {
    corpus,
    statistics,
    project_type: row.project_type,
    created_at: row.created_at,
  };
}

module.exports = {
  saveStage2Corpus,
  getLatestStage2Corpus,
};
