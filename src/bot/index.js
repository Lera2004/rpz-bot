const { Telegraf, Markup } = require('telegraf');
const { v4: uuidv4 } = require('uuid');
const config = require('../config');
const { query } = require('../db/mysql');
const logger = require('../utils/logger');
const { syncTeacherToGoogle, syncGradeToGoogle } = require('../services/googleSheets');

const bot = new Telegraf(config.telegramToken || '');
const sessions = new Map();

function normalizePhone(phone) {
  return String(phone || '').replace(/[^\d+]/g, '').slice(0, 32) || '';
}

function gradeInputKeyboard() {
  return Markup.inlineKeyboard([
    [Markup.button.callback('↩️ Назад', 'grade_back'), Markup.button.callback('❌ Скасувати', 'cancel_grade')]
  ]);
}

function sanitizeFullName(value) {
  return String(value || '').replace(/\s+/g, ' ').trim();
}

function telegramDisplayName(from) {
  return sanitizeFullName([from.first_name, from.last_name].filter(Boolean).join(' ')) || null;
}

function newSession() {
  return {
    flow: null,
    step: null,
    teacher_id: null,
    subject_id: null,
    subject_name: null,
    semester: null,
    group_id: null,
    group_name: null,
    student_id: null,
    student_name: null,
    grade: null,
    draft: {},
    lastAction: null,
    student_input_mode: 'select',
    edit_public_id: null
  };
}

function getSession(ctx) {
  const key = String(ctx.from.id);
  if (!sessions.has(key)) {
    sessions.set(key, newSession());
  }
  return sessions.get(key);
}

function clearSession(ctx) {
  sessions.delete(String(ctx.from.id));
}

function isAdmin(userId) {
  return config.adminTelegramIds.includes(Number(userId));
}

async function logAudit(user, actionType, targetType, targetId, previousValue, newValue, metadata = {}) {
  try {
    await query(
      'INSERT INTO audit_log (user_or_admin, action_type, target_type, target_id, previous_value, new_value, metadata) VALUES (?, ?, ?, ?, ?, ?, ?)',
      [user, actionType, targetType, targetId, previousValue ? JSON.stringify(previousValue) : null, newValue ? JSON.stringify(newValue) : null, JSON.stringify(metadata)]
    );
  } catch (error) {
    logger.error('Audit log write failed', error.message);
  }
}

async function ensureTeacherRecord(from) {
  const telegramId = Number(from.id);
  const phone = normalizePhone(from.phone || '');
  const username = from.username || null;
  const displayName = telegramDisplayName(from);
  const current = await query('SELECT * FROM teachers WHERE telegram_id = ?', [telegramId]);

  if (current.length > 0) {
    const teacher = current[0];
    if ((phone && teacher.phone !== phone) ||
        teacher.telegram_username !== username ||
        (displayName && teacher.telegram_display_name !== displayName)) {
      await query(
        'UPDATE teachers SET phone = COALESCE(NULLIF(?, ?), phone), telegram_username = ?, telegram_display_name = COALESCE(?, telegram_display_name), updated_at = NOW() WHERE telegram_id = ?',
        [phone, '', username, displayName, telegramId]
      );
      const updatedTeacher = await findTeacherById(telegramId);
      await syncTeacherToGoogle(updatedTeacher);
      return updatedTeacher;
    }
    return teacher;
  }

  const result = await query(
    'INSERT INTO teachers (telegram_id, phone, telegram_username, telegram_display_name, full_name, verification_status, registered_at, updated_at) VALUES (?, NULLIF(?, ?), ?, ?, NULL, ?, NOW(), NOW())',
    [telegramId, phone, '', username, displayName, 'pending']
  );

  const insertedTeacher = {
    id: result.insertId,
    telegram_id: telegramId,
    phone: phone || null,
    telegram_username: username,
    telegram_display_name: displayName,
    full_name: null,
    verification_status: 'pending',
    registered_at: new Date().toISOString().slice(0, 19).replace('T', ' '),
    verified_by: null,
    verified_at: null
  };

  await logAudit(telegramId, 'teacher_registered', 'teachers', insertedTeacher.id, null, insertedTeacher, { source: 'bot' });
  await syncTeacherToGoogle(insertedTeacher);
  return insertedTeacher;
}

function teacherMainMenu() {
  return Markup.keyboard([
    ['📝 Надіслати оцінку'],
    ['📜 Мої останні записи', '👤 Мій профіль'],
    ['❓ Допомога']
  ]).resize();
}

function buildGradeOptionKeyboard() {
  const values = config.allowedGradeValues || ['2', '3', '4', '5', '12'];
  const rows = [];

  for (let i = 0; i < values.length; i += 3) {
    rows.push(values.slice(i, i + 3).map((value) => Markup.button.callback(value, `grade_opt_${value}`)));
  }

  rows.push([
    Markup.button.callback('↩️ Назад', 'grade_back'),
    Markup.button.callback('❌ Скасувати', 'cancel_grade')
  ]);

  return Markup.inlineKeyboard(rows);
}

function buildGradeSummary(session) {
  if (!session) {
    return 'Дані відсутні';
  }

  return [
    `Дисципліна: ${session.subject_name || 'не обрано'}`,
    `Семестр: ${session.semester || 'не вказано'}`,
    `Студент: ${session.student_name || 'не обрано'}`,
    `Група: ${session.group_name || 'не обрано'}`,
    `Оцінка: ${session.grade || 'не вказана'}`
  ].join('\n');
}

function allowedGradeDescription() {
  const grades = config.allowedGradeValues;
  if (grades.length === 101 && grades[0] === '0' && grades[100] === '100') {
    return 'від 0 до 100 включно';
  }
  return grades.join(', ');
}

async function ensureNamedRecordId(tableName, name) {
  const allowedTables = new Set(['subjects', 'student_groups']);
  if (!allowedTables.has(tableName)) {
    throw new Error('Unsupported reference table');
  }

  const result = await query(
    `INSERT INTO ${tableName} (name, is_active) VALUES (?, 1) ON DUPLICATE KEY UPDATE id = LAST_INSERT_ID(id)`,
    [name]
  );
  return result.insertId;
}

function adminMenu() {
  return Markup.keyboard([
    ['Нові реєстрації', 'Неперевірені викладачі'],
    ['Підтвердити викладача', 'Відхилити викладача'],
    ['Останні оцінки', 'Не синхронізовані записи'],
    ['Повторна синхронізація']
  ]).resize();
}

async function findTeacherById(telegramId) {
  const rows = await query('SELECT * FROM teachers WHERE telegram_id = ?', [telegramId]);
  return rows[0] || null;
}

async function displayTeacherDashboard(ctx) {
  const teacher = await findTeacherById(ctx.from.id);
  if (!teacher) {
    return ctx.reply('Спочатку завершіть реєстрацію через /start.');
  }

  const rows = await query(
    'SELECT gs.public_id, gs.semester, s.name AS subject_name, sg.name AS group_name, gs.student_name_snapshot, gs.grade, gs.secretary_status, gs.submitted_at FROM grade_submissions gs LEFT JOIN subjects s ON s.id = gs.subject_id LEFT JOIN student_groups sg ON sg.id = gs.group_id WHERE gs.teacher_id = ? ORDER BY gs.submitted_at DESC, gs.id DESC LIMIT 10',
    [teacher.id]
  );

  if (!rows.length) {
    return ctx.reply('У вас поки що немає записів оцінок.');
  }

  const secretaryStatuses = {
    pending: 'Очікує опрацювання',
    read: 'Опрацьовано',
    needs_correction: 'Потребує виправлення'
  };
  const lines = rows.map((row, index) => {
    const status = secretaryStatuses[row.secretary_status] || 'Невідомий статус';
    return `${index + 1}. ${row.subject_name} | ${row.semester} семестр | ${row.student_name_snapshot} | ${row.group_name} | ${row.grade} | ${status}`;
  }).join('\n');
  const keyboard = Markup.inlineKeyboard(rows.map((row, index) => [
    Markup.button.callback(`✏️ Редагувати запис ${index + 1}`, `edit_grade_${row.public_id}`)
  ]));
  return ctx.reply(`Ваші записи (для редагування оберіть запис нижче):\n${lines}`, keyboard);
}

async function showTeacherProfile(ctx) {
  const teacher = await findTeacherById(ctx.from.id);
  if (!teacher) {
    return ctx.reply('Спочатку завершіть реєстрацію через /start.');
  }

  const totalGrades = await query('SELECT COUNT(*) AS total FROM grade_submissions WHERE teacher_id = ?', [teacher.id]);
  const profileText = [
    '👤 Мій профіль',
    `ПІБ: ${teacher.full_name || 'ще не вказано'}`,
    `Телефон: ${teacher.phone || 'ще не вказано'}`,
    `Кількість оцінок: ${Number(totalGrades[0]?.total || 0)}`
  ].join('\n');

  return ctx.reply(profileText, Markup.inlineKeyboard([
    [Markup.button.callback('✏️ Редагувати ПІБ', 'profile_edit_name')],
    [Markup.button.callback('↩️ Назад', 'profile_close')]
  ]));
}

async function startGradeSubmission(ctx) {
  const teacher = await findTeacherById(ctx.from.id);
  if (!teacher) {
    return ctx.reply('Спочатку завершіть реєстрацію через /start.');
  }
  if (!teacher.full_name) {
    return ctx.reply('Спочатку введіть своє прізвище та ініціали через /start.');
  }

  if (teacher.verification_status === 'rejected') {
    return ctx.reply('Ваш акаунт відхилено. Нові оцінки не можуть бути надіслані.');
  }

  const session = getSession(ctx);
  session.flow = 'grade';
  session.step = 'subject_name';
  session.teacher_id = teacher.id;
  session.draft = {};
  session.grade = null;
  session.student_input_mode = 'text';
  session.edit_public_id = null;

  return ctx.reply('Введіть назву дисципліни (предмету), яку було перескладено.', gradeInputKeyboard());
}

async function finalizeGradeSubmission(ctx) {
  const session = getSession(ctx);
  if (!session || !session.teacher_id) {
    return ctx.reply('Сесія введення оцінки не активна.');
  }

  const teacher = await findTeacherById(ctx.from.id);
  if (!teacher) {
    return ctx.reply('Профіль викладача не знайдено.');
  }

  if (teacher.verification_status === 'rejected') {
    return ctx.reply('Відхилений акаунт не може відправляти оцінки.');
  }

  const subjectName = sanitizeFullName(session.subject_name);
  const semester = sanitizeFullName(session.semester);
  const groupName = sanitizeFullName(session.group_name);
  const studentName = sanitizeFullName(session.student_name);

  if (!subjectName || (!semester && !session.edit_public_id) || !groupName || !studentName || !session.grade) {
    return ctx.reply('Відсутні обов’язкові дані для збереження оцінки.');
  }

  const subjectId = await ensureNamedRecordId('subjects', subjectName);
  const groupId = await ensureNamedRecordId('student_groups', groupName);
  if (session.edit_public_id) {
    const existing = await query(
      'SELECT * FROM grade_submissions WHERE public_id = ? AND teacher_id = ?',
      [session.edit_public_id, teacher.id]
    );
    if (!existing.length) {
      return ctx.reply('Запис не знайдено або він більше вам недоступний.');
    }
    let student = await query('SELECT id FROM students WHERE full_name = ? AND group_id = ? AND is_active = 1 LIMIT 1', [studentName, groupId]);
    let studentId = student[0]?.id || null;
    if (!studentId) {
      const studentInsert = await query('INSERT INTO students (full_name, group_id, is_active, created_at, updated_at) VALUES (?, ?, 1, NOW(), NOW())', [studentName, groupId]);
      studentId = studentInsert.insertId;
    }

    await query(
      'UPDATE grade_submissions SET subject_id = ?, semester = ?, group_id = ?, student_name_snapshot = ?, student_id = ?, grade = ?, secretary_status = ?, read_at = NULL, read_by = NULL, correction_comment = NULL, google_sync_status = ?, updated_at = NOW() WHERE public_id = ? AND teacher_id = ?',
      [subjectId, semester, groupId, studentName, studentId, session.grade, 'pending', 'pending', session.edit_public_id, teacher.id]
    );
    const updated = (await query(
      'SELECT gs.*, t.full_name AS teacher_name, t.verification_status AS teacher_status, t.telegram_id, t.phone AS teacher_phone, t.telegram_username AS teacher_username, t.telegram_display_name AS teacher_display_name, s.name AS subject_name, g.name AS group_name FROM grade_submissions gs JOIN teachers t ON t.id = gs.teacher_id JOIN subjects s ON s.id = gs.subject_id JOIN student_groups g ON g.id = gs.group_id WHERE gs.public_id = ?',
      [session.edit_public_id]
    ))[0];
    await logAudit(ctx.from.id, 'grade_updated', 'grade_submissions', existing[0].id, existing[0], updated, { source: 'bot' });
    await syncGradeToGoogle({ ...updated, student_name: updated.student_name_snapshot });
    clearSession(ctx);
    return ctx.reply('✅ Запис оновлено.', gradeSubmissionActions());
  }

  let student = await query('SELECT * FROM students WHERE full_name = ? AND group_id = ? AND is_active = 1 LIMIT 1', [studentName, groupId]);
  let studentId = student[0]?.id || null;

  if (!studentId) {
    const studentInsert = await query('INSERT INTO students (full_name, group_id, is_active, created_at, updated_at) VALUES (?, ?, 1, NOW(), NOW())', [studentName, groupId]);
    studentId = studentInsert.insertId;
  }

  const publicId = uuidv4();
  const submission = await query(
    'INSERT INTO grade_submissions (public_id, teacher_id, subject_id, semester, group_id, student_id, student_name_snapshot, grade, submitted_at, secretary_status, google_sync_status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, NOW(), ?, ?, NOW(), NOW())',
    [publicId, teacher.id, subjectId, semester, groupId, studentId, studentName, session.grade, 'pending', 'pending']
  );

  const row = {
    id: submission.insertId,
    public_id: publicId,
    teacher_name: teacher.full_name || 'Не вказано',
    teacher_status: teacher.verification_status,
    telegram_id: teacher.telegram_id,
    teacher_phone: teacher.phone,
    teacher_username: teacher.telegram_username,
    teacher_display_name: teacher.telegram_display_name,
    subject_name: subjectName,
    semester,
    group_name: groupName,
    student_name: studentName,
    grade: session.grade,
    secretary_status: 'pending',
    correction_comment: null,
    submitted_at: new Date().toISOString()
  };

  await logAudit(ctx.from.id, 'grade_submitted', 'grade_submissions', submission.insertId, null, row, { subject: subjectName, group: groupName });
  await syncGradeToGoogle(row);

  clearSession(ctx);
  return ctx.reply('✅ Запис збережено.', gradeSubmissionActions());
}

function gradeSubmissionActions() {
  return Markup.inlineKeyboard([
    [Markup.button.callback('➕ Додати ще один запис', 'grade_add_another')],
    [Markup.button.callback('📋 Переглянути та редагувати записи', 'grade_my_records')]
  ]);
}

bot.start(async (ctx) => {
  const teacher = await ensureTeacherRecord(ctx.from);
  if (!teacher.phone) {
    await ctx.reply('Вітаю! Для реєстрації поділіться контактом один раз.', Markup.keyboard([
      [Markup.button.contactRequest('Поділитися контактом')]
    ]).resize());
    return;
  }

  if (!teacher.full_name) {
    const session = getSession(ctx);
    session.flow = 'registration';
    session.step = 'full_name';
    session.teacher_id = teacher.id;
    return ctx.reply('Контакт уже збережено. Введіть ваше прізвище та ініціали.');
  }

  return ctx.reply(`Вітаю, ${teacher.full_name}!`, teacherMainMenu());
});

bot.command('profile', async (ctx) => {
  await showTeacherProfile(ctx);
});

bot.command('help', async (ctx) => {
  const message = [
    'Команди бота:',
    '/start — повернутися до головного меню',
    '/help — показати цю довідку',
    '/admin — адміністративне меню (тільки для адміністраторів)' 
  ].join('\n');
  await ctx.reply(message);
});

bot.command('admin', async (ctx) => {
  if (!isAdmin(ctx.from.id)) {
    return ctx.reply('У вас немає доступу до адміністративних команд.');
  }

  await ctx.reply('Адміністративне меню', adminMenu());
});

bot.hears('📝 Надіслати оцінку', async (ctx) => {
  await startGradeSubmission(ctx);
});

bot.hears('📜 Мої останні записи', async (ctx) => {
  await displayTeacherDashboard(ctx);
});

bot.hears('👤 Мій профіль', async (ctx) => {
  await showTeacherProfile(ctx);
});

bot.action('profile_edit_name', async (ctx) => {
  const teacher = await findTeacherById(ctx.from.id);
  if (!teacher) return ctx.reply('Профіль викладача не знайдено.');

  const session = getSession(ctx);
  session.flow = 'profile_edit';
  session.step = 'full_name';
  session.teacher_id = teacher.id;
  return ctx.reply(
    `Поточне ПІБ: ${teacher.full_name || 'не вказано'}\nВведіть нове ПІБ або натисніть «Назад», щоб не змінювати його.`,
    Markup.inlineKeyboard([[Markup.button.callback('↩️ Назад', 'profile_cancel_edit')]])
  );
});

bot.action('profile_cancel_edit', async (ctx) => {
  clearSession(ctx);
  return showTeacherProfile(ctx);
});

bot.action('profile_close', async (ctx) => {
  clearSession(ctx);
  return ctx.reply('Головне меню.', teacherMainMenu());
});

bot.hears('❓ Допомога', async (ctx) => {
  await ctx.reply('Використовуйте кнопки меню, команди /start, /help, /profile або запустіть новий сценарій оцінювання через кнопку “📝 Надіслати оцінку”.');
});

bot.hears('Нові реєстрації', async (ctx) => {
  if (!isAdmin(ctx.from.id)) {
    return ctx.reply('Доступ заборонено.');
  }
  const rows = await query('SELECT * FROM teachers WHERE verification_status = ? ORDER BY registered_at DESC LIMIT 10', ['pending']);
  if (!rows.length) {
    return ctx.reply('Немає нових реєстрацій.');
  }
  return ctx.reply(rows.map((teacher) => `${teacher.id} | ${teacher.telegram_id} | ${teacher.full_name || '—'}`).join('\n'));
});

bot.hears('Неперевірені викладачі', async (ctx) => {
  if (!isAdmin(ctx.from.id)) {
    return ctx.reply('Доступ заборонено.');
  }
  const rows = await query('SELECT * FROM teachers WHERE verification_status = ? ORDER BY registered_at DESC LIMIT 10', ['pending']);
  if (!rows.length) {
    return ctx.reply('Немає неперевірених викладачів.');
  }
  const keyboard = Markup.inlineKeyboard([
    ...rows.map((teacher) => [Markup.button.callback(`${teacher.full_name || 'Без ПІБ'} (${teacher.telegram_id})`, `teacher_verify_${teacher.id}`)]),
    [Markup.button.callback('❌ Закрити', 'admin_cancel')]
  ]);
  return ctx.reply('Оберіть викладача для перевірки:', keyboard);
});

bot.hears('Підтвердити викладача', async (ctx) => {
  if (!isAdmin(ctx.from.id)) {
    return ctx.reply('Доступ заборонено.');
  }
  const rows = await query('SELECT * FROM teachers WHERE verification_status = ? ORDER BY registered_at DESC LIMIT 10', ['pending']);
  if (!rows.length) {
    return ctx.reply('Немає викладачів для підтвердження.');
  }
  const keyboard = Markup.inlineKeyboard(rows.map((teacher) => [Markup.button.callback(`${teacher.full_name || 'Без ПІБ'} | ${teacher.telegram_id}`, `teacher_approve_${teacher.id}`)]));
  return ctx.reply('Оберіть викладача для підтвердження:', keyboard);
});

bot.hears('Відхилити викладача', async (ctx) => {
  if (!isAdmin(ctx.from.id)) {
    return ctx.reply('Доступ заборонено.');
  }
  const rows = await query('SELECT * FROM teachers WHERE verification_status = ? ORDER BY registered_at DESC LIMIT 10', ['pending']);
  if (!rows.length) {
    return ctx.reply('Немає викладачів для відхилення.');
  }
  const keyboard = Markup.inlineKeyboard(rows.map((teacher) => [Markup.button.callback(`${teacher.full_name || 'Без ПІБ'} | ${teacher.telegram_id}`, `teacher_reject_${teacher.id}`)]));
  return ctx.reply('Оберіть викладача для відхилення:', keyboard);
});

bot.hears('Останні оцінки', async (ctx) => {
  if (!isAdmin(ctx.from.id)) {
    return ctx.reply('Доступ заборонено.');
  }
  return bot.action('admin_latest_grades')(ctx);
});

bot.hears('Не синхронізовані записи', async (ctx) => {
  if (!isAdmin(ctx.from.id)) {
    return ctx.reply('Доступ заборонено.');
  }
  const rows = await query('SELECT * FROM grade_submissions WHERE google_sync_status = ? ORDER BY updated_at DESC LIMIT 10', ['pending']);
  if (!rows.length) {
    return ctx.reply('Немає записів, які не синхронізувалися.');
  }
  return ctx.reply(rows.map((row) => `${row.public_id} | ${row.student_name_snapshot} | ${row.grade}`).join('\n'));
});

bot.hears('Повторна синхронізація', async (ctx) => {
  if (!isAdmin(ctx.from.id)) {
    return ctx.reply('Доступ заборонено.');
  }
  return ctx.reply('Повторна синхронізація активована на серверному рівні.');
});

bot.on('contact', async (ctx) => {
  const contact = ctx.message.contact;

  if (!contact || contact.user_id !== ctx.from.id) {
    return ctx.reply('Неможливо прийняти контакт іншої людини.');
  }

  const phone = normalizePhone(contact.phone_number);
  if (!phone) {
    return ctx.reply('Номер телефону не розпізнаний. Спробуйте ще раз.');
  }

  const existingTeacher = await ensureTeacherRecord(ctx.from);
  if (existingTeacher.phone) {
    if (!existingTeacher.full_name) {
      const session = getSession(ctx);
      session.flow = 'registration';
      session.step = 'full_name';
      session.teacher_id = existingTeacher.id;
      return ctx.reply('Контакт уже збережено! Введіть ваше прізвище та ініціали.');
    }
    return ctx.reply('Контакт уже збережено. Повторно надсилати його не потрібно.', teacherMainMenu());
  }
  const duplicatePhone = await query(
    'SELECT id FROM teachers WHERE phone = ? AND telegram_id <> ? LIMIT 1',
    [phone, ctx.from.id]
  );
  if (duplicatePhone.length) {
    return ctx.reply('Цей номер уже пов’язаний з іншим обліковим записом. Зверніться до адміністратора.');
  }

  await query(
    'UPDATE teachers SET phone = ?, telegram_username = ?, telegram_display_name = COALESCE(?, telegram_display_name), updated_at = NOW() WHERE telegram_id = ?',
    [phone, ctx.from.username || null, telegramDisplayName(ctx.from), ctx.from.id]
  );

  const current = await findTeacherById(ctx.from.id);
  await logAudit(ctx.from.id, 'teacher_contact_shared', 'teachers', current.id, null, {
    has_phone: Boolean(current.phone),
    has_telegram_username: Boolean(current.telegram_username)
  }, { source: 'bot' });
  await syncTeacherToGoogle(current);
  const session = getSession(ctx);
  session.flow = 'registration';
  session.step = 'full_name';
  session.teacher_id = current.id;

  await ctx.reply('Контакт збережено! Введіть ваше прізвище та ініціали.', Markup.removeKeyboard());
});

function gradePrompt(step) {
  const prompts = {
    subject_name: 'Введіть назву дисципліни (предмету), яку було перескладено.',
    semester: 'Введіть номер семестру (від 1 до 8).',
    student_name: 'Введіть ПІБ студента, який пересклав дисципліну (предмет).',
    group_name: 'Введіть академічну групу, в якій навчається студент.',
    grade_value: `Введіть оцінку, на яку пересклав студент. Дозволені значення: ${allowedGradeDescription()}.`
  };
  return prompts[step];
}

function gradeConfirmationKeyboard() {
  return Markup.inlineKeyboard([
    [Markup.button.callback('✅ Підтвердити', 'grade_confirm')],
    [Markup.button.callback('↩️ Назад', 'grade_back'), Markup.button.callback('❌ Скасувати', 'cancel_grade')]
  ]);
}

function editFieldsKeyboard() {
  return Markup.inlineKeyboard([
    [Markup.button.callback('Дисципліна', 'grade_edit_field_subject_name')],
    [Markup.button.callback('Семестр', 'grade_edit_field_semester')],
    [Markup.button.callback('ПІБ студента', 'grade_edit_field_student_name')],
    [Markup.button.callback('Академічна група', 'grade_edit_field_group_name')],
    [Markup.button.callback('Оцінка', 'grade_edit_field_grade_value')],
    [Markup.button.callback('↩️ Назад', 'grade_back'), Markup.button.callback('❌ Скасувати', 'cancel_grade')]
  ]);
}

bot.on('text', async (ctx) => {
  const session = getSession(ctx);
  const text = ctx.message.text.trim();

  if (text.toLowerCase() === 'назад') {
    if (session.flow === 'profile_edit' && session.step === 'full_name') {
      clearSession(ctx);
      return showTeacherProfile(ctx);
    }
    if (session.flow === 'grade' && session.edit_public_id && session.step === 'edit_field_select') {
      clearSession(ctx);
      return displayTeacherDashboard(ctx);
    }
    if (session.flow === 'grade' && session.edit_public_id && session.step === 'edit_confirm') {
      session.step = 'edit_field_select';
      return ctx.reply('Оберіть, яке поле потрібно змінити:', editFieldsKeyboard());
    }
    if (session.flow === 'grade' && session.step === 'edit_value') {
      session.step = 'edit_field_select';
      return ctx.reply('Оберіть, яке поле потрібно змінити:', editFieldsKeyboard());
    }
    const previousSteps = {
      confirm_grade: 'grade_value',
      grade_value: 'group_name',
      group_name: 'student_name',
      student_name: 'semester',
      semester: 'subject_name'
    };
    if (session.flow === 'grade' && previousSteps[session.step]) {
      session.step = previousSteps[session.step];
      return ctx.reply(gradePrompt(session.step), gradeInputKeyboard());
    }
    if (session.flow === 'registration' && session.step === 'full_name') {
      clearSession(ctx);
      return ctx.reply('Реєстрацію призупинено. Контакт уже збережено; щоб продовжити, введіть /start.');
    }
    if (session.flow === 'grade' && session.step === 'subject_name') {
      clearSession(ctx);
      return ctx.reply('Повернулися до головного меню.', teacherMainMenu());
    }
    return ctx.reply('Повернення на попередній крок недоступне.');
  }

  if (text.toLowerCase() === 'скасувати') {
    if (session.flow === 'profile_edit') {
      clearSession(ctx);
      return showTeacherProfile(ctx);
    }
    clearSession(ctx);
    return ctx.reply('Внесення запису скасовано.', teacherMainMenu());
  }

  if (session.flow === 'profile_edit' && session.step === 'full_name') {
    const fullName = sanitizeFullName(text);
    if (!fullName || fullName.length < 3) {
      return ctx.reply('Введіть коректне ПІБ (не менше 3 символів) або натисніть «Назад».');
    }

    const teacher = await findTeacherById(ctx.from.id);
    if (!teacher) {
      clearSession(ctx);
      return ctx.reply('Профіль викладача не знайдено.');
    }

    await query(
      'UPDATE teachers SET full_name = ?, updated_at = NOW() WHERE telegram_id = ?',
      [fullName, ctx.from.id]
    );
    await logAudit(ctx.from.id, 'teacher_name_updated', 'teachers', teacher.id, { full_name: teacher.full_name }, { full_name: fullName }, { source: 'profile' });

    const grades = await query(
      "SELECT gs.*, t.full_name AS teacher_name, t.verification_status AS teacher_status, t.telegram_id, t.phone AS teacher_phone, t.telegram_username AS teacher_username, t.telegram_display_name AS teacher_display_name, s.name AS subject_name, g.name AS group_name FROM grade_submissions gs JOIN teachers t ON t.id = gs.teacher_id JOIN subjects s ON s.id = gs.subject_id JOIN student_groups g ON g.id = gs.group_id WHERE gs.teacher_id = ? ORDER BY gs.id ASC",
      [teacher.id]
    );
    for (const grade of grades) {
      await syncGradeToGoogle({ ...grade, student_name: grade.student_name_snapshot });
    }

    clearSession(ctx);
    await ctx.reply('✅ ПІБ у профілі оновлено.');
    return showTeacherProfile(ctx);
  }

  if (session.flow === 'registration' && session.step === 'full_name') {
    const fullName = sanitizeFullName(text);
    if (!fullName || fullName.length < 3) {
      return ctx.reply('Введіть коректне прізвище та ініціали.');
    }

    await query('UPDATE teachers SET full_name = ?, verification_status = ?, updated_at = NOW() WHERE telegram_id = ?', [fullName, 'pending', ctx.from.id]);
    const teacher = await findTeacherById(ctx.from.id);
    await logAudit(ctx.from.id, 'teacher_name_updated', 'teachers', teacher.id, null, { full_name: fullName }, { source: 'bot' });
    await syncTeacherToGoogle({ ...teacher, full_name: fullName, verification_status: 'pending' });
    clearSession(ctx);
    return ctx.reply(`ПІБ збережено: ${fullName}. Тепер ви можете надсилати записи.`, teacherMainMenu());
  }

  if (session.flow === 'grade' && session.step === 'subject_name') {
    const subjectName = sanitizeFullName(text);
    if (subjectName.length < 2) return ctx.reply('Введіть коректну назву дисципліни.');
    session.subject_name = subjectName;
    session.step = 'semester';
    return ctx.reply(gradePrompt(session.step), gradeInputKeyboard());
  }

  if (session.flow === 'grade' && session.step === 'semester') {
    if (!/^[1-8]$/.test(text)) {
      return ctx.reply('Введіть номер семестру від 1 до 8.');
    }
    session.semester = text;
    session.step = 'student_name';
    return ctx.reply(gradePrompt(session.step), gradeInputKeyboard());
  }

  if (session.flow === 'grade' && session.step === 'student_name') {
    const studentName = sanitizeFullName(text);
    if (studentName.length < 3) return ctx.reply('Введіть коректне ПІБ студента.');
    session.student_name = studentName;
    session.step = 'group_name';
    return ctx.reply(gradePrompt(session.step), gradeInputKeyboard());
  }

  if (session.flow === 'grade' && session.step === 'group_name') {
    const groupName = sanitizeFullName(text);
    if (groupName.length < 2) return ctx.reply('Введіть коректну академічну групу.');
    session.group_name = groupName;
    session.step = 'grade_value';
    return ctx.reply(gradePrompt(session.step), gradeInputKeyboard());
  }

  if (session.flow === 'grade' && (session.step === 'grade_value' || session.step === 'edit_value')) {
    const field = session.step === 'edit_value' ? session.edit_field : 'grade_value';
    const value = field === 'grade_value' ? text : sanitizeFullName(text);
    if (field === 'grade_value') {
      const allowed = config.allowedGradeValues || ['2', '3', '4', '5', '12'];
      if (!allowed.includes(value)) {
        return ctx.reply(`Неприпустима оцінка. Дозволені значення: ${allowedGradeDescription()}.`);
      }
    } else if (field === 'semester') {
      if (!/^[1-8]$/.test(text)) {
        return ctx.reply('Введіть номер семестру від 1 до 8.');
      }
    } else if (value.length < (field === 'student_name' ? 3 : 2)) {
      return ctx.reply('Введіть коректне значення.');
    }
    session[field === 'grade_value' ? 'grade' : field] = value;
    if (session.step === 'edit_value') {
      session.step = 'edit_confirm';
      return ctx.reply(`Перевірте оновлений запис:\n${buildGradeSummary(session)}`, Markup.inlineKeyboard([
        [Markup.button.callback('✅ Зберегти зміни', 'grade_confirm')],
        [Markup.button.callback('↩️ Назад', 'grade_back')]
      ]));
    }
    session.step = 'confirm_grade';
    return ctx.reply(`Перевірте введені дані:\n${buildGradeSummary(session)}\n\nНапишіть «Назад», щоб виправити попереднє поле, або підтвердьте запис.`, gradeConfirmationKeyboard());
  }

  if (text === '/start' || text === '/profile') return bot.handleUpdate(ctx.update, ctx);
  if (text.startsWith('/')) return;
  if (!session.flow) return ctx.reply('Використовуйте кнопки меню або введіть /help.');
});

bot.action('cancel_grade', async (ctx) => {
  clearSession(ctx);
  await ctx.reply('Внесення оцінки скасовано.', teacherMainMenu());
});

bot.action('grade_back', async (ctx) => {
  const session = getSession(ctx);
  if (!session || !session.flow) {
    return ctx.reply('Немає активної сесії.');
  }

  if (session.edit_public_id) {
    if (session.step === 'edit_field_select') {
      clearSession(ctx);
      return displayTeacherDashboard(ctx);
    }
    session.step = 'edit_field_select';
    return ctx.reply('Оберіть, яке поле потрібно змінити:', editFieldsKeyboard());
  }

  if (session.step === 'subject_name') {
    clearSession(ctx);
    return ctx.reply('Повернулися до головного меню.', teacherMainMenu());
  }

  const previousSteps = {
    confirm_grade: 'grade_value',
    grade_value: 'group_name',
    group_name: 'student_name',
    student_name: 'semester',
    semester: 'subject_name'
  };
  session.step = previousSteps[session.step] || 'subject_name';
  return ctx.reply(gradePrompt(session.step), gradeInputKeyboard());
});

bot.action('grade_confirm', async (ctx) => {
  await finalizeGradeSubmission(ctx);
});

bot.action('grade_add_another', async (ctx) => {
  await startGradeSubmission(ctx);
});

bot.action('grade_my_records', async (ctx) => {
  await displayTeacherDashboard(ctx);
});

bot.action(/^edit_grade_([0-9a-f-]{36})$/, async (ctx) => {
  const teacher = await findTeacherById(ctx.from.id);
  if (!teacher) return ctx.reply('Спочатку завершіть реєстрацію через /start.');
  const rows = await query(
    'SELECT gs.*, s.name AS subject_name, g.name AS group_name FROM grade_submissions gs JOIN subjects s ON s.id = gs.subject_id JOIN student_groups g ON g.id = gs.group_id WHERE gs.public_id = ? AND gs.teacher_id = ?',
    [ctx.match[1], teacher.id]
  );
  if (!rows.length) return ctx.reply('Запис не знайдено або він більше вам недоступний.');

  const record = rows[0];
  const session = getSession(ctx);
  Object.assign(session, {
    flow: 'grade',
    step: 'edit_field_select',
    teacher_id: teacher.id,
    subject_name: record.subject_name,
    semester: record.semester,
    group_name: record.group_name,
    student_name: record.student_name_snapshot,
    grade: record.grade,
    edit_public_id: record.public_id
  });
  return ctx.reply(`Оберіть поле для редагування:\n${buildGradeSummary(session)}`, editFieldsKeyboard());
});

bot.action(/^grade_edit_field_(subject_name|semester|student_name|group_name|grade_value)$/, async (ctx) => {
  const session = getSession(ctx);
  if (!session.edit_public_id) return ctx.reply('Немає активного редагування запису.');
  session.edit_field = ctx.match[1];
  session.step = 'edit_value';
  if (session.edit_field === 'subject_name') {
    return ctx.reply(`Поточна дисципліна: ${session.subject_name}\nВведіть нову назву дисципліни.`, gradeInputKeyboard());
  }
  if (session.edit_field === 'semester') {
    return ctx.reply(`Поточний семестр: ${session.semester}\n${gradePrompt('semester')}`, gradeInputKeyboard());
  }
  const current = session[session.edit_field === 'grade_value' ? 'grade' : session.edit_field];
  const labels = { student_name: 'ПІБ студента', group_name: 'академічну групу', grade_value: 'оцінку' };
  const guidance = session.edit_field === 'grade_value'
    ? ` Дозволені значення: ${allowedGradeDescription()}.`
    : '';
  return ctx.reply(`Поточне значення (${labels[session.edit_field]}): ${current}\nВведіть нове значення.${guidance}`, gradeInputKeyboard());
});

bot.action('admin_new_registrations', async (ctx) => {
  if (!isAdmin(ctx.from.id)) {
    return ctx.reply('Доступ заборонено.');
  }
  const rows = await query('SELECT * FROM teachers WHERE verification_status = ? ORDER BY registered_at DESC LIMIT 10', ['pending']);
  if (!rows.length) {
    return ctx.reply('Немає нових реєстрацій.');
  }
  const text = rows.map((teacher) => `${teacher.id} | ${teacher.telegram_id} | ${teacher.phone || '—'} | ${teacher.full_name || '—'}`).join('\n');
  return ctx.reply(`Нові реєстрації:\n${text}`);
});

bot.action('admin_unverified_teachers', async (ctx) => {
  if (!isAdmin(ctx.from.id)) {
    return ctx.reply('Доступ заборонено.');
  }
  const rows = await query('SELECT * FROM teachers WHERE verification_status = ? ORDER BY registered_at DESC LIMIT 10', ['pending']);
  if (!rows.length) {
    return ctx.reply('Немає неперевірених викладачів.');
  }
  return ctx.reply(rows.map((teacher) => `${teacher.full_name || 'Без ПІБ'} (${teacher.telegram_id})`).join('\n'));
});

bot.action(/^teacher_verify_(\d+)$/, async (ctx) => {
  if (!isAdmin(ctx.from.id)) {
    return ctx.reply('Доступ заборонено.');
  }

  const teacherId = Number(ctx.match[1]);
  const teacher = (await query('SELECT * FROM teachers WHERE id = ?', [teacherId]))[0];
  if (!teacher) {
    return ctx.reply('Викладача не знайдено.');
  }

  const previousStatus = teacher.verification_status;
  await query('UPDATE teachers SET verification_status = ?, verified_by = ?, verified_at = NOW() WHERE id = ?', ['verified', String(ctx.from.id), teacherId]);
  await syncTeacherToGoogle({ ...teacher, verification_status: 'verified', verified_by: String(ctx.from.id), verified_at: new Date().toISOString().slice(0, 19).replace('T', ' ') });
  await logAudit(ctx.from.id, 'teacher_verified', 'teachers', teacherId, { verification_status: previousStatus }, { verification_status: 'verified', verified_by: String(ctx.from.id) }, { source: 'admin' });
  return ctx.reply(`Викладач підтверджений. ${teacher.full_name || '—'} тепер може надсилати оцінки.`);
});

bot.action(/^teacher_(approve|reject)_(\d+)$/, async (ctx) => {
  if (!isAdmin(ctx.from.id)) {
    return ctx.reply('Доступ заборонено.');
  }

  const action = ctx.match[1];
  const teacherId = Number(ctx.match[2]);
  const teacher = (await query('SELECT * FROM teachers WHERE id = ?', [teacherId]))[0];

  if (!teacher) {
    return ctx.reply('Викладача не знайдено.');
  }

  const finalStatus = action === 'approve' ? 'verified' : 'rejected';
  const previousStatus = teacher.verification_status;

  await query('UPDATE teachers SET verification_status = ?, verified_by = ?, verified_at = NOW() WHERE id = ?', [finalStatus, String(ctx.from.id), teacherId]);
  await syncTeacherToGoogle({ ...teacher, verification_status: finalStatus, verified_by: String(ctx.from.id), verified_at: new Date().toISOString().slice(0, 19).replace('T', ' ') });
  await logAudit(ctx.from.id, `teacher_${finalStatus}`, 'teachers', teacherId, { verification_status: previousStatus }, { verification_status: finalStatus, verified_by: String(ctx.from.id) }, { source: 'admin' });

  const message = finalStatus === 'verified'
    ? `Викладач підтверджений. ${teacher.full_name || '—'} now can submit grades.`
    : `Викладача відхилено. Нові оцінки для ${teacher.full_name || '—'} будуть блоковані.`;

  return ctx.reply(message);
});

bot.action('admin_latest_grades', async (ctx) => {
  if (!isAdmin(ctx.from.id)) {
    return ctx.reply('Доступ заборонено.');
  }
  const rows = await query('SELECT gs.public_id, t.full_name AS teacher_name, s.name AS subject_name, gs.student_name_snapshot, gs.grade, gs.secretary_status FROM grade_submissions gs JOIN teachers t ON t.id = gs.teacher_id JOIN subjects s ON s.id = gs.subject_id ORDER BY gs.submitted_at DESC LIMIT 10');
  if (!rows.length) {
    return ctx.reply('Останніх оцінок немає.');
  }
  return ctx.reply(rows.map((row) => `${row.teacher_name} | ${row.subject_name} | ${row.student_name_snapshot} | ${row.grade} | ${row.secretary_status}`).join('\n'));
});

bot.action('admin_sync_pending', async (ctx) => {
  if (!isAdmin(ctx.from.id)) {
    return ctx.reply('Доступ заборонено.');
  }
  return ctx.reply('Повторна синхронізація почата. Для повної реалізації потрібен серверний планувальник або окремий скрипт для повторного виклику API.');
});

bot.action('admin_cancel', async (ctx) => {
  await ctx.reply('Адміністративне меню закрито.', teacherMainMenu());
});

bot.catch((err, ctx) => {
  logger.error('Bot error', err);
  ctx.reply('Сталася помилка. Спробуйте ще раз або зверніться до адміністратора.');
});

if (!config.telegramToken) {
  logger.warn('TELEGRAM_TOKEN is empty, bot is not started.');
}

module.exports = bot;
