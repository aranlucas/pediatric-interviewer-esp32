import type { Metadata } from "next";
import { notFound } from "next/navigation";

import {
  ReportLibraryDetail,
  ReportsConfigurationError,
} from "@/components/report-library";
import {
  getCompletedReport,
  getReportMarkdown,
  type ReportDocumentKind,
} from "@/lib/reports";
import {
  publicReportsEnabled,
  reportsEnvironment,
  reportsTimezone,
} from "@/lib/reports-environment";
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
  if (!env?.INTERVIEW_REPORTS) return <ReportsConfigurationError />;
  if (!publicReportsEnabled(env)) notFound();

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
