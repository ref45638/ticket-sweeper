function timestamp() {
  return new Date().toISOString();
}

function formatArgs(args) {
  return args
    .map((a) => {
      if (a instanceof Error) return a.stack || a.message;
      if (typeof a === 'object') {
        try {
          return JSON.stringify(a);
        } catch {
          return String(a);
        }
      }
      return String(a);
    })
    .join(' ');
}

function log(level, tag, ...args) {
  const line = `[${timestamp()}] [${level}] [${tag}] ${formatArgs(args)}`;
  if (level === 'ERROR') {
    console.error(line);
  } else if (level === 'WARN') {
    console.warn(line);
  } else {
    console.log(line);
  }
}

module.exports = {
  info: (tag, ...args) => log('INFO', tag, ...args),
  warn: (tag, ...args) => log('WARN', tag, ...args),
  error: (tag, ...args) => log('ERROR', tag, ...args),
};
