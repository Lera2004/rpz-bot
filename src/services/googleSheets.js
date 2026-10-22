const { googleAppsScriptUrl, syncRetryLimit, syncDelayMs, syncApiKey } = require('../config');
const logger = require('../utils/logger');
const { query } = require('../db/mysql');

const inFlight = new Set();

function hasGoogleConfig() {
  return Boolean(googleAppsScriptUrl && syncApiKey);
}

function syncKey(action, record) {
  return action === 'syncTeacher'
    ? `teacher:${record.id}`
    : `grade:${record.public_id}`;
}

async function postToAppsScript(action, record) {
  const response = await fetch(googleAppsScriptUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ secret: syncApiKey, action, record }),
    signal: AbortSignal.timeout(20000)
  });

  const body = await response.text();
  let result;
  try {
    result = JSON.parse(body);
  } catch {
    const contentType = response.headers.get('content-type') || '';
    if (contentType.includes('text/html') || /^\s*</.test(body)) {
      throw new Error('Apps Script returned an HTML page. Check GOOGLE_APPS_SCRIPT_URL ends with /exec, redeploy the Web App, and allow access.');
    }
    throw new Error(`Apps Script returned a non-JSON response (HTTP ${response.status}).`);
  }

  if (!response.ok || !result.ok) {
    throw new Error(`Apps Script rejected sync (HTTP ${response.status}). Check its deployment and Script Properties.`);
  }
}

async function performSync(action, record, table, identifier) {
  const key = syncKey(action, record);
  if (inFlight.has(key)) return;
  inFlight.add(key);

  try {
    for (let attempt = 1; attempt <= syncRetryLimit; attempt += 1) {
      try {
        await postToAppsScript(action, record);
        await query(`UPDATE ${table} SET google_sync_status = 'synced' WHERE ${identifier.column} = ?`, [identifier.value]);
        logger.info('Google Sheets sync completed', { recordType: action === 'syncTeacher' ? 'teacher' : 'grade' });
        return;
      } catch (error) {
        logger.warn(`Google Sheets sync attempt ${attempt}/${syncRetryLimit} failed`, error.message);
        if (attempt < syncRetryLimit) {
          await new Promise((resolve) => setTimeout(resolve, syncDelayMs * attempt));
        }
      }
    }

    await query(`UPDATE ${table} SET google_sync_status = 'pending' WHERE ${identifier.column} = ?`, [identifier.value]);
    logger.error('Google Sheets sync exhausted retry attempts', { recordType: action === 'syncTeacher' ? 'teacher' : 'grade' });
  } catch (error) {
    logger.error('Google Sheets sync status update failed', error.message);
  } finally {
    inFlight.delete(key);
  }
}

function queueSync(action, record, table, identifier) {
  if (!hasGoogleConfig()) {
    logger.warn('Google Sheets sync is not configured; record remains in MySQL');
    return Promise.resolve({ ok: false, skipped: true });
  }

  void performSync(action, record, table, identifier);
  return Promise.resolve({ ok: true, queued: true });
}

function syncTeacherToGoogle(teacher) {
  return queueSync('syncTeacher', teacher, 'teachers', { column: 'id', value: teacher.id });
}

function syncGradeToGoogle(gradeSubmission) {
  return queueSync('syncGrade', gradeSubmission, 'grade_submissions', {
    column: 'public_id',
    value: gradeSubmission.public_id
  });
}

module.exports = {
  syncTeacherToGoogle,
  syncGradeToGoogle,
  hasGoogleConfig
};
