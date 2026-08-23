export type WorkerLogLevel = "info" | "warn" | "error";

/**
 * Emits one searchable Cloudflare Workers log record.
 *
 * `message` is intentionally the stable event name: Workers Observability
 * promotes that field into the log-list title. Keep `event` during the
 * transition so existing saved queries continue to work.
 */
export function workerLog(
  level: WorkerLogLevel,
  event: string,
  fields: Record<string, unknown> = {},
): void {
  const record = {
    ...fields,
    message: event,
    event,
  };
  if (level === "error") {
    console.error(record);
  } else if (level === "warn") {
    console.warn(record);
  } else {
    console.log(record);
  }
}
