'use strict';

const mysql = require('mysql2/promise');

function convertNamedParams(sqlText, params) {
  if (!params || typeof params !== 'object') params = {};
  const values = [];
  let out = '';
  const re = /@([a-zA-Z_][a-zA-Z0-9_]*)\b/g;
  let last = 0;
  let m;
  while ((m = re.exec(sqlText)) !== null) {
    out += sqlText.slice(last, m.index);
    const name = m[1];
    if (!Object.prototype.hasOwnProperty.call(params, name)) {
      throw new Error(`Missing SQL param @${name}`);
    }
    out += '?';
    values.push(params[name]);
    last = m.index + m[0].length;
  }
  out += sqlText.slice(last);
  return { sql: out, values };
}

function normalizeResult(packet) {
  if (Array.isArray(packet)) {
    return {
      recordset: packet,
      rowsAffected: [packet.length],
      insertId: undefined,
    };
  }
  const hdr = packet;
  return {
    recordset: [],
    rowsAffected: [hdr.affectedRows != null ? hdr.affectedRows : 0],
    insertId: hdr.insertId != null && hdr.insertId !== 0 ? Number(hdr.insertId) : undefined,
  };
}

async function query(getPool, sqlText, params) {
  const pool = await getPool();
  const { sql, values } = convertNamedParams(sqlText, params || {});
  const [packet] = await pool.execute(sql, values);
  return normalizeResult(packet);
}

async function queryRaw(getPool, sqlText) {
  const pool = await getPool();
  const [packet] = await pool.query(sqlText);
  return normalizeResult(packet);
}

async function withTransaction(getPool, fn) {
  const pool = await getPool();
  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();
    async function q(sqlText, params) {
      const { sql, values } = convertNamedParams(sqlText, params || {});
      const [packet] = await conn.execute(sql, values);
      return normalizeResult(packet);
    }
    await fn(q);
    await conn.commit();
  } catch (e) {
    await conn.rollback();
    throw e;
  } finally {
    conn.release();
  }
}

function createPool(config) {
  return mysql.createPool({
    host: config.host,
    port: config.port ?? 3306,
    user: config.user,
    password: config.password,
    database: config.database,
    waitForConnections: true,
    connectionLimit: config.connectionLimit ?? 10,
    queueLimit: 0,
    enableKeepAlive: true,
    charset: 'utf8mb4',
  });
}

module.exports = {
  query,
  queryRaw,
  withTransaction,
  createPool,
  convertNamedParams,
};
