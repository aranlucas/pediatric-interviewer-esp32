export type EnvironmentContext<Env> = { env: Env };

export type ErrorResponse = { error: string };

export type SessionResponse = { expiresAt: number; room: string; token: string };

export type ReportRouteParams = { reportId: string };

export type ReportRouteContext = { params: Promise<ReportRouteParams> };
