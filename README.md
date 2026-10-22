# Teacher Grades Bot

This project implements a Telegram bot for university teachers to submit student grades. The data is stored in MySQL and synchronized to a Google Spreadsheet used by the secretary.

## Features

- Teacher registration via Telegram contact verification
- MySQL schema for teachers, subjects, groups, students, grade submissions, and audit log
- Grade submission workflow with validation and confirmation
- Teacher profile with editable full name and grade count
- Admin dashboard with approval and rejection controls
- Google Sheets synchronization with a protected API bridge
- PM2 ecosystem for 24/7 deployment on a server
- Rate limiting, retries, logging, validation, and safe error handling

## Project structure

- `database/schema.sql` — MySQL schema
- `src/index.js` — bot bootstrap
- `src/config.js` — environment configuration
- `src/db/mysql.js` — MySQL connection and query helpers
- `src/services/googleSheets.js` — Google Sheets integration
- `src/bot/` — bot command and conversation handlers
- `scripts/google-apps-script.js` — sample Apps Script for secure reverse sync
- `ecosystem.config.js` — PM2 configuration

## Local setup

1. Install Node.js 18+.
2. Create a MySQL database.
3. Copy `.env.example` to `.env` and fill in real values.
4. Run:

```powershell
npm install
```

5. Initialize the schema:

```powershell
mysql -u root -p < database\schema.sql
```

6. Start the bot locally:

```powershell
npm start
```

This local mode is for development and testing only. It does not provide 24/7 availability when the PC is shut down.

## Production / server deployment

Use a real Linux or Windows server with:

- a persistent MySQL database;
- an always-on environment;
- valid Telegram bot token;
- deployed Google Apps Script Web App URL and a Google Spreadsheet;
- PM2 installed globally.

```bash
npm install
pm2 start ecosystem.config.js
pm2 save
pm2 startup
```

## Security notes

- Keep tokens and secrets only in `.env`.
- Never log phone numbers, full student names, tokens, or API keys.
- Validate every Telegram input before writing to the database.
- Restrict admin commands to configured Telegram IDs.
- Do not depend on a local machine for 24/7 uptime.

## Google Apps Script

The included script in `scripts/google-apps-script.js` shows how to send manual secretary updates to your Node.js API after a row is edited in the spreadsheet. The server validates the payload, checks the record ID, confirms allowed fields, and only then updates the database.

## Free Google Sheets synchronization

This project uses Google Apps Script as the Sheets integration instead of Google Cloud service accounts or the Google Sheets API. No Google Cloud billing account, service-account key, or Google API key is needed. Google Apps Script and spreadsheet usage are subject to Google's free quotas and account/workspace policies; Google may change those limits.

1. Create a Google Spreadsheet.
2. Open **Extensions → Apps Script** and replace the editor contents with `scripts/google-apps-script.js`.
3. In Apps Script **Project Settings → Script Properties**, add:
   - `SPREADSHEET_ID` — the ID from the spreadsheet URL;
   - `TELEGRAM_BOT_TOKEN` — the Telegram bot token. Keep it in Script Properties; do not put it in the script source code.
   - `SYNC_API_KEY` — the same secret configured for the running bot; it protects incoming spreadsheet writes.
   - `NODE_API_URL` — optional. Set it only if the Node server is hosted publicly over HTTPS and should sync spreadsheet edits back to MySQL.
4. Run `createTriggers` once in Apps Script and authorize spreadsheet and external-request permissions. This installs the edit trigger and creates a dropdown for grade processing (`Очікує опрацювання`, `Опрацьовано`, `Потребує виправлення`).
5. Deploy the script as a **Web app**, executing as you. Set access to the broadest option permitted by your account (typically “Anyone”); requests are protected by `SYNC_API_KEY`. Copy the deployment URL ending in `/exec` to `GOOGLE_APPS_SCRIPT_URL` in `.env`.
6. Restart the bot. On first sync the script creates one `Записи` sheet with Telegram ID, name, phone, Telegram username (optional), Telegram display name, and resit details. It does not include registration date or teacher verification status. Running `createTriggers` migrates rows from the old sheets into `Записи` and removes the old sheets and `Журнал`.

Keep `TELEGRAM_BOT_TOKEN` and `SYNC_API_KEY` private in Apps Script Script Properties. A separately purchased server is not required for Telegram notifications: when `NODE_API_URL` is unset, the Apps Script edit trigger sends status and comment notifications directly through the Telegram Bot API. The teacher must have opened the bot at least once and must not have blocked it. To also save secretary edits back to MySQL, a Node server must be reachable at the public HTTPS `NODE_API_URL`; an app running only on a local computer cannot receive Google callbacks.

When the secretary changes a grade status or comment in the `Записи` sheet, the teacher receives a Telegram notification. If optional `NODE_API_URL` is configured, the edit also updates MySQL and the Node server sends the notification. Teachers can see statuses and edit an individual submission by selecting **Мої останні записи** in the bot. If a direct notification fails, inspect Apps Script **Executions**; for server-based synchronization, also inspect the server log.

If your existing MySQL database was created before these changes, apply any missing migrations in order before restarting: `database/migrations/001_add_teacher_google_sync_status.sql`, `database/migrations/002_add_teacher_telegram_display_name.sql`, `database/migrations/003_allow_teacher_without_phone.sql`, and `database/migrations/004_add_grade_semester.sql`. For a new database, `database/schema.sql` already includes these changes. After updating the Apps Script, run `createTriggers` and deploy a new Web App version so the live endpoint uses the consolidated sheet structure.

## License

This project is provided as an internal college utility and can be adapted to your organization’s rules.
