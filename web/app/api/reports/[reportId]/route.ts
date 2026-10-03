import { getCloudflareContext } from "@opennextjs/cloudflare";
import { createReportHandler } from "@/lib/report-handler";

export const dynamic = "force-dynamic";

export const GET = createReportHandler(() => getCloudflareContext({ async: true }));
