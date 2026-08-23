import {
  ArrowLeft,
  BookOpenText,
  Download,
  FileJson,
  FileText,
  KeyRound,
  LogOut,
  ShieldCheck,
} from "lucide-react";
import Link from "next/link";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";

import type { CompletedReport, ReportDocumentKind } from "@/lib/reports";

type ReportsError = "configuration" | "invalid" | "rate-limited" | undefined;

function formatCompletedAt(value: string, timezone: string): string {
  return new Intl.DateTimeFormat("en-US", {
    timeZone: timezone,
    month: "short",
    day: "numeric",
    year: "numeric",
    hour: "numeric",
    minute: "2-digit",
    timeZoneName: "short",
  }).format(new Date(value));
}

function scoreLabel(score: number | null): string {
  if (score === null) return "—";
  return `${Number.isInteger(score) ? score.toFixed(0) : score.toFixed(1)}/3`;
}

function outcomeLabel(outcome: string): string {
  return outcome.replaceAll("_", " ");
}

function ReportsBrand({ detail = false }: { detail?: boolean }) {
  return (
    <Link className="report-library-brand" href={detail ? "/reports" : "/"}>
      <span className="brand-mark small" aria-hidden="true">AC</span>
      <span>
        <strong>Angry Cat</strong>
        <small>{detail ? "Report library" : "Oral Boards"}</small>
      </span>
    </Link>
  );
}

function SignOutButton() {
  return (
    <form action="/api/report-library/access?action=logout" method="post">
      <button className="report-library-signout" type="submit">
        <LogOut size={16} aria-hidden="true" />
        Sign out
      </button>
    </form>
  );
}

export function ReportsConfigurationError() {
  return (
    <main className="report-library-gate">
      <section className="report-access-card" role="alert">
        <div className="report-access-icon"><ShieldCheck aria-hidden="true" /></div>
        <h1>Report library is not configured</h1>
        <p>
          The web service needs its private R2 binding and a reports admin secret before this
          page can be opened.
        </p>
        <Link className="report-gate-link" href="/">Return to the interviewer</Link>
      </section>
    </main>
  );
}

export function ReportsAccessGate({ error }: { error: ReportsError }) {
  const errorMessage =
    error === "invalid"
      ? "That access key was not accepted."
      : error === "rate-limited"
        ? "Too many attempts. Wait a minute, then try again."
        : error === "configuration"
          ? "Report access is temporarily unavailable."
          : null;
  return (
    <main className="report-library-gate">
      <section className="report-access-card">
        <ReportsBrand />
        <div className="report-access-icon"><KeyRound aria-hidden="true" /></div>
        <h1>Private report library</h1>
        <p>
          Enter the operator access key to review every completed oral-board report stored in
          private R2.
        </p>
        <form action="/api/report-library/access" method="post" className="report-access-form">
          <label htmlFor="reports-access-key">Operator access key</label>
          <input
            id="reports-access-key"
            name="accessKey"
            type="password"
            autoComplete="current-password"
            required
            minLength={32}
          />
          {errorMessage ? <p className="report-access-error" role="alert">{errorMessage}</p> : null}
          <button type="submit">Open reports</button>
        </form>
        <p className="report-access-note">
          The key is exchanged for a short-lived, HttpOnly admin session and is never stored in
          browser JavaScript.
        </p>
      </section>
    </main>
  );
}

export function ReportLibraryIndex({
  reports,
  timezone,
}: {
  reports: CompletedReport[];
  timezone: string;
}) {
  return (
    <main className="report-library-shell">
      <nav className="report-library-nav" aria-label="Report library navigation">
        <ReportsBrand />
        <div className="report-library-nav-actions">
          <Link href="/">New interview</Link>
          <SignOutButton />
        </div>
      </nav>

      <header className="report-library-header">
        <div>
          <h1>Interview reports</h1>
          <p>Every completed evaluation, with its scored review and study aid in one place.</p>
        </div>
        <div className="report-count" aria-label={`${reports.length} completed reports`}>
          <strong>{reports.length}</strong>
          <span>completed</span>
        </div>
      </header>

      <section className="report-library-content">
        <div className="report-scope-note">
          <ShieldCheck size={19} aria-hidden="true" />
          <p>
            This is the completed-report index. Runs that never reached evaluation have no R2
            report and are not shown as scored.
          </p>
        </div>

        {reports.length ? (
          <div className="report-table-wrap">
            <table className="report-table">
              <thead>
                <tr>
                  <th scope="col">Completed</th>
                  <th scope="col">Topic</th>
                  <th scope="col">Grade</th>
                  <th scope="col">Outcome</th>
                  <th scope="col">Questions</th>
                  <th scope="col">Files</th>
                </tr>
              </thead>
              <tbody>
                {reports.map((report) => (
                  <tr key={report.reportId}>
                    <td>
                      <Link href={`/reports/${report.reportId}`}>
                        <strong>{formatCompletedAt(report.generatedAt, timezone)}</strong>
                        <span>{report.reportId}</span>
                      </Link>
                    </td>
                    <td>
                      <strong>{report.topicLabel}</strong>
                      <span>{report.difficulty ?? "Unspecified difficulty"}</span>
                    </td>
                    <td className="report-score">{scoreLabel(report.averageScore)}</td>
                    <td>
                      <span className="report-outcome" data-outcome={report.outcome}>
                        {outcomeLabel(report.outcome)}
                      </span>
                    </td>
                    <td>{report.answeredQuestions}/{report.configuredQuestions}</td>
                    <td>
                      <span className="report-file-count">
                        {Object.values(report.artifacts).filter(Boolean).length}
                      </span>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <div className="report-empty-state">
            <BookOpenText aria-hidden="true" />
            <h2>No completed reports yet</h2>
            <p>Finish an interview and its scored review will appear here.</p>
            <Link href="/">Start an interview</Link>
          </div>
        )}
      </section>
    </main>
  );
}

export function ReportLibraryDetail({
  report,
  markdown,
  kind,
  timezone,
}: {
  report: CompletedReport;
  markdown: string;
  kind: ReportDocumentKind;
  timezone: string;
}) {
  const activeDownload = `/api/report-library/${report.reportId}?kind=${kind}`;
  return (
    <main className="report-library-shell report-detail-shell">
      <nav className="report-library-nav" aria-label="Report navigation">
        <ReportsBrand detail />
        <div className="report-library-nav-actions">
          <SignOutButton />
        </div>
      </nav>

      <header className="report-detail-header">
        <Link className="report-back-link" href="/reports">
          <ArrowLeft size={18} aria-hidden="true" /> All reports
        </Link>
        <div className="report-detail-title">
          <div>
            <h1>{report.topicLabel}</h1>
            <p>{formatCompletedAt(report.generatedAt, timezone)} · {report.reportId}</p>
          </div>
          <div className="report-detail-grade">
            <strong>{scoreLabel(report.averageScore)}</strong>
            <span>{outcomeLabel(report.outcome)}</span>
          </div>
        </div>
        <dl className="report-detail-meta">
          <div><dt>Questions</dt><dd>{report.answeredQuestions}/{report.configuredQuestions}</dd></div>
          <div><dt>Difficulty</dt><dd>{report.difficulty ?? "—"}</dd></div>
          <div><dt>Session</dt><dd>{report.sessionId ?? "—"}</dd></div>
          <div><dt>Evaluator</dt><dd>{report.evaluatorModel ?? "—"}</dd></div>
        </dl>
      </header>

      <section className="report-document-shell">
        <div className="report-document-toolbar">
          <div className="report-document-tabs" role="navigation" aria-label="Report documents">
            <Link data-active={kind === "report"} href={`/reports/${report.reportId}?view=report`}>
              <FileText size={17} aria-hidden="true" /> Scored report
            </Link>
            {report.artifacts.cheatsheet ? (
              <Link
                data-active={kind === "cheatsheet"}
                href={`/reports/${report.reportId}?view=cheatsheet`}
              >
                <BookOpenText size={17} aria-hidden="true" /> Study aid
              </Link>
            ) : null}
          </div>
          <div className="report-document-downloads">
            <a href={activeDownload}>
              <Download size={16} aria-hidden="true" /> Markdown
            </a>
            <a href={`/api/report-library/${report.reportId}?kind=json`}>
              <FileJson size={16} aria-hidden="true" /> JSON
            </a>
          </div>
        </div>
        <article className="report-markdown">
          <ReactMarkdown remarkPlugins={[remarkGfm]}>{markdown}</ReactMarkdown>
        </article>
      </section>
    </main>
  );
}
