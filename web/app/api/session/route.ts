import { getCloudflareContext } from "@opennextjs/cloudflare";
import { createSessionHandler } from "@/lib/session-handler";

export const dynamic = "force-dynamic";

export const POST = createSessionHandler(() => getCloudflareContext({ async: true }));
