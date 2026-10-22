const SHEETS = {
  records: {
    name: 'Записи',
    headers: ['Telegram ID', 'Телефон', 'Telegram username', 'Ім’я у Telegram', 'ПІБ', 'Дисципліна', 'Семестр', 'ПІБ студента', 'Академічна група', 'Оцінка', 'Статус опрацювання', 'Коментар', '']
  }
};

const LEGACY_SHEETS = ['Викладачі', 'Оцінки', 'Журнал'];

function getProperty(name) {
  const value = PropertiesService.getScriptProperties().getProperty(name);
  if (!value) {
    throw new Error(`Set ${name} in Apps Script project properties.`);
  }
  return value;
}

function getOptionalProperty(name) {
  return PropertiesService.getScriptProperties().getProperty(name) || '';
}

function outputJson(payload) {
  return ContentService.createTextOutput(JSON.stringify(payload))
    .setMimeType(ContentService.MimeType.JSON);
}

function safeCell(value) {
  if (value === null || value === undefined) return '';
  if (typeof value !== 'string') return value;
  return /^[=+\-@]/.test(value) ? `'${value}` : value;
}

function getSpreadsheet() {
  const spreadsheet = SpreadsheetApp.openById(getProperty('SPREADSHEET_ID'));
  spreadsheet.setSpreadsheetTimeZone('Europe/Kyiv');
  return spreadsheet;
}

function ensureSheet(spreadsheet, definition) {
  let sheet = spreadsheet.getSheetByName(definition.name);
  if (!sheet) {
    sheet = spreadsheet.insertSheet(definition.name);
  }

  if (sheet.getLastRow() === 0) {
    sheet.getRange(1, 1, 1, definition.headers.length).setValues([definition.headers]);
    sheet.setFrozenRows(1);
  } else {
    const currentHeaders = sheet.getRange(1, 1, 1, definition.headers.length).getDisplayValues()[0];
    if (definition.headers.some((header, index) => currentHeaders[index] !== header)) {
      sheet.getRange(1, 1, 1, definition.headers.length).setValues([definition.headers]);
    }
    sheet.setFrozenRows(1);
  }

  if (definition.name === SHEETS.records.name) {
    const statusOptions = ['Очікує опрацювання', 'Опрацьовано', 'Потребує виправлення'];
    const statusRule = SpreadsheetApp.newDataValidation()
      .requireValueInList(statusOptions, true)
      .setAllowInvalid(false)
      .build();
    sheet.getRange(2, 11, sheet.getMaxRows() - 1, 1).setDataValidation(statusRule);
    sheet.getRange(2, 5, sheet.getMaxRows() - 1, 1).clearDataValidations();
    sheet.hideColumns(13);
  }

  return sheet;
}

function upsertById(sheet, id, values) {
  const lastRow = sheet.getLastRow();
  if (lastRow >= 2) {
    const ids = sheet.getRange(2, 13, lastRow - 1, 1).getDisplayValues();
    const index = ids.findIndex((row) => String(row[0]) === String(id));
    if (index >= 0) {
      sheet.getRange(index + 2, 1, 1, values.length).setValues([values.map(safeCell)]);
      return index + 2;
    }
  }

  const row = Math.max(lastRow + 1, 2);
  sheet.getRange(row, 1, 1, values.length).setValues([values.map(safeCell)]);
  return row;
}

function gradeRow(grade) {
  const secretaryStatus = {
    pending: 'Очікує опрацювання',
    read: 'Опрацьовано',
    needs_correction: 'Потребує виправлення'
  }[grade.secretary_status] || 'Очікує опрацювання';

  return [
    grade.telegram_id || '',
    grade.teacher_phone || '',
    grade.teacher_username ? `@${String(grade.teacher_username).replace(/^@/, '')}` : '',
    grade.teacher_display_name || '',
    grade.teacher_name || '',
    grade.subject_name || '',
    grade.semester || '',
    grade.student_name || '',
    grade.group_name || '',
    grade.grade || '',
    secretaryStatus,
    grade.correction_comment || '',
    `grade:${grade.public_id}`
  ];
}

function migrateLegacySheets(spreadsheet) {
  let records = spreadsheet.getSheetByName(SHEETS.records.name);
  if (records && records.getLastRow() > 1) {
    const oldHeaders = records.getRange(1, 1, 1, records.getLastColumn()).getDisplayValues()[0];
    if (oldHeaders[0] === 'ID запису' ||
        (oldHeaders[0] === 'Telegram ID' && oldHeaders[13] === 'ID запису')) {
      const oldRows = records.getRange(2, 1, records.getLastRow() - 1, records.getLastColumn()).getDisplayValues();
      records.clearContents();
      records.getRange(1, 1, 1, SHEETS.records.headers.length).setValues([SHEETS.records.headers]);
      oldRows.forEach((row) => {
        const oldSchema = oldHeaders[0] === 'ID запису';
        const isTeacher = oldSchema && row[1] === 'Викладач';
        const rawId = oldSchema ? String(row[0] || '') : String(row[13] || '');
        if (!rawId || isTeacher || rawId.startsWith('teacher:')) return;
        const id = oldSchema ? `grade:${rawId.replace(/^grade:/, '')}` : rawId;
        const values = oldSchema
          ? ['', '', '', '', row[3] || '', row[5] || '', row[6] || '', row[7] || '', row[8] || '', row[9] || '', row[10] || '', row[11] || '', id]
          : ['', row[2] || '', row[3] || '', row[4] || '', row[1] || '', row[5] || '', row[6] || '', row[7] || '', row[8] || '', row[9] || '', row[10] || '', row[11] || '', id];
        upsertById(records, id, values);
      });
    }
  }

  if (records && records.getLastRow() > 1) {
    const headers = records.getRange(1, 1, 1, records.getLastColumn()).getDisplayValues()[0];
    if (headers[0] === 'Telegram ID' && headers[1] === 'ПІБ') {
      const oldRows = records.getRange(2, 1, records.getLastRow() - 1, records.getLastColumn()).getDisplayValues();
      const movedStudentBeforeSubject = headers[5] === 'ПІБ студента';
      const reorderedRows = oldRows.map((row) => movedStudentBeforeSubject
        ? [row[0] || '', row[2] || '', row[3] || '', row[4] || '', row[1] || '', row[6] || '', row[7] || '', row[5] || '', ...row.slice(8, 13)]
        : [row[0] || '', row[2] || '', row[3] || '', row[4] || '', row[1] || '', ...row.slice(5, 13)]);
      records.clearContents();
      records.getRange(1, 1, 1, SHEETS.records.headers.length).setValues([SHEETS.records.headers]);
      records.getRange(2, 1, reorderedRows.length, SHEETS.records.headers.length).setValues(reorderedRows);
    }
  }

  if (records && records.getLastRow() > 1) {
    const headers = records.getRange(1, 1, 1, records.getLastColumn()).getDisplayValues()[0];
    if (headers[0] === 'Telegram ID' && headers[1] === 'Телефон' && headers[4] === 'ПІБ') {
      const rows = records.getRange(2, 1, records.getLastRow() - 1, SHEETS.records.headers.length).getDisplayValues();
      const correctedRows = rows.map((row) => {
        const oldPhone = String(row[2] || '').replace(/\D/g, '');
        const oldUsername = String(row[3] || '');
        const oldTeacherName = String(row[1] || '');
        const looksMisaligned = !/^\+?[\d\s()-]{7,}$/.test(oldTeacherName) &&
          ((oldPhone.length >= 7) || oldUsername.startsWith('@'));
        if (!looksMisaligned) return row;

        return [
          row[0] || '',
          row[2] || '',
          row[3] || '',
          row[4] || '',
          row[1] || '',
          row[6] || '',
          row[7] || '',
          row[5] || '',
          ...row.slice(8, 13)
        ];
      });
      if (correctedRows.some((row, index) => row.some((value, column) => value !== rows[index][column]))) {
        records.getRange(2, 1, correctedRows.length, SHEETS.records.headers.length).setValues(correctedRows);
      }
    }
  }

  records = ensureSheet(spreadsheet, SHEETS.records);
  const gradeStatuses = {
    'Очікує опрацювання': 'Очікує опрацювання',
    'Опрацьовано': 'Опрацьовано',
    'Потребує виправлення': 'Потребує виправлення'
  };

  const grades = spreadsheet.getSheetByName('Оцінки');
  if (grades && grades.getLastRow() > 1) {
    grades.getRange(2, 1, grades.getLastRow() - 1, Math.max(grades.getLastColumn(), 12)).getDisplayValues().forEach((row) => {
      if (!row[0]) return;
      upsertById(records, `grade:${row[0]}`, [
        '', '', '', '', row[2] || '', row[4] || '',
        '', row[6] || '', row[5] || '', row[7] || '',
        gradeStatuses[row[8]] || 'Очікує опрацювання', row[11] || '',
        `grade:${row[0]}`
      ]);
    });
  }

  LEGACY_SHEETS.forEach((name) => {
    const legacy = spreadsheet.getSheetByName(name);
    if (legacy) spreadsheet.deleteSheet(legacy);
  });

  spreadsheet.getSheets().forEach((sheet) => {
    if (sheet.getName() !== SHEETS.records.name && sheet.getLastRow() === 0 && spreadsheet.getSheets().length > 1) {
      spreadsheet.deleteSheet(sheet);
    }
  });
}

function doPost(e) {
  try {
    const request = JSON.parse(e.postData.contents || '{}');
    if (!request.secret || request.secret !== getProperty('SYNC_API_KEY')) {
      return outputJson({ ok: false, error: 'Unauthorized' });
    }

    if (request.action === 'syncTeacher' && request.record && request.record.id) {
      return outputJson({ ok: true, skipped: true });
    }

    const spreadsheet = getSpreadsheet();
    migrateLegacySheets(spreadsheet);

    let row;
    if (request.action === 'syncGrade' && request.record && request.record.public_id) {
      row = upsertById(spreadsheet.getSheetByName(SHEETS.records.name), `grade:${request.record.public_id}`, gradeRow(request.record));
    } else {
      return outputJson({ ok: false, error: 'Invalid action or record' });
    }

    return outputJson({ ok: true, row });
  } catch (error) {
    console.error(`Apps Script sync failed: ${error.message}`);
    return outputJson({ ok: false, error: 'Sync failed' });
  }
}

function apiUrl() {
  return getOptionalProperty('NODE_API_URL');
}

function sendTelegramNotification(chatId, message) {
  const token = getProperty('TELEGRAM_BOT_TOKEN');
  const response = UrlFetchApp.fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
    method: 'post',
    contentType: 'application/json',
    payload: JSON.stringify({ chat_id: chatId, text: message }),
    muteHttpExceptions: true
  });
  const result = JSON.parse(response.getContentText() || '{}');
  if (response.getResponseCode() < 200 || response.getResponseCode() >= 300 || !result.ok) {
    throw new Error(`Telegram notification failed: HTTP ${response.getResponseCode()} — ${result.description || response.getContentText()}`);
  }
}

function notificationText(sheet, row, column, value) {
  const subject = sheet.getRange(row, 6).getDisplayValue();
  const semester = sheet.getRange(row, 7).getDisplayValue();
  const student = sheet.getRange(row, 8).getDisplayValue();
  const grade = sheet.getRange(row, 10).getDisplayValue();
  const details = [
    subject ? `Дисципліна: ${subject}` : '',
    semester ? `Семестр: ${semester}` : '',
    student ? `Студент: ${student}` : '',
    grade ? `Оцінка: ${grade}` : ''
  ].filter(Boolean);

  if (column === 11) {
    return ['Оновлення щодо вашого запису:', ...details, `Статус опрацювання: ${value}`].join('\n');
  }
  return ['Коментар до вашого запису:', ...details, `Коментар: ${value || 'коментар видалено'}`].join('\n');
}

function reportManualEdit(e) {
  if (!e || !e.range || e.range.getRow() < 2) return;

  const sheet = e.range.getSheet();
  const sheetName = sheet.getName();
  const column = e.range.getColumn();
  const row = e.range.getRow();
  const recordId = sheet.getRange(row, 13).getDisplayValue();
  if (!recordId) return;

  let updates;
  if (sheetName === SHEETS.records.name && column === 11 && recordId.startsWith('grade:')) {
    const statuses = {
      'Очікує опрацювання': 'pending',
      'Опрацьовано': 'read',
      'Потребує виправлення': 'needs_correction'
    };
    const status = statuses[String(e.range.getDisplayValue()).trim()];
    if (!status) return;
    updates = {
      secretary_status: status
    };
  } else if (sheetName === SHEETS.records.name && column === 12 && recordId.startsWith('grade:')) {
    updates = { correction_comment: String(e.range.getValue() || '') };
  } else {
    return;
  }

  try {
    const nodeApiUrl = apiUrl();
    if (nodeApiUrl) {
      const response = UrlFetchApp.fetch(nodeApiUrl, {
        method: 'post',
        contentType: 'application/json',
        payload: JSON.stringify({ sheetName, recordId, updates }),
        headers: { 'x-api-key': getProperty('SYNC_API_KEY') },
        muteHttpExceptions: true
      });

      if (response.getResponseCode() < 200 || response.getResponseCode() >= 300) {
        throw new Error(`Node API rejected spreadsheet edit: HTTP ${response.getResponseCode()} — ${response.getContentText()}`);
      }
      return;
    }

    const telegramId = sheet.getRange(row, 1).getDisplayValue();
    if (!telegramId) throw new Error('Telegram ID is missing for this grade record.');
    sendTelegramNotification(telegramId, notificationText(sheet, row, column, e.range.getDisplayValue()));
  } catch (error) {
    if (e.oldValue !== undefined) e.range.setValue(e.oldValue);
    throw error;
  }

}

function createTriggers() {
  const spreadsheet = getSpreadsheet();
  migrateLegacySheets(spreadsheet);

  ScriptApp.getProjectTriggers().forEach((trigger) => {
    if (trigger.getHandlerFunction() === 'reportManualEdit') {
      ScriptApp.deleteTrigger(trigger);
    }
  });

  ScriptApp.newTrigger('reportManualEdit')
    .forSpreadsheet(spreadsheet)
    .onEdit()
    .create();
}
