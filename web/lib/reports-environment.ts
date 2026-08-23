import { getCloudflareContext } from "@opennextjs/cloudflare";

export const DEFAULT_REPORTS_TIMEZONE = "America/Los_Angeles";

export type ReportsEnv = CloudflareEnv & {
  INTERVIEW_REPORTS?: R2Bucket;
  REPORTS_TIMEZONE?: string;
};

export async function reportsEnvironment(): Promise<ReportsEnv | null> {
  try {
    const { env } = await getCloudflareContext({ async: true });
    return env as ReportsEnv;
  } catch {
    return null;
  }
}

export function reportsTimezone(env: ReportsEnv): string {
  const timezone = env.REPORTS_TIMEZONE?.trim() || DEFAULT_REPORTS_TIMEZONE;
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: timezone }).format();
    return timezone;
  } catch {
    return DEFAULT_REPORTS_TIMEZONE;
  }
}
