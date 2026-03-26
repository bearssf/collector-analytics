/**
 * SQL Server DDL — idempotent creates for AcademiqForge core model.
 */
async function ensureCoreSchema(getPool) {
  const p = await getPool();

  await p.request().query(`
    IF NOT EXISTS (SELECT * FROM sys.tables WHERE name = 'subscriptions')
    BEGIN
      CREATE TABLE subscriptions (
        id INT IDENTITY(1,1) PRIMARY KEY,
        user_id INT NOT NULL UNIQUE,
        stripe_customer_id NVARCHAR(255) NULL,
        stripe_subscription_id NVARCHAR(255) NULL,
        [plan] NVARCHAR(20) NULL,
        status NVARCHAR(40) NOT NULL CONSTRAINT df_sub_status DEFAULT ('trialing'),
        trial_end DATETIME2 NULL,
        current_period_end DATETIME2 NULL,
        created_at DATETIME2 NOT NULL CONSTRAINT df_sub_created DEFAULT (GETDATE()),
        updated_at DATETIME2 NOT NULL CONSTRAINT df_sub_updated DEFAULT (GETDATE()),
        CONSTRAINT fk_subscriptions_user FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
      );
      -- user_id is already indexed by the UNIQUE constraint; avoid a redundant second index on the same column
    END
  `);

  await p.request().query(`
    IF EXISTS (SELECT * FROM sys.tables WHERE name = 'subscriptions')
    AND NOT EXISTS (
      SELECT 1 FROM sys.columns
      WHERE object_id = OBJECT_ID('subscriptions') AND name = 'cancel_at_period_end'
    )
    ALTER TABLE subscriptions ADD cancel_at_period_end BIT NOT NULL
      CONSTRAINT DF_subscriptions_cancel_at_period_end DEFAULT (0);
  `);

  await p.request().query(`
    IF EXISTS (SELECT * FROM sys.tables WHERE name = 'projects')
    AND NOT EXISTS (
      SELECT 1 FROM sys.columns
      WHERE object_id = OBJECT_ID('projects') AND name = 'purpose_other'
    )
    ALTER TABLE projects ADD purpose_other NVARCHAR(500) NULL;
  `);

  await p.request().query(`
    IF NOT EXISTS (SELECT * FROM sys.tables WHERE name = 'projects')
    BEGIN
      CREATE TABLE projects (
        id INT IDENTITY(1,1) PRIMARY KEY,
        user_id INT NOT NULL,
        name NVARCHAR(255) NOT NULL,
        purpose NVARCHAR(80) NOT NULL,
        citation_style NVARCHAR(40) NOT NULL,
        template_key NVARCHAR(80) NOT NULL,
        status NVARCHAR(40) NOT NULL CONSTRAINT df_proj_status DEFAULT ('draft'),
        started_at DATETIME2 NULL,
        completed_at DATETIME2 NULL,
        publishing_title NVARCHAR(500) NULL,
        publishing_submitted_at DATETIME2 NULL,
        publishing_venue NVARCHAR(500) NULL,
        publishing_disposition NVARCHAR(80) NULL,
        publishing_published_at DATETIME2 NULL,
        created_at DATETIME2 NOT NULL CONSTRAINT df_proj_created DEFAULT (GETDATE()),
        updated_at DATETIME2 NOT NULL CONSTRAINT df_proj_updated DEFAULT (GETDATE()),
        CONSTRAINT fk_projects_user FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
      );
      CREATE INDEX ix_projects_user ON projects(user_id);
      CREATE INDEX ix_projects_status ON projects(user_id, status);
    END
  `);

  await p.request().query(`
    IF NOT EXISTS (SELECT * FROM sys.tables WHERE name = 'project_sections')
    BEGIN
      CREATE TABLE project_sections (
        id INT IDENTITY(1,1) PRIMARY KEY,
        project_id INT NOT NULL,
        sort_order INT NOT NULL,
        title NVARCHAR(255) NOT NULL,
        slug NVARCHAR(80) NULL,
        status NVARCHAR(40) NOT NULL CONSTRAINT df_sec_status DEFAULT ('not_started'),
        progress_percent TINYINT NOT NULL CONSTRAINT df_sec_prog DEFAULT (0),
        body NVARCHAR(MAX) NULL,
        created_at DATETIME2 NOT NULL CONSTRAINT df_sec_created DEFAULT (GETDATE()),
        updated_at DATETIME2 NOT NULL CONSTRAINT df_sec_updated DEFAULT (GETDATE()),
        CONSTRAINT fk_project_sections_project FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE
      );
      CREATE INDEX ix_sections_project ON project_sections(project_id, sort_order);
    END
  `);

  await p.request().query(`
    IF EXISTS (SELECT * FROM sys.tables WHERE name = 'project_sections')
    AND NOT EXISTS (
      SELECT 1 FROM sys.columns
      WHERE object_id = OBJECT_ID('project_sections') AND name = 'body'
    )
    ALTER TABLE project_sections ADD body NVARCHAR(MAX) NULL;
  `);

  await p.request().query(`
    IF NOT EXISTS (SELECT * FROM sys.tables WHERE name = 'sources')
    BEGIN
      CREATE TABLE sources (
        id INT IDENTITY(1,1) PRIMARY KEY,
        project_id INT NOT NULL,
        citation_text NVARCHAR(MAX) NOT NULL,
        notes NVARCHAR(MAX) NULL,
        sort_order INT NOT NULL CONSTRAINT df_src_sort DEFAULT (0),
        created_at DATETIME2 NOT NULL CONSTRAINT df_src_created DEFAULT (GETDATE()),
        updated_at DATETIME2 NOT NULL CONSTRAINT df_src_updated DEFAULT (GETDATE()),
        CONSTRAINT fk_sources_project FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE
      );
      CREATE INDEX ix_sources_project ON sources(project_id);
    END
  `);

  await p.request().query(`
    IF EXISTS (SELECT * FROM sys.tables WHERE name = 'sources')
    AND NOT EXISTS (
      SELECT 1 FROM sys.columns
      WHERE object_id = OBJECT_ID('sources') AND name = 'doi'
    )
    ALTER TABLE sources ADD doi NVARCHAR(500) NULL;
  `);

  await p.request().query(`
    IF NOT EXISTS (SELECT * FROM sys.tables WHERE name = 'source_sections')
    BEGIN
      CREATE TABLE source_sections (
        source_id INT NOT NULL,
        section_id INT NOT NULL,
        CONSTRAINT pk_source_sections PRIMARY KEY (source_id, section_id),
        CONSTRAINT fk_ss_source FOREIGN KEY (source_id) REFERENCES sources(id) ON DELETE CASCADE,
        CONSTRAINT fk_ss_section FOREIGN KEY (section_id) REFERENCES project_sections(id) ON DELETE NO ACTION
      );
      -- fk_ss_section uses NO ACTION: SQL Server forbids two CASCADE paths into this junction (projects→sources and projects→project_sections).
      CREATE INDEX ix_source_sections_section ON source_sections(section_id);
    END
  `);

  await p.request().query(`
    IF NOT EXISTS (SELECT * FROM sys.tables WHERE name = 'source_tags')
    BEGIN
      CREATE TABLE source_tags (
        source_id INT NOT NULL,
        tag NVARCHAR(120) NOT NULL,
        CONSTRAINT pk_source_tags PRIMARY KEY (source_id, tag),
        CONSTRAINT fk_source_tags_source FOREIGN KEY (source_id) REFERENCES sources(id) ON DELETE CASCADE
      );
      CREATE INDEX ix_source_tags_tag ON source_tags(tag);
    END
  `);

  await p.request().query(`
    IF EXISTS (SELECT * FROM sys.tables WHERE name = 'sources')
    AND NOT EXISTS (
      SELECT 1 FROM sys.columns
      WHERE object_id = OBJECT_ID('sources') AND name = 'crucible_notes'
    )
    ALTER TABLE sources ADD crucible_notes NVARCHAR(MAX) NULL;
  `);

  const sourceColumns = [
    { name: 'authors',            type: 'NVARCHAR(MAX)' },
    { name: 'publication_date',   type: 'NVARCHAR(100)' },
    { name: 'article_title',     type: 'NVARCHAR(500)' },
    { name: 'journal_title',     type: 'NVARCHAR(500)' },
    { name: 'volume_number',     type: 'NVARCHAR(50)' },
    { name: 'issue_number',      type: 'NVARCHAR(50)' },
    { name: 'page_numbers',      type: 'NVARCHAR(100)' },
    { name: 'chapter_name',      type: 'NVARCHAR(500)' },
    { name: 'conference_name',   type: 'NVARCHAR(500)' },
    { name: 'source_type',       type: 'NVARCHAR(40)' },
    { name: 'publisher',         type: 'NVARCHAR(500)' },
    { name: 'publisher_location', type: 'NVARCHAR(500)' },
    { name: 'editors',           type: 'NVARCHAR(MAX)' },
    { name: 'book_title',        type: 'NVARCHAR(500)' },
    { name: 'url',               type: 'NVARCHAR(1000)' },
    { name: 'edition',           type: 'NVARCHAR(100)' },
    { name: 'access_date',       type: 'NVARCHAR(100)' },
    { name: 'open_access_url',   type: 'NVARCHAR(1000)' },
    { name: 'from_suggestion',   type: 'BIT' },
  ];
  for (const col of sourceColumns) {
    await p.request().query(`
      IF EXISTS (SELECT * FROM sys.tables WHERE name = 'sources')
      AND NOT EXISTS (
        SELECT 1 FROM sys.columns
        WHERE object_id = OBJECT_ID('sources') AND name = '${col.name}'
      )
      ALTER TABLE sources ADD [${col.name}] ${col.type} NULL;
    `);
  }

  await p.request().query(`
    IF NOT EXISTS (SELECT * FROM sys.tables WHERE name = 'anvil_suggestions')
    BEGIN
      CREATE TABLE anvil_suggestions (
        id INT IDENTITY(1,1) PRIMARY KEY,
        project_id INT NOT NULL,
        section_id INT NOT NULL,
        category NVARCHAR(20) NOT NULL,
        body NVARCHAR(MAX) NOT NULL,
        suggestion_status NVARCHAR(20) NOT NULL CONSTRAINT df_anvil_suggestion_status DEFAULT ('open'),
        anchor_json NVARCHAR(500) NULL,
        created_at DATETIME2 NOT NULL CONSTRAINT df_anvil_suggestion_created DEFAULT (GETDATE()),
        updated_at DATETIME2 NOT NULL CONSTRAINT df_anvil_suggestion_updated DEFAULT (GETDATE()),
        -- project_id uses NO ACTION: SQL Server forbids two CASCADE paths from projects (direct + via project_sections→section_id).
        CONSTRAINT fk_anvil_suggestions_project FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE NO ACTION,
        CONSTRAINT fk_anvil_suggestions_section FOREIGN KEY (section_id) REFERENCES project_sections(id) ON DELETE CASCADE
      );
      CREATE INDEX ix_anvil_suggestions_section ON anvil_suggestions(section_id);
      CREATE INDEX ix_anvil_suggestions_project_section ON anvil_suggestions(project_id, section_id);
    END
  `);

  await p.request().query(`
    IF NOT EXISTS (SELECT * FROM sys.tables WHERE name = 'research_plan_items')
    BEGIN
      CREATE TABLE research_plan_items (
        id INT IDENTITY(1,1) PRIMARY KEY,
        project_id INT NOT NULL,
        suggestion_id INT NULL,
        section_id INT NOT NULL,
        section_title NVARCHAR(255) NULL,
        suggestion_body NVARCHAR(MAX) NOT NULL,
        passage_excerpt NVARCHAR(MAX) NULL,
        keywords NVARCHAR(500) NULL,
        created_at DATETIME2 NOT NULL CONSTRAINT df_rp_created DEFAULT (GETDATE()),
        updated_at DATETIME2 NOT NULL CONSTRAINT df_rp_updated DEFAULT (GETDATE()),
        CONSTRAINT fk_research_plan_project FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE,
        CONSTRAINT fk_research_plan_section FOREIGN KEY (section_id) REFERENCES project_sections(id) ON DELETE NO ACTION
        -- suggestion_id: logical link to anvil_suggestions.id (no FK — avoids SQL Server multiple cascade paths via projects)
      );
      CREATE INDEX ix_research_plan_project ON research_plan_items(project_id, created_at DESC);
      CREATE INDEX ix_research_plan_suggestion ON research_plan_items(suggestion_id) WHERE suggestion_id IS NOT NULL;
    END
  `);

  const rpiCols = [
    { name: 'research_needed', type: 'NVARCHAR(500)' },
    { name: 'status',          type: 'NVARCHAR(40)' },
  ];
  for (const col of rpiCols) {
    await p.request().query(`
      IF EXISTS (SELECT * FROM sys.tables WHERE name = 'research_plan_items')
      AND NOT EXISTS (
        SELECT 1 FROM sys.columns
        WHERE object_id = OBJECT_ID('research_plan_items') AND name = '${col.name}'
      )
      ALTER TABLE research_plan_items ADD [${col.name}] ${col.type} NULL;
    `);
  }

  await p.request().query(`
    IF EXISTS (SELECT * FROM sys.tables WHERE name = 'research_plan_items')
    UPDATE research_plan_items SET status = 'unresolved' WHERE status IS NULL;
  `);

  await p.request().query(`
    IF EXISTS (SELECT * FROM sys.tables WHERE name = 'research_plan_items')
    DELETE FROM research_plan_items
    WHERE project_id = 8
      AND section_title = 'Introduction'
      AND suggestion_body LIKE '%critical thinking is impactful to intercultural%';
  `);

  await p.request().query(`
    IF EXISTS (SELECT * FROM sys.tables WHERE name = 'research_plan_items')
    AND NOT EXISTS (
      SELECT 1 FROM sys.indexes WHERE name = 'ux_research_plan_project_suggestion' AND object_id = OBJECT_ID('research_plan_items')
    )
    CREATE UNIQUE INDEX ux_research_plan_project_suggestion
    ON research_plan_items(project_id, suggestion_id)
    WHERE suggestion_id IS NOT NULL;
  `);

  await p.request().query(`
    IF EXISTS (
      SELECT 1 FROM sys.foreign_keys
      WHERE name = 'fk_research_plan_suggestion' AND parent_object_id = OBJECT_ID('research_plan_items')
    )
    ALTER TABLE research_plan_items DROP CONSTRAINT fk_research_plan_suggestion;
  `);

  await p.request().query(`
    IF EXISTS (SELECT * FROM sys.tables WHERE name = 'project_sections')
    AND NOT EXISTS (
      SELECT 1 FROM sys.columns
      WHERE object_id = OBJECT_ID('project_sections') AND name = 'draft_revision'
    )
    ALTER TABLE project_sections ADD draft_revision INT NOT NULL CONSTRAINT df_project_sections_draft_revision DEFAULT (0);
  `);

  await p.request().query(`
    IF EXISTS (SELECT * FROM sys.tables WHERE name = 'anvil_suggestions')
    AND NOT EXISTS (
      SELECT 1 FROM sys.columns
      WHERE object_id = OBJECT_ID('anvil_suggestions') AND name = 'draft_revision_at_generation'
    )
    ALTER TABLE anvil_suggestions ADD draft_revision_at_generation INT NULL;
  `);

  await p.request().query(`
    IF EXISTS (SELECT * FROM sys.tables WHERE name = 'anvil_suggestions')
    UPDATE anvil_suggestions SET draft_revision_at_generation = 0 WHERE draft_revision_at_generation IS NULL;
  `);

  await p.request().query(`
    IF NOT EXISTS (SELECT * FROM sys.tables WHERE name = 'citation_usages')
    BEGIN
      CREATE TABLE citation_usages (
        id INT IDENTITY(1,1) PRIMARY KEY,
        source_id INT NOT NULL,
        section_id INT NOT NULL,
        project_id INT NOT NULL,
        cite_marker NVARCHAR(500) NULL,
        context_excerpt NVARCHAR(MAX) NULL,
        created_at DATETIME2 NOT NULL CONSTRAINT df_cu_created DEFAULT (GETDATE()),
        CONSTRAINT fk_cu_source FOREIGN KEY (source_id) REFERENCES sources(id) ON DELETE CASCADE,
        CONSTRAINT fk_cu_section FOREIGN KEY (section_id) REFERENCES project_sections(id) ON DELETE NO ACTION
      );
      CREATE INDEX ix_cu_project ON citation_usages(project_id);
      CREATE INDEX ix_cu_source ON citation_usages(source_id);
    END
  `);

  await p.request().query(`
    IF NOT EXISTS (SELECT * FROM sys.tables WHERE name = 'anvil_feedback')
    BEGIN
      CREATE TABLE anvil_feedback (
        id             INT IDENTITY(1,1) PRIMARY KEY,
        project_id     INT NOT NULL,
        section_id     INT NOT NULL,
        fb_id          NVARCHAR(100) NOT NULL,
        category       NVARCHAR(50) NOT NULL,
        anchor_text    NVARCHAR(MAX) NOT NULL,
        context_before NVARCHAR(500) NULL,
        context_after  NVARCHAR(500) NULL,
        suggestion     NVARCHAR(MAX) NULL,
        rationale      NVARCHAR(MAX) NULL,
        is_actionable  BIT NOT NULL CONSTRAINT df_af_actionable DEFAULT (0),
        status         NVARCHAR(20) NOT NULL CONSTRAINT df_af_status DEFAULT ('active'),
        anchor_word_count INT NOT NULL CONSTRAINT df_af_awc DEFAULT (0),
        created_at     DATETIME2 NOT NULL CONSTRAINT df_af_created DEFAULT (GETDATE()),
        updated_at     DATETIME2 NOT NULL CONSTRAINT df_af_updated DEFAULT (GETDATE()),
        CONSTRAINT fk_af_project FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE,
        CONSTRAINT fk_af_section FOREIGN KEY (section_id) REFERENCES project_sections(id) ON DELETE NO ACTION
      );
      CREATE INDEX ix_af_project_section ON anvil_feedback(project_id, section_id);
    END
  `);
}

module.exports = { ensureCoreSchema };
