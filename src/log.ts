type Level = "info" | "warn" | "error" | "debug";

function emit(level: Level, msg: string, fields?: Record<string, unknown>) {
  const entry = {
    ts: new Date().toISOString(),
    level,
    msg,
    ...(fields ?? {}),
  };
  const line = JSON.stringify(entry);
  if (level === "error" || level === "warn") console.error(line);
  else console.log(line);
}

export const log = {
  info: (msg: string, fields?: Record<string, unknown>) => emit("info", msg, fields),
  warn: (msg: string, fields?: Record<string, unknown>) => emit("warn", msg, fields),
  error: (msg: string, fields?: Record<string, unknown>) => emit("error", msg, fields),
  debug: (msg: string, fields?: Record<string, unknown>) => {
    if (process.env.DISPATCH_DEBUG) emit("debug", msg, fields);
  },
};
