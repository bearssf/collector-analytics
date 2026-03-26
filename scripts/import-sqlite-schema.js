#!/usr/bin/env node
/**
 * Legacy: this script targeted SQL Server (mssql) and SQLite→T-SQL conversion.
 * AcademiqForge now uses MySQL; core DDL runs from lib/schema.js on server startup.
 * For one-off MySQL schema, use mysqldump / mysql CLI or run the app once against an empty database.
 */
console.error(
  'scripts/import-sqlite-schema.js is obsolete (SQL Server / mssql). The app uses MySQL; see lib/schema.js.'
);
process.exit(1);
