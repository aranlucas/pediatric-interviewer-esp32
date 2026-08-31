import {
  ArrowLeft,
  BookOpenText,
  Download,
  FileJson,
  FileText,
  Globe2,
  ShieldCheck,
} from "lucide-react";
import Link from "next/link";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";

import { ReportLibraryList } from "@/components/report-library-list";
import type { CompletedReport, ReportDocumentKind } from "@/lib/reports";

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

export function ReportsConfigurationError() {
  return (
    <main className="report-library-gate">
      <section className="report-access-card" role="alert">
        <div className="report-access-icon"><ShieldCheck aria-hidden="true" /></div>
        <h1>Report library is not configured</h1>
        <p>
          The web service needs its R2 report binding before this page can be opened.
        </p>
        <Link className="report-gate-link" href="/">Return to the interviewer</Link>
      </section>
    </main>
  );
}

export function ReportsDisabled() {
  return (
    <main className="report-library-gate">
      <section className="report-access-card">
        <div className="report-access-icon"><ShieldCheck aria-hidden="true" /></div>
        <h1>Public report library is disabled</h1>
        <p>
          This deployment keeps completed interview reports private by default. Only a separately
          curated public archive can be enabled by its operator.
        </p>
        <div className="report-gate-actions">
          <Link className="report-gate-link" href="/">Return to the interviewer</Link>
          <Link className="report-gate-secondary-link" href="/privacy">Read privacy details</Link>
        </div>
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
          <Globe2 size={19} aria-hidden="true" />
          <p>
            This archive contains only reports deliberately copied into the public collection.
            Practice with fictional details; never include patient or identifying information.
            <Link href="/privacy">Read the privacy details.</Link>
          </p>
        </div>

        {reports.length ? (
          <ReportLibraryList
            reports={reports.map((report) => ({
              reportId: report.reportId,
              generatedAt: report.generatedAt,
              outcome: report.outcome,
              averageScore: report.averageScore,
              answeredQuestions: report.answeredQuestions,
              configuredQuestions: report.configuredQuestions,
              difficulty: report.difficulty,
              topicLabel: report.topicLabel,
              fileCount: Object.values(report.artifacts).filter(Boolean).length,
            }))}
            timezone={timezone}
          />
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
          <Link href="/">New interview</Link>
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
        </dl>
      </header>

      <section className="report-document-shell">
        <div className="report-scope-note report-detail-scope-note">
          <ShieldCheck size={19} aria-hidden="true" />
          <p>
            This is a curated public training artifact. Do not use real patient, child, guardian,
            or other identifying information in practice answers. <Link href="/privacy">Privacy and data use</Link>
          </p>
        </div>
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
              <Download size={16} aria-hidden="true" /> Download .md
            </a>
            <a href={`/api/report-library/${report.reportId}?kind=json`}>
              <FileJson size={16} aria-hidden="true" /> Download JSON
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
