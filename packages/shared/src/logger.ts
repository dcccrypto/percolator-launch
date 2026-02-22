export type LogLevel = "debug" | "info" | "warn" | "error";

export interface LogContext {
  [key: string]: unknown;
}

export interface Logger {
  debug: (message: string, context?: LogContext) => void;
  info: (message: string, context?: LogContext) => void;
  warn: (message: string, context?: LogContext) => void;
  error: (message: string, context?: LogContext) => void;
}

interface LogEntry {
  timestamp: string;
  level: LogLevel;
  service: string;
  message: string;
  context?: LogContext;
}

const isProd = process.env.NODE_ENV === "production";

/**
 * Serialize a value for JSON logging.
 * Error objects are not JSON-serializable (their properties are non-enumerable),
 * so JSON.stringify(new Error("x")) produces "{}". This function extracts
 * message, name, stack, and cause into a plain object.
 */
function serializeValue(value: unknown): unknown {
  if (typeof value === "bigint") {
    return value.toString();
  }
  if (value instanceof Error) {
    const obj: Record<string, unknown> = {
      message: value.message,
      name: value.name,
    };
    if (value.stack) obj.stack = value.stack;
    if (value.cause) obj.cause = serializeValue(value.cause);
    // Capture any custom properties (e.g., code, statusCode)
    for (const key of Object.getOwnPropertyNames(value)) {
      if (!(key in obj)) {
        obj[key] = (value as unknown as Record<string, unknown>)[key];
      }
    }
    return obj;
  }
  return value;
}

/**
 * Walk a LogContext object and serialize any Error values found.
 */
function serializeContext(context: LogContext): LogContext {
  const result: LogContext = {};
  for (const [key, value] of Object.entries(context)) {
    result[key] = serializeValue(value);
  }
  return result;
}

/**
 * Format log entry for console output
 */
function formatPretty(entry: LogEntry): string {
  const timestamp = new Date(entry.timestamp).toISOString();
  const level = entry.level.toUpperCase().padEnd(5);
  const contextStr = entry.context ? ` ${JSON.stringify(entry.context)}` : "";
  
  return `[${timestamp}] ${level} [${entry.service}] ${entry.message}${contextStr}`;
}

/**
 * Create a structured logger for a service
 */
export function createLogger(service: string): Logger {
  function log(level: LogLevel, message: string, context?: LogContext) {
    const entry: LogEntry = {
      timestamp: new Date().toISOString(),
      level,
      service,
      message,
      context: context ? serializeContext(context) : undefined,
    };

    if (isProd) {
      // JSON output in production
      console.log(JSON.stringify(entry));
    } else {
      // Pretty output in development
      console.log(formatPretty(entry));
    }
  }

  return {
    debug: (message: string, context?: LogContext) => log("debug", message, context),
    info: (message: string, context?: LogContext) => log("info", message, context),
    warn: (message: string, context?: LogContext) => log("warn", message, context),
    error: (message: string, context?: LogContext) => log("error", message, context),
  };
}
