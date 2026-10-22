const levels = ['info', 'warn', 'error', 'debug'];

function getTimestamp() {
  return new Date().toISOString();
}

function write(level, ...args) {
  if (!levels.includes(level)) {
    level = 'info';
  }

  console.log(`[${level.toUpperCase()}] ${getTimestamp()} -`, ...args);
}

module.exports = {
  info: (...args) => write('info', ...args),
  warn: (...args) => write('warn', ...args),
  error: (...args) => write('error', ...args),
  debug: (...args) => write('debug', ...args)
};
