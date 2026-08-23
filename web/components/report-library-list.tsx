"use client";

import { Search, X } from "lucide-react";
import Link from "next/link";
import { useMemo, useRef, useState } from "react";

import {
  formatReportCompletedAt,
  reportMatchesQuery,
  reportOutcomeLabel,
  reportScoreLabel,
  type ReportListItem,
} from "@/lib/report-search";

export function ReportLibraryList({
  reports,
  timezone,
}: {
  reports: ReportListItem[];
  timezone: string;
}) {
  const [query, setQuery] = useState("");
  const searchInputRef = useRef<HTMLInputElement>(null);
  const visibleReports = useMemo(
    () => reports.filter((report) => reportMatchesQuery(report, query, timezone)),
    [query, reports, timezone],
  );
  const clearSearch = () => {
    setQuery("");
    searchInputRef.current?.focus();
  };

  return (
    <>
      <div className="report-list-tools">
        <label className="report-search-field">
          <span>Find a report</span>
          <span className="report-search-control">
            <Search size={18} aria-hidden="true" />
            <input
              ref={searchInputRef}
              type="search"
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder="Search topic, outcome, date, or grade"
              autoComplete="off"
            />
            {query ? (
              <button type="button" onClick={clearSearch} aria-label="Clear report search">
                <X size={17} aria-hidden="true" />
              </button>
            ) : null}
          </span>
        </label>
        <p role="status" aria-live="polite">
          {query ? `${visibleReports.length} of ${reports.length}` : reports.length} reports
        </p>
      </div>

      {visibleReports.length ? (
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
              {visibleReports.map((report) => (
                <tr key={report.reportId}>
                  <td data-label="Completed">
                    <Link href={`/reports/${report.reportId}`}>
                      <strong>{formatReportCompletedAt(report.generatedAt, timezone)}</strong>
                      <span className="report-id">{report.reportId}</span>
                      <span className="report-open-label">Open report</span>
                    </Link>
                  </td>
                  <td data-label="Topic">
                    <strong>{report.topicLabel}</strong>
                    <span>{report.difficulty ?? "Unspecified difficulty"}</span>
                  </td>
                  <td className="report-score" data-label="Grade">
                    {reportScoreLabel(report.averageScore)}
                  </td>
                  <td data-label="Outcome">
                    <span className="report-outcome" data-outcome={report.outcome}>
                      {reportOutcomeLabel(report.outcome)}
                    </span>
                  </td>
                  <td data-label="Questions">
                    {report.answeredQuestions}/{report.configuredQuestions}
                  </td>
                  <td data-label="Files">
                    <span className="report-file-count">
                      {report.fileCount}
                    </span>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : (
        <div className="report-empty-state report-filter-empty">
          <Search aria-hidden="true" />
          <h2>No matching reports</h2>
          <p>Try another topic, outcome, date, or grade.</p>
          <button type="button" onClick={clearSearch}>Clear search</button>
        </div>
      )}
    </>
  );
}
