import type { Metadata } from "next";
import { cookies } from "next/headers";

import {
  ReportLibraryIndex,
  ReportsAccessGate,
  ReportsConfigurationError,
} from "@/components/report-library";
import {
  configuredReportsSecret,
  REPORTS_ADMIN_COOKIE,
  reportsEnvironment,
  reportsTimezone,
  verifyReportsAdminToken,
} from "@/lib/reports-admin";
import { listCompletedReports } from "@/lib/reports";

export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: "Interview Reports · Angry Cat Oral Boards",
  description: "Private completed oral-board report library.",
};

type ReportsPageProps = {
  searchParams: Promise<{ error?: string }>;
};

export default async function ReportsPage({ searchParams }: ReportsPageProps) {
  const env = await reportsEnvironment();
  const secret = configuredReportsSecret(env);
  if (!env?.INTERVIEW_REPORTS || !secret) return <ReportsConfigurationError />;

  const cookieStore = await cookies();
  const authenticated = await verifyReportsAdminToken(
    cookieStore.get(REPORTS_ADMIN_COOKIE)?.value,
    secret,
  );
  if (!authenticated) {
    const { error } = await searchParams;
    const safeError = ["configuration", "invalid", "rate-limited"].includes(error ?? "")
      ? (error as "configuration" | "invalid" | "rate-limited")
      : undefined;
    return <ReportsAccessGate error={safeError} />;
  }

  const reports = await listCompletedReports(env.INTERVIEW_REPORTS);
  return <ReportLibraryIndex reports={reports} timezone={reportsTimezone(env)} />;
}
