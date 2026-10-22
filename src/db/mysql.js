const mysql = require('mysql2/promise');
const { db } = require('../config');
const logger = require('../utils/logger');

const pool = mysql.createPool({
  host: db.host,
  port: db.port,
  user: db.user,
  password: db.password,
  database: db.database,
  waitForConnections: true,
  connectionLimit: 10,
  queueLimit: 0,
  charset: 'utf8mb4',
  timezone: '+00:00'
});

pool
  .getConnection()
  .then((connection) => {
    connection.release();
    logger.info('MySQL connection pool initialized successfully');
  })
  .catch((error) => {
    logger.error('MySQL pool initialization failed:', error.message);
  });

async function query(sql, params = []) {
  try {
    const [rows] = await pool.execute(sql, params);
    return rows;
  } catch (error) {
    logger.error('MySQL query failed:', error.message);
    throw error;
  }
}

async function transaction(callback) {
  const connection = await pool.getConnection();
  try {
    await connection.beginTransaction();
    const result = await callback(connection);
    await connection.commit();
    return result;
  } catch (error) {
    await connection.rollback();
    throw error;
  } finally {
    connection.release();
  }
}

module.exports = {
  pool,
  query,
  execute: query,
  transaction,
  getConnection: () => pool.getConnection(),
  end: () => pool.end()
};
