/**
 * MySQL DDL — idempotent creates for AcademiqForge core model.
 */
const { queryRaw } = require('./db');

async function addColumnIgnoreDup(getPool, table, colName, colDef) {
  try {
    await queryRaw(getPool, 'ALTER TABLE `' + table + '` ADD COLUMN `' + colName + '` ' + colDef);
  } catch (e) {
    // mysql2 uses ER_DUP_FIELDNAME; some docs use ER_DUP_FIELD_NAME. MySQL errno 1060 = duplicate column.
    const dup =
      e.errno === 1060 ||
      e.code === 'ER_DUP_FIELDNAME' ||
      e.code === 'ER_DUP_FIELD_NAME';
    if (!dup) throw e;
  }
}

async function ensureCoreSchema(getPool) {
  await queryRaw(
    getPool,
    `CREATE TABLE IF NOT EXISTS subscriptions (
      id INT AUTO_INCREMENT PRIMARY KEY,
      user_id INT NOT NULL UNIQUE,
      stripe_customer_id VARCHAR(255) NULL,
      stripe_subscription_id VARCHAR(255) NULL,
      \`plan\` VARCHAR(20) NULL,
      status VARCHAR(40) NOT NULL DEFAULT 'trialing',
      trial_end DATETIME(6) NULL,
      current_period_end DATETIME(6) NULL,
      cancel_at_period_end TINYINT(1) NOT NULL DEFAULT 0,
      created_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
      updated_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6) ON UPDATE CURRENT_TIMESTAMP(6),
      CONSTRAINT fk_subscriptions_user FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`
  );

  await queryRaw(
    getPool,
    `CREATE TABLE IF NOT EXISTS projects (
      id INT AUTO_INCREMENT PRIMARY KEY,
      user_id INT NOT NULL,
      name VARCHAR(255) NOT NULL,
      purpose VARCHAR(80) NOT NULL,
      purpose_other VARCHAR(500) NULL,
      citation_style VARCHAR(40) NOT NULL,
      template_key VARCHAR(80) NOT NULL,
      status VARCHAR(40) NOT NULL DEFAULT 'draft',
      started_at DATETIME(6) NULL,
      completed_at DATETIME(6) NULL,
      publishing_title VARCHAR(500) NULL,
      publishing_submitted_at DATETIME(6) NULL,
      publishing_venue VARCHAR(500) NULL,
      publishing_disposition VARCHAR(80) NULL,
      publishing_published_at DATETIME(6) NULL,
      created_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
      updated_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6) ON UPDATE CURRENT_TIMESTAMP(6),
      CONSTRAINT fk_projects_user FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
      INDEX ix_projects_user (user_id),
      INDEX ix_projects_status (user_id, status)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`
  );

  await queryRaw(
    getPool,
    `CREATE TABLE IF NOT EXISTS project_sections (
      id INT AUTO_INCREMENT PRIMARY KEY,
      project_id INT NOT NULL,
      sort_order INT NOT NULL,
      title VARCHAR(255) NOT NULL,
      slug VARCHAR(80) NULL,
      status VARCHAR(40) NOT NULL DEFAULT 'not_started',
      progress_percent TINYINT UNSIGNED NOT NULL DEFAULT 0,
      body LONGTEXT NULL,
      draft_revision INT NOT NULL DEFAULT 0,
      created_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
      updated_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6) ON UPDATE CURRENT_TIMESTAMP(6),
      CONSTRAINT fk_project_sections_project FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE,
      INDEX ix_sections_project (project_id, sort_order)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`
  );

  await queryRaw(
    getPool,
    `CREATE TABLE IF NOT EXISTS sources (
      id INT AUTO_INCREMENT PRIMARY KEY,
      project_id INT NOT NULL,
      citation_text LONGTEXT NOT NULL,
      notes LONGTEXT NULL,
      doi VARCHAR(500) NULL,
      authors LONGTEXT NULL,
      publication_date VARCHAR(100) NULL,
      article_title VARCHAR(500) NULL,
      journal_title VARCHAR(500) NULL,
      volume_number VARCHAR(50) NULL,
      issue_number VARCHAR(50) NULL,
      page_numbers VARCHAR(100) NULL,
      chapter_name VARCHAR(500) NULL,
      conference_name VARCHAR(500) NULL,
      source_type VARCHAR(40) NULL,
      publisher VARCHAR(500) NULL,
      publisher_location VARCHAR(500) NULL,
      editors LONGTEXT NULL,
      book_title VARCHAR(500) NULL,
      url VARCHAR(1000) NULL,
      edition VARCHAR(100) NULL,
      access_date VARCHAR(100) NULL,
      open_access_url VARCHAR(1000) NULL,
      from_suggestion TINYINT(1) NULL DEFAULT 0,
      crucible_notes LONGTEXT NULL,
      sort_order INT NOT NULL DEFAULT 0,
      created_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
      updated_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6) ON UPDATE CURRENT_TIMESTAMP(6),
      CONSTRAINT fk_sources_project FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE,
      INDEX ix_sources_project (project_id)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`
  );

  await queryRaw(
    getPool,
    `CREATE TABLE IF NOT EXISTS source_sections (
      source_id INT NOT NULL,
      section_id INT NOT NULL,
      PRIMARY KEY (source_id, section_id),
      CONSTRAINT fk_ss_source FOREIGN KEY (source_id) REFERENCES sources(id) ON DELETE CASCADE,
      CONSTRAINT fk_ss_section FOREIGN KEY (section_id) REFERENCES project_sections(id)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`
  );

  await queryRaw(
    getPool,
    `CREATE TABLE IF NOT EXISTS source_tags (
      source_id INT NOT NULL,
      tag VARCHAR(120) NOT NULL,
      PRIMARY KEY (source_id, tag),
      CONSTRAINT fk_source_tags_source FOREIGN KEY (source_id) REFERENCES sources(id) ON DELETE CASCADE,
      INDEX ix_source_tags_tag (tag)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`
  );

  await queryRaw(
    getPool,
    `CREATE TABLE IF NOT EXISTS anvil_suggestions (
      id INT AUTO_INCREMENT PRIMARY KEY,
      project_id INT NOT NULL,
      section_id INT NOT NULL,
      category VARCHAR(20) NOT NULL,
      body LONGTEXT NOT NULL,
      suggestion_status VARCHAR(20) NOT NULL DEFAULT 'open',
      anchor_json VARCHAR(500) NULL,
      draft_revision_at_generation INT NULL,
      created_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
      updated_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6) ON UPDATE CURRENT_TIMESTAMP(6),
      CONSTRAINT fk_anvil_suggestions_project FOREIGN KEY (project_id) REFERENCES projects(id),
      CONSTRAINT fk_anvil_suggestions_section FOREIGN KEY (section_id) REFERENCES project_sections(id) ON DELETE CASCADE,
      INDEX ix_anvil_suggestions_section (section_id),
      INDEX ix_anvil_suggestions_project_section (project_id, section_id)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`
  );

  await queryRaw(
    getPool,
    `CREATE TABLE IF NOT EXISTS research_plan_items (
      id INT AUTO_INCREMENT PRIMARY KEY,
      project_id INT NOT NULL,
      suggestion_id INT NULL,
      section_id INT NOT NULL,
      section_title VARCHAR(255) NULL,
      suggestion_body LONGTEXT NOT NULL,
      passage_excerpt LONGTEXT NULL,
      keywords VARCHAR(500) NULL,
      research_needed VARCHAR(500) NULL,
      status VARCHAR(40) NULL,
      created_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
      updated_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6) ON UPDATE CURRENT_TIMESTAMP(6),
      CONSTRAINT fk_research_plan_project FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE,
      CONSTRAINT fk_research_plan_section FOREIGN KEY (section_id) REFERENCES project_sections(id),
      INDEX ix_research_plan_project (project_id, created_at DESC),
      INDEX ix_research_plan_suggestion (suggestion_id),
      UNIQUE INDEX ux_research_plan_project_suggestion (project_id, suggestion_id)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`
  );

  try {
    await queryRaw(
      getPool,
      'ALTER TABLE research_plan_items DROP FOREIGN KEY fk_research_plan_suggestion'
    );
  } catch {
    /* optional legacy FK */
  }

  await queryRaw(
    getPool,
    `UPDATE research_plan_items SET status = 'unresolved' WHERE status IS NULL`
  );

  await queryRaw(
    getPool,
    `DELETE FROM research_plan_items
     WHERE project_id = 8
       AND section_title = 'Introduction'
       AND suggestion_body LIKE '%critical thinking is impactful to intercultural%'`
  );

  await queryRaw(
    getPool,
    `CREATE TABLE IF NOT EXISTS citation_usages (
      id INT AUTO_INCREMENT PRIMARY KEY,
      source_id INT NOT NULL,
      section_id INT NOT NULL,
      project_id INT NOT NULL,
      cite_marker VARCHAR(500) NULL,
      context_excerpt LONGTEXT NULL,
      created_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
      CONSTRAINT fk_cu_source FOREIGN KEY (source_id) REFERENCES sources(id) ON DELETE CASCADE,
      CONSTRAINT fk_cu_section FOREIGN KEY (section_id) REFERENCES project_sections(id),
      INDEX ix_cu_project (project_id),
      INDEX ix_cu_source (source_id)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`
  );

  await queryRaw(
    getPool,
    `CREATE TABLE IF NOT EXISTS anvil_feedback (
      id INT AUTO_INCREMENT PRIMARY KEY,
      project_id INT NOT NULL,
      section_id INT NOT NULL,
      fb_id VARCHAR(100) NOT NULL,
      category VARCHAR(50) NOT NULL,
      anchor_text LONGTEXT NOT NULL,
      context_before VARCHAR(500) NULL,
      context_after VARCHAR(500) NULL,
      suggestion LONGTEXT NULL,
      rationale LONGTEXT NULL,
      is_actionable TINYINT(1) NOT NULL DEFAULT 0,
      status VARCHAR(20) NOT NULL DEFAULT 'active',
      anchor_word_count INT NOT NULL DEFAULT 0,
      created_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
      updated_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6) ON UPDATE CURRENT_TIMESTAMP(6),
      CONSTRAINT fk_af_project FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE,
      CONSTRAINT fk_af_section FOREIGN KEY (section_id) REFERENCES project_sections(id),
      INDEX ix_af_project_section (project_id, section_id)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`
  );

  await addColumnIgnoreDup(getPool, 'subscriptions', 'cancel_at_period_end', 'TINYINT(1) NOT NULL DEFAULT 0');
  await addColumnIgnoreDup(getPool, 'projects', 'purpose_other', 'VARCHAR(500) NULL');
  await addColumnIgnoreDup(getPool, 'project_sections', 'body', 'LONGTEXT NULL');
  await addColumnIgnoreDup(getPool, 'sources', 'doi', 'VARCHAR(500) NULL');
  await addColumnIgnoreDup(getPool, 'sources', 'crucible_notes', 'LONGTEXT NULL');
  const sourceColumns = [
    ['authors', 'LONGTEXT NULL'],
    ['publication_date', 'VARCHAR(100) NULL'],
    ['article_title', 'VARCHAR(500) NULL'],
    ['journal_title', 'VARCHAR(500) NULL'],
    ['volume_number', 'VARCHAR(50) NULL'],
    ['issue_number', 'VARCHAR(50) NULL'],
    ['page_numbers', 'VARCHAR(100) NULL'],
    ['chapter_name', 'VARCHAR(500) NULL'],
    ['conference_name', 'VARCHAR(500) NULL'],
    ['source_type', 'VARCHAR(40) NULL'],
    ['publisher', 'VARCHAR(500) NULL'],
    ['publisher_location', 'VARCHAR(500) NULL'],
    ['editors', 'LONGTEXT NULL'],
    ['book_title', 'VARCHAR(500) NULL'],
    ['url', 'VARCHAR(1000) NULL'],
    ['edition', 'VARCHAR(100) NULL'],
    ['access_date', 'VARCHAR(100) NULL'],
    ['open_access_url', 'VARCHAR(1000) NULL'],
    ['from_suggestion', 'TINYINT(1) NULL DEFAULT 0'],
  ];
  for (const [name, def] of sourceColumns) {
    await addColumnIgnoreDup(getPool, 'sources', name, def);
  }
  await addColumnIgnoreDup(getPool, 'research_plan_items', 'research_needed', 'VARCHAR(500) NULL');
  await addColumnIgnoreDup(getPool, 'research_plan_items', 'status', 'VARCHAR(40) NULL');

  await queryRaw(
    getPool,
    `CREATE TABLE IF NOT EXISTS user_research_ideas (
      id INT AUTO_INCREMENT PRIMARY KEY,
      user_id INT NOT NULL,
      research_topic VARCHAR(500) NOT NULL,
      keywords VARCHAR(500) NULL,
      notes LONGTEXT NULL,
      created_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
      CONSTRAINT fk_uri_user FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
      INDEX ix_uri_user (user_id, created_at DESC)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`
  );
  await queryRaw(
    getPool,
    `CREATE TABLE IF NOT EXISTS user_published_work (
      id INT AUTO_INCREMENT PRIMARY KEY,
      user_id INT NOT NULL,
      title VARCHAR(500) NOT NULL,
      date_published VARCHAR(100) NULL,
      where_published VARCHAR(500) NULL,
      link VARCHAR(1000) NULL,
      created_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
      CONSTRAINT fk_upw_user FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
      INDEX ix_upw_user (user_id, created_at DESC)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`
  );
  await addColumnIgnoreDup(getPool, 'project_sections', 'draft_revision', 'INT NOT NULL DEFAULT 0');
  await addColumnIgnoreDup(
    getPool,
    'project_sections',
    'structured_review_at',
    'DATETIME(6) NULL'
  );
  await queryRaw(
    getPool,
    `UPDATE project_sections ps
     INNER JOIN (
       SELECT section_id, MIN(created_at) AS first_at
       FROM anvil_feedback
       GROUP BY section_id
     ) f ON f.section_id = ps.id
     SET ps.structured_review_at = f.first_at
     WHERE ps.structured_review_at IS NULL`
  );
  await addColumnIgnoreDup(getPool, 'anvil_suggestions', 'draft_revision_at_generation', 'INT NULL');
  await queryRaw(
    getPool,
    `UPDATE anvil_suggestions SET draft_revision_at_generation = 0 WHERE draft_revision_at_generation IS NULL`
  );

  await queryRaw(
    getPool,
    `CREATE TABLE IF NOT EXISTS research_anatomy_runs (
      id BIGINT AUTO_INCREMENT PRIMARY KEY,
      user_id INT NOT NULL,
      project_id INT NOT NULL,
      s3_key VARCHAR(512) NULL,
      content_version VARCHAR(128) NULL,
      status VARCHAR(32) NOT NULL DEFAULT 'pending',
      results_json LONGTEXT NULL,
      error_message TEXT NULL,
      cooldown_until DATETIME(6) NULL,
      created_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
      updated_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6) ON UPDATE CURRENT_TIMESTAMP(6),
      CONSTRAINT fk_ra_runs_user FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
      CONSTRAINT fk_ra_runs_project FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE,
      INDEX ix_ra_runs_project_created (project_id, created_at DESC),
      INDEX ix_ra_runs_user (user_id)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`
  );

  await addColumnIgnoreDup(getPool, 'research_anatomy_runs', 'review_requested_at', 'DATETIME(6) NULL');
  await addColumnIgnoreDup(getPool, 'research_anatomy_runs', 'review_completed_at', 'DATETIME(6) NULL');
  await addColumnIgnoreDup(getPool, 'research_anatomy_runs', 'word_count', 'INT UNSIGNED NULL');

  await queryRaw(
    getPool,
    `CREATE TABLE IF NOT EXISTS project_templates_store (
      id TINYINT UNSIGNED NOT NULL PRIMARY KEY,
      json_body LONGTEXT NOT NULL,
      updated_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6) ON UPDATE CURRENT_TIMESTAMP(6)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`
  );

  await queryRaw(
    getPool,
    `CREATE TABLE IF NOT EXISTS research_stage1_bedrock_runs (
      id BIGINT AUTO_INCREMENT PRIMARY KEY,
      user_id INT NOT NULL,
      duration_ms INT NOT NULL,
      created_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
      CONSTRAINT fk_rs1br_user FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
      INDEX ix_rs1br_user_created (user_id, created_at DESC)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`
  );

  await queryRaw(
    getPool,
    `CREATE TABLE IF NOT EXISTS research_stage1_final_plans (
      id BIGINT AUTO_INCREMENT PRIMARY KEY,
      user_id INT NOT NULL,
      plan_json LONGTEXT NOT NULL,
      created_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
      CONSTRAINT fk_rs1fp_user FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
      INDEX ix_rs1fp_user_created (user_id, created_at DESC)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`
  );

  await queryRaw(
    getPool,
    `CREATE TABLE IF NOT EXISTS registration_pending (
      id BIGINT AUTO_INCREMENT PRIMARY KEY,
      email VARCHAR(255) NOT NULL,
      code_hash CHAR(64) NOT NULL,
      password_hash VARCHAR(255) NOT NULL,
      form_json LONGTEXT NOT NULL,
      preferred_locale VARCHAR(32) NOT NULL,
      expires_at DATETIME(6) NOT NULL,
      code_sent_at DATETIME(6) NOT NULL,
      created_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
      UNIQUE KEY uq_registration_pending_email (email),
      INDEX ix_registration_pending_expires (expires_at)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`
  );
}

module.exports = { ensureCoreSchema };
