const http = require('http');
const { URL } = require('url');
const { telegramToken, appPort, syncApiKey } = require('./config');
const logger = require('./utils/logger');
const { query } = require('./db/mysql');
const bot = require('./bot');
const { syncGradeToGoogle } = require('./services/googleSheets');

const allowedGradeFields = new Set(['secretary_status', 'correction_comment']);

async function notifyGradeTeacher(grade, updates) {
  const messageParts = ['Оновлення щодо вашого запису про перескладання:'];
  if (updates.secretary_status) {
    const labels = {
      pending: 'Очікує опрацювання',
      read: 'Опрацьовано',
      needs_correction: 'Потребує виправлення'
    };
    messageParts.push(`Статус: ${labels[grade.secretary_status] || grade.secretary_status}`);
  }
  if (Object.prototype.hasOwnProperty.call(updates, 'correction_comment')) {
    messageParts.push(`Коментар: ${grade.correction_comment || 'коментар видалено'}`);
  }

  try {
    await bot.telegram.sendMessage(Number(grade.telegram_id), messageParts.join('\n'));
  } catch (error) {
    logger.error('Grade update Telegram notification failed', {
      telegramId: grade.telegram_id,
      publicId: grade.public_id,
      message: error.message
    });
  }
}

async function handleGoogleSync(req, res) {
  const requestUrl = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  if (requestUrl.pathname !== '/api/google-sync') {
    res.writeHead(404, { 'Content-Type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify({ ok: false, error: 'Not found' }));
    return;
  }

  if (!syncApiKey || req.headers['x-api-key'] !== syncApiKey) {
    res.writeHead(401, { 'Content-Type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify({ ok: false, error: 'Unauthorized' }));
    return;
  }

  let body = '';
  req.on('data', (chunk) => {
    body += chunk;
  });

  req.on('end', async () => {
    try {
      const payload = JSON.parse(body || '{}');
      const { sheetName, recordId, updates = {} } = payload;

      if (!sheetName || !recordId) {
        res.writeHead(400, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({ ok: false, error: 'Missing sheetName or recordId' }));
        return;
      }

      const gradeRecord = sheetName === 'Записи' && String(recordId).startsWith('grade:');
      const allowedFields = gradeRecord ? allowedGradeFields : null;
      if (!allowedFields) {
        res.writeHead(400, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({ ok: false, error: 'Unsupported sheet record' }));
        return;
      }

      const invalidField = Object.keys(updates).find((field) => !allowedFields.has(field));
      if (invalidField) {
        res.writeHead(400, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({ ok: false, error: `Field '${invalidField}' is not allowed for this sheet` }));
        return;
      }

      if (Object.keys(updates).length === 0) {
        res.writeHead(400, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({ ok: false, error: 'No updates were provided' }));
        return;
      }

      const validGradeStatuses = new Set(['pending', 'read', 'needs_correction']);
      if (gradeRecord && updates.secretary_status && !validGradeStatuses.has(updates.secretary_status)) {
        res.writeHead(400, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({ ok: false, error: 'Invalid grade status' }));
        return;
      }

      const fieldEntries = Object.entries(updates);
      const setClause = fieldEntries.map(([field]) => `${field} = ?`).join(', ');
      const values = fieldEntries.map(([, value]) => value);

      if (gradeRecord) {
        const publicId = String(recordId).slice('grade:'.length);
        const rows = await query(
          'SELECT gs.*, t.telegram_id FROM grade_submissions gs JOIN teachers t ON t.id = gs.teacher_id WHERE gs.public_id = ?',
          [publicId]
        );
        if (!rows.length) {
          res.writeHead(404, { 'Content-Type': 'application/json; charset=utf-8' });
          res.end(JSON.stringify({ ok: false, error: 'Grade not found' }));
          return;
        }

        const readMetadata = updates.secretary_status
          ? ", read_by = CASE WHEN secretary_status = 'pending' THEN NULL ELSE 'google-sheet' END, read_at = CASE WHEN secretary_status = 'pending' THEN NULL ELSE NOW() END"
          : '';
        await query(
          `UPDATE grade_submissions SET ${setClause}${readMetadata}, updated_at = NOW() WHERE public_id = ?`,
          [...values, publicId]
        );
        const grade = (await query('SELECT * FROM grade_submissions WHERE public_id = ?', [publicId]))[0];
        const notificationGrade = { ...grade, telegram_id: rows[0].telegram_id, public_id: publicId };
        await query('INSERT INTO audit_log (user_or_admin, action_type, target_type, target_id, previous_value, new_value, metadata) VALUES (?, ?, ?, ?, ?, ?, ?)', [
          'google-sheet',
          'grade_status_updated',
          'grade_submissions',
          grade.id,
          JSON.stringify(rows[0]),
          JSON.stringify(grade),
          JSON.stringify({ source: 'google-apps-script' })
        ]);
        await notifyGradeTeacher(notificationGrade, updates);
      }

      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ ok: true, updated: true, sheetName, recordId }));
    } catch (error) {
      logger.error('API request failed', error.message);
      res.writeHead(500, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ ok: false, error: 'Internal server error' }));
    }
  });
}

const server = http.createServer((req, res) => {
  handleGoogleSync(req, res);
});

let retryingGoogleSync = false;
const googleSyncRetryTimer = setInterval(async () => {
  if (retryingGoogleSync) return;
  retryingGoogleSync = true;

  try {
    const grades = await query(
      "SELECT gs.*, t.full_name AS teacher_name, t.verification_status AS teacher_status, t.telegram_id, t.phone AS teacher_phone, t.telegram_username AS teacher_username, t.telegram_display_name AS teacher_display_name, s.name AS subject_name, g.name AS group_name FROM grade_submissions gs JOIN teachers t ON t.id = gs.teacher_id JOIN subjects s ON s.id = gs.subject_id JOIN student_groups g ON g.id = gs.group_id WHERE gs.google_sync_status = 'pending' ORDER BY gs.id ASC LIMIT 25"
    );
    for (const grade of grades) {
      await syncGradeToGoogle({
        ...grade,
        student_name: grade.student_name_snapshot
      });
    }
  } catch (error) {
    logger.error('Google Sheets retry job failed', error.message);
  } finally {
    retryingGoogleSync = false;
  }
}, 5 * 60 * 1000);

async function startBot() {
  if (!telegramToken) {
    logger.warn('Telegram token missing; bot not started.');
    return;
  }

  await bot.launch();
  logger.info('Telegram bot launched successfully');
}

async function startServer() {
  server.listen(appPort, () => {
    logger.info(`Protected sync API listening on port ${appPort}`);
  });
}

async function shutdown() {
  logger.warn('Shutting down application...');
  clearInterval(googleSyncRetryTimer);
  await bot.stop('SIGINT');
  server.close();
  process.exit(0);
}

startBot().catch((error) => {
  logger.error('Telegram bot failed to start. Check TELEGRAM_TOKEN and network access.', error.message);
});
startServer();

process.once('SIGINT', shutdown);
process.once('SIGTERM', shutdown);
