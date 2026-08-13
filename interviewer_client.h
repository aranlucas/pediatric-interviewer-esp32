#pragma once

#include <Arduino.h>
#include <atomic>
#include <freertos/FreeRTOS.h>
#include <freertos/queue.h>

class AngryCatAudio;

enum class InterviewerEventType : uint8_t {
  Connected,
  Listening,
  Thinking,
  Evaluating,
  Speaking,
  CandidateTranscript,
  InterviewerPrompt,
  InterviewState,
  Metrics,
  AudioUnavailable,
  ReportReady,
  ReviewLoading,
  ReviewReady,
  ReviewUnavailable,
  Complete,
  Stopped,
  Error,
};

constexpr uint8_t kMaximumInterviewScores = 6;

struct DeviceInterviewScore {
  char skillset[96] = {};
  char skill[24] = {};
  uint8_t score = 0;
  char rationale[320] = {};
};

struct DeviceInterviewReport {
  bool ready = false;
  char reportId[40] = {};
  char domain[64] = {};
  char outcome[16] = {};
  char examinerSummary[1024] = {};
  uint8_t scoreCount = 0;
  DeviceInterviewScore scores[kMaximumInterviewScores];
};

struct InterviewerEvent {
  InterviewerEventType type = InterviewerEventType::Connected;
  uint8_t questionNumber = 0;
  uint8_t totalQuestions = 6;
  uint32_t latencyMs = 0;
  char phase[16] = {};
  char domain[48] = {};
  char text[384] = {};
};

class InterviewerClient {
public:
  bool isConfigured() const;
  bool runSession(AngryCatAudio &audio, const char *topicId,
                  QueueHandle_t eventQueue, std::atomic_bool &stopRequested,
                  std::atomic_bool &commitTurnRequested);
  bool fetchReport(const char *reportId, QueueHandle_t eventQueue);
  const DeviceInterviewReport &report() const { return report_; }
  const char *lastReportId() const { return lastReportId_; }
  void clearReport();

private:
  DeviceInterviewReport report_;
  char lastReportId_[40] = {};
};
