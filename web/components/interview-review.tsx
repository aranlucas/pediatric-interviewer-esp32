"use client";

import {
  Activity,
  Check,
  ChevronLeft,
  ChevronRight,
  ClipboardCheck,
  RotateCcw,
  X,
} from "lucide-react";
import { useState } from "react";

import type { Evaluation, Score } from "@/lib/interview";
import {
  ConnectionIndicator,
  type ConnectionState,
} from "@/components/interview-controls";

type InterviewView = "topics" | "interview" | "review";

export function InterviewReview({
  view,
  evaluation,
  average,
  reviewItems,
  reviewPage,
  reviewPageCount,
  reportId,
  cheatsheetAvailable,
  questionCount,
  connectionState,
  canBuildAnother,
  onClose,
  onBuildAnother,
  onReviewPage,
}: {
  view: InterviewView;
  evaluation?: Evaluation;
  average: number | null;
  reviewItems: Score[];
  reviewPage: number;
  reviewPageCount: number;
  reportId: string;
  cheatsheetAvailable: boolean;
  questionCount: number;
  connectionState: ConnectionState;
  canBuildAnother: boolean;
  onClose: () => void;
  onBuildAnother: () => void;
  onReviewPage: (page: number) => void;
}) {
  const activeReview = reviewPage === 0 ? undefined : reviewItems[reviewPage - 1];
  const [downloading, setDownloading] = useState<"report" | "cheatsheet">();
  const [downloadError, setDownloadError] = useState("");

  const download = async (kind: "report" | "cheatsheet"): Promise<void> => {
    setDownloading(kind);
    setDownloadError("");
    try {
      const response = await fetch(
        `/api/reports/${encodeURIComponent(reportId)}?kind=${kind}`,
        { credentials: "same-origin", cache: "no-store" },
      );
      if (!response.ok) {
        throw new Error(
          response.status === 401
            ? "Your download session expired. Start a new interview to refresh it."
            : response.status === 404
              ? "That file is not available yet. Retry in a moment."
              : "The report could not be downloaded. Please retry.",
        );
      }
      const blob = await response.blob();
      const objectUrl = URL.createObjectURL(blob);
      const anchor = document.createElement("a");
      anchor.href = objectUrl;
      anchor.download = `angry-cat-${kind}-${reportId}.md`;
      document.body.appendChild(anchor);
      anchor.click();
      document.body.removeChild(anchor);
      queueMicrotask(() => URL.revokeObjectURL(objectUrl));
    } catch (downloadFailure) {
      setDownloadError(
        downloadFailure instanceof Error
          ? downloadFailure.message
          : "The report could not be downloaded. Please retry.",
      );
    } finally {
      setDownloading(undefined);
    }
  };

  return (
    <aside
      className={`review-rail ${view === "review" ? "mobile-visible" : ""}`}
      aria-label="Interview review"
    >
      <div className="review-header">
        <h2>Interview review</h2>
        <button type="button" className="mobile-close" onClick={onClose} aria-label="Close review">
          <X size={18} />
        </button>
      </div>

      {evaluation ? (
        <>
          <div className="outcome-card" data-outcome={evaluation.outcome}>
            <div className="outcome-ring"><Check size={27} /></div>
            <div>
              <strong>
                {evaluation.outcome === "pass"
                  ? "Pass"
                  : evaluation.outcome === "borderline"
                    ? "Borderline"
                    : "Not yet"}
              </strong>
              <p>Practice outcome based on this interview.</p>
            </div>
          </div>
          <div className="average-card">
            <Activity size={28} />
            <div><span>Practice average</span><strong>{average?.toFixed(1)} / 3</strong></div>
          </div>

          <div className="review-page-card">
            <div className="review-page-nav">
              <button
                type="button"
                aria-label="Previous review page"
                onClick={() => onReviewPage((reviewPage - 1 + reviewPageCount) % reviewPageCount)}
              ><ChevronLeft size={18} /></button>
              <span>Page {reviewPage + 1} of {reviewPageCount}</span>
              <button
                type="button"
                aria-label="Next review page"
                onClick={() => onReviewPage((reviewPage + 1) % reviewPageCount)}
              ><ChevronRight size={18} /></button>
            </div>
            {activeReview ? (
              <div className="score-detail">
                <span>{activeReview.skill.replaceAll("_", " ")}</span>
                <h3>{activeReview.skillset}</h3>
                <strong>{activeReview.score} / 3</strong>
                <p>{activeReview.rationale}</p>
              </div>
            ) : (
              <div className="summary-detail">
                <span>Examiner summary</span>
                <p>{evaluation.examinerSummary}</p>
              </div>
            )}
          </div>

          <div className="skill-list">
            <h3>Skill scores</h3>
            {reviewItems.map((score, index) => (
              <button
                type="button"
                key={`${score.skillset}-${index}`}
                onClick={() => onReviewPage(index + 1)}
                aria-label={`Review ${score.skillset}, score ${score.score} out of 3`}
                aria-pressed={reviewPage === index + 1}
              >
                <span>{score.skillset}</span>
                <i aria-hidden="true"><b style={{ width: `${(score.score / 3) * 100}%` }} /></i>
                <strong>{score.score} / 3</strong>
              </button>
            ))}
          </div>

          {reportId && (
            <div className="report-downloads">
              <div className="report-links">
                <button
                  type="button"
                  disabled={Boolean(downloading)}
                  onClick={() => void download("report")}
                >
                  {downloading === "report" ? "Preparing report…" : "Download full report"}
                </button>
              {cheatsheetAvailable && (
                  <button
                    type="button"
                    disabled={Boolean(downloading)}
                    onClick={() => void download("cheatsheet")}
                  >
                    {downloading === "cheatsheet" ? "Preparing sheet…" : "Download cheat sheet"}
                  </button>
              )}
              </div>
              {downloadError && <p className="report-download-error" role="alert">{downloadError}</p>}
            </div>
          )}
        </>
      ) : (
        <div className="empty-review">
          <div className="empty-review-icon"><ClipboardCheck /></div>
          <h3>Your review appears here</h3>
          <p>Complete the interview to get a practice outcome, examiner summary, and a score for every skillset. Completed feedback is published in Reports.</p>
          <ol>
            <li><span>1</span> Choose one or more study topics</li>
            <li><span>2</span> Answer {questionCount} questions aloud</li>
            <li><span>3</span> Review published feedback</li>
          </ol>
        </div>
      )}

      {evaluation && (
        <button type="button" className="new-interview-button" disabled={!canBuildAnother} onClick={onBuildAnother}>
          <RotateCcw size={18} /> Set up another case
        </button>
      )}
      <ConnectionIndicator state={connectionState} />
    </aside>
  );
}
