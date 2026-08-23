import type { Metadata } from "next";

import { ReportLibraryIndex, ReportsConfigurationError } from "@/components/report-library";
import { listCompletedReports } from "@/lib/reports";
import { reportsEnvironment, reportsTimezone } from "@/lib/reports-environment";

export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: "Interview Reports · Angry Cat Oral Boards",
  description: "Public completed oral-board report library.",
};

export default async function ReportsPage() {
  const env = await reportsEnvironment();
  if (!env?.INTERVIEW_REPORTS) return <ReportsConfigurationError />;

  const reports = await listCompletedReports(env.INTERVIEW_REPORTS);
  return <ReportLibraryIndex reports={reports} timezone={reportsTimezone(env)} />;
}
