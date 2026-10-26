# Angry Cat interviewer feature roadmap

Updated 2026-10-26. Proposed study features after Digits/MCP priorities. This is
oral-board practice, not diagnosis, treatment advice or validated assessment.

## Starting point

Baseline `f59260acae9f614568d84ece9a3cb9d19818b74c`: the [project](README.md)
includes a web case setup, a six-question interview, a concise review, a Worker
and firmware for the Waveshare ESP32-S3-Touch-LCD-3.5B. Hardware, web and Worker
delivery are separate surfaces; passing JavaScript tests does not validate the
physical device or audio experience.

## Ordered releases

1. **Get from case setup to a completed device session.** Guide the learner
   through selecting the intended device, checking connection state, starting
   the chosen case and locating its final review. Acceptance: the active case
   and session identity agree on web/device; connection failure gives an
   actionable recovery path; another device cannot silently take over the run.
2. **Recover an interrupted interview.** Preserve the last acknowledged
   question/answer boundary and offer a deliberate resume or restart.
   Acceptance: reconnect does not duplicate an answer, create a second report
   or silently change the case; ended sessions stay ended; unavailable audio
   has a clear text or retry path supported by the actual clients.
3. **Practice the weakest part of the review.** Let the learner select a
   reviewed gap and run a short follow-up set with inspectable source references.
   Acceptance: feedback separates observed responses from generated judgments;
   unsupported or outdated content is flagged for review; no score is promoted
   to clinical correctness without an appropriate independent evaluation.
4. **Move a selected recap into the learner's study routine.** Provide a
   reviewed export of the session outline, chosen gap and follow-up references.
   Acceptance: show the selected contents before transfer, omit credentials,
   allow deletion, and define a versioned contract before integrating with
   Oral Boards. Similar topics do not establish shared progress or account IDs.

## First slice and evaluation

Start with one prepared synthetic case and one supported device. Observe time
to the first question, connection assistance, successful completion and whether
the learner can find a useful next practice action. Use voluntary observations
instead of collecting raw recordings or reports for analytics.

Use existing Worker/web Vitest suites for identity, acknowledgement and resume
boundaries; validate firmware with the native toolchain and physical hardware
before claiming a device release. Keep tokens and private reports outside Git.
Avoid expanding case generation until the complete study loop is dependable.
