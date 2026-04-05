const { query } = require('./db');

/**
 * Aggregate Research Anatomy metrics for admin dashboard.
 */
async function getResearchAnatomyAdminStats(getPool) {
  const r = await query(
    getPool,
    `SELECT
       COUNT(*) AS total_runs,
       SUM(CASE WHEN status = 'complete' THEN 1 ELSE 0 END) AS completed_runs,
       SUM(CASE WHEN status = 'failed' THEN 1 ELSE 0 END) AS failed_runs,
       SUM(CASE WHEN status = 'processing' THEN 1 ELSE 0 END) AS processing_runs,
       AVG(
         CASE
           WHEN status = 'complete'
             AND review_requested_at IS NOT NULL
             AND review_completed_at IS NOT NULL
           THEN TIMESTAMPDIFF(MICROSECOND, review_requested_at, review_completed_at) / 1000
         END
       ) AS avg_duration_ms,
       SUM(CASE WHEN status = 'complete' AND word_count IS NOT NULL THEN word_count ELSE 0 END) AS total_words_reviewed,
       AVG(CASE WHEN status = 'complete' AND word_count IS NOT NULL THEN word_count END) AS avg_words_per_run
     FROM research_anatomy_runs`,
    {}
  );
  const row = r.recordset[0] || {};
  return {
    totalRuns: Number(row.total_runs) || 0,
    completedRuns: Number(row.completed_runs) || 0,
    failedRuns: Number(row.failed_runs) || 0,
    processingRuns: Number(row.processing_runs) || 0,
    avgDurationMs: row.avg_duration_ms != null ? Number(row.avg_duration_ms) : null,
    totalWordsReviewed: Number(row.total_words_reviewed) || 0,
    avgWordsPerRun: row.avg_words_per_run != null ? Number(row.avg_words_per_run) : null,
  };
}

module.exports = { getResearchAnatomyAdminStats };
