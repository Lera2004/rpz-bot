const path = require('path');
const dotenv = require('dotenv');

dotenv.config({ path: path.resolve(process.cwd(), '.env') });

function parseAllowedGrades(value) {
  const values = [];
  for (const part of value.split(',')) {
    const range = part.trim().match(/^(\d+)\s*-\s*(\d+)$/);
    if (range) {
      const start = Number(range[1]);
      const end = Number(range[2]);
      if (start > end || end - start > 1000) {
        throw new Error(`Invalid grade range: ${part}`);
      }
      for (let grade = start; grade <= end; grade += 1) {
        values.push(String(grade));
      }
    } else if (/^\d+$/.test(part.trim())) {
      values.push(part.trim());
    } else if (part.trim()) {
      throw new Error(`Invalid grade value: ${part}`);
    }
  }
  return [...new Set(values)];
}

const config = {
  telegramToken: process.env.TELEGRAM_TOKEN || '',
  adminTelegramIds: (process.env.ADMIN_TELEGRAM_IDS || '')
    .split(',')
    .map((v) => Number(v.trim()))
    .filter(Boolean),
  db: {
    host: process.env.DB_HOST || 'localhost',
    port: Number(process.env.DB_PORT || 3306),
    user: process.env.DB_USER || 'root',
    password: process.env.DB_PASSWORD || '',
    database: process.env.DB_NAME || 'teacher_grades'
  },
  googleAppsScriptUrl: process.env.GOOGLE_APPS_SCRIPT_URL || '',
  syncApiKey: process.env.SYNC_API_KEY || '',
  appPort: Number(process.env.APP_PORT || 3000),
  syncRetryLimit: Number(process.env.SYNC_RETRY_LIMIT || 5),
  syncDelayMs: Number(process.env.SYNC_DELAY_MS || 5000),
  allowedGradeValues: parseAllowedGrades(process.env.ALLOWED_GRADE_VALUES || '0-100')
};

if (!config.telegramToken) {
  console.warn('[config] TELEGRAM_TOKEN is not set. Bot will not start until it is configured.');
}

module.exports = config;
