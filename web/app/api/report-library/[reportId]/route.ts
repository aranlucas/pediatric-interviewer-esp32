import { reportsEnvironment } from "@/lib/reports-environment";
import { createReportDownloadHandler } from "@/lib/report-download-handler";

export const dynamic = "force-dynamic";

export const GET = createReportDownloadHandler(reportsEnvironment);
