import type { Metadata } from "next";
import { cookies } from "next/headers";
import { notFound, redirect } from "next/navigation";

import {
  ReportLibraryDetail,
  ReportsConfigurationError,
} from "@/components/report-library";
import {
  configuredReportsSecret,
  REPORTS_ADMIN_COOKIE,
  reportsEnvironment,
  reportsTimezone,
  verifyReportsAdminToken,
} from "@/lib/reports-admin";
import {
  getCompletedReport,
  getReportMarkdown,
  type ReportDocumentKind,
} from "@/lib/reports";
import { isReportId } from "@/lib/server-auth";

export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: "Completed Report · Angry Cat Oral Boards",
};

type ReportPageProps = {
  params: Promise<{ reportId: string }>;
  searchParams: Promise<{ view?: string }>;
};

export default async function ReportPage({ params, searchParams }: ReportPageProps) {
  const [{ reportId }, { view }] = await Promise.all([params, searchParams]);
  if (!isReportId(reportId)) notFound();
  const kind: ReportDocumentKind = view === "cheatsheet" ? "cheatsheet" : "report";

  const env = await reportsEnvironment();
  const secret = configuredReportsSecret(env);
  if (!env?.INTERVIEW_REPORTS || !secret) return <ReportsConfigurationError />;

  const cookieStore = await cookies();
  if (!(await verifyReportsAdminToken(cookieStore.get(REPORTS_ADMIN_COOKIE)?.value, secret))) {
    redirect("/reports");
  }

  const [report, markdown] = await Promise.all([
    getCompletedReport(env.INTERVIEW_REPORTS, reportId),
    getReportMarkdown(env.INTERVIEW_REPORTS, reportId, kind),
  ]);
  if (!report || !markdown) notFound();
  return (
    <ReportLibraryDetail
      report={report}
      markdown={markdown}
      kind={kind}
      timezone={reportsTimezone(env)}
    />
  );
}
