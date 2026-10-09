export type LogLevel = "debug" | "info" | "warn" | "error";
export type LogFields = Record<string, unknown>;

export interface Logger {
  debug(msg: string, fields?: LogFields): void;
  info(msg: string, fields?: LogFields): void;
  warn(msg: string, fields?: LogFields): void;
  error(msg: string, fields?: LogFields): void;
  /** A logger that stamps these fields (e.g. runId) on every line. */
  child(fields: LogFields): Logger;
}

export type LogWriter = (line: string, level: LogLevel) => void;

const defaultWriter: LogWriter = (line, level) => {
  (level === "error" || level === "warn" ? process.stderr : process.stdout).write(`${line}\n`);
};

/** Error details safe to log. Messages can contain model/provider text, never tutor notes. */
export function errorFields(err: unknown): LogFields {
  if (err instanceof Error) {
    const code = (err as { code?: unknown }).code;
    return {
      err: err.name, errMessage: err.message.slice(0, 500),
      ...(typeof code === "string" ? { errCode: code } : {}),
      ...(process.env.NODE_ENV === "production" ? {} : { stack: err.stack }),
    };
  }
  return { err: "NonError", errMessage: String(err).slice(0, 500) };
}

/**
 * Structured JSON logger (one object per line). Callers must never pass tutor notes, token maps,
 * names or contact details as fields; log ids and counts only.
 */
export function createLogger(base: LogFields = {}, write: LogWriter = defaultWriter): Logger {
  const emit = (level: LogLevel, msg: string, fields: LogFields = {}) =>
    write(JSON.stringify({ ts: new Date().toISOString(), level, msg, ...base, ...fields }), level);
  return {
    debug: (m, f) => emit("debug", m, f),
    info: (m, f) => emit("info", m, f),
    warn: (m, f) => emit("warn", m, f),
    error: (m, f) => emit("error", m, f),
    child: (fields) => createLogger({ ...base, ...fields }, write),
  };
}
