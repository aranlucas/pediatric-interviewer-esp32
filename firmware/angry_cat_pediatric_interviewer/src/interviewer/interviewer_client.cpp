#include "interviewer_client.h"

#include <ArduinoJson.h>
#include <ArduinoWebsockets.h>
#include <HTTPClient.h>
#include <WiFi.h>
#include <WiFiClientSecure.h>
#include <ctype.h>
#include <esp_heap_caps.h>
#include <esp_system.h>

#include "../audio/angry_cat_audio.h"

#if defined(ANGRY_CAT_SIMULATOR) && !defined(ANGRY_CAT_SIMULATOR_LIVE)
// Simulator builds must never inherit local production credentials. Network
// and state tests exercise the same safe not-configured guard used by a fresh
// checkout.
constexpr char kPediatricInterviewerWebSocketUrl[] = "";
constexpr char kPediatricInterviewerDeviceToken[] = "";
constexpr char kPediatricInterviewerRootCa[] = "";
#elif __has_include("interviewer_config.h")
#include "interviewer_config.h"
#elif __has_include("../../../../../waveshare_touch_demo/cloudflare_config.h")
#include "../../../../../waveshare_touch_demo/cloudflare_config.h"
#define kPediatricInterviewerWebSocketUrl kAngryCatWebSocketUrl
#define kPediatricInterviewerDeviceToken kAngryCatDeviceToken
#define kPediatricInterviewerRootCa kAngryCatRootCa
#else
constexpr char kPediatricInterviewerWebSocketUrl[] = "";
constexpr char kPediatricInterviewerDeviceToken[] = "";
constexpr char kPediatricInterviewerRootCa[] = "";
#endif

namespace {

constexpr uint32_t kCallStartupTimeoutMs = 20'000;
constexpr uint32_t kResponseTimeoutMs = 90'000;
constexpr uint32_t kSessionTimeoutMs = 30UL * 60UL * 1000UL;
constexpr uint32_t kAudioSampleRate = 24'000;
constexpr size_t kPcmChunkBytes = 960;
constexpr size_t kPlaybackBufferBytes = 192 * 1024;
constexpr size_t kPlaybackPrebufferBytes = 24 * 1024;
constexpr uint32_t kPlaybackPrebufferTimeoutMs = 750;
constexpr size_t kPlaybackFadeSamples = 120;
constexpr int32_t kSpeechRmsThreshold = 1'100;
constexpr uint8_t kSpeechStartFrames = 3;
constexpr uint32_t kAutomaticTurnSilenceMs = 5'000;
constexpr uint32_t kReportConnectTimeoutMs = 10'000;
constexpr uint32_t kReportResponseTimeoutMs = 15'000;
constexpr int kMaximumReportBytes = 128 * 1024;

class PcmRingBuffer {
public:
  explicit PcmRingBuffer(size_t capacity) : capacity_(capacity) {
    data_ = static_cast<uint8_t *>(
        heap_caps_malloc(capacity_, MALLOC_CAP_SPIRAM | MALLOC_CAP_8BIT));
  }

  ~PcmRingBuffer() {
    if (data_ != nullptr)
      heap_caps_free(data_);
  }

  PcmRingBuffer(const PcmRingBuffer &) = delete;
  PcmRingBuffer &operator=(const PcmRingBuffer &) = delete;

  bool isReady() const { return data_ != nullptr; }
  size_t size() const { return size_; }

  void clear() {
    readOffset_ = 0;
    writeOffset_ = 0;
    size_ = 0;
  }

  bool push(const uint8_t *input, size_t length) {
    if (input == nullptr || length > capacity_ - size_)
      return false;
    const size_t first = min(length, capacity_ - writeOffset_);
    memcpy(data_ + writeOffset_, input, first);
    if (first < length)
      memcpy(data_, input + first, length - first);
    writeOffset_ = (writeOffset_ + length) % capacity_;
    size_ += length;
    return true;
  }

  size_t pop(uint8_t *output, size_t capacity) {
    const size_t length = min(capacity, size_);
    if (output == nullptr || length == 0)
      return 0;
    const size_t first = min(length, capacity_ - readOffset_);
    memcpy(output, data_ + readOffset_, first);
    if (first < length)
      memcpy(output + first, data_, length - first);
    readOffset_ = (readOffset_ + length) % capacity_;
    size_ -= length;
    return length;
  }

private:
  uint8_t *data_ = nullptr;
  size_t capacity_ = 0;
  size_t readOffset_ = 0;
  size_t writeOffset_ = 0;
  size_t size_ = 0;
};

void fadePcmBoundary(uint8_t *data, size_t length, bool fadeIn, bool fadeOut) {
  if (data == nullptr || length < sizeof(int16_t))
    return;
  int16_t *samples = reinterpret_cast<int16_t *>(data);
  const size_t sampleCount = length / sizeof(int16_t);
  const size_t ramp = min(kPlaybackFadeSamples, sampleCount);
  if (ramp < 2)
    return;
  if (fadeIn) {
    for (size_t index = 0; index < ramp; ++index) {
      samples[index] = static_cast<int16_t>(
          static_cast<int32_t>(samples[index]) * index / (ramp - 1));
    }
  }
  if (fadeOut) {
    for (size_t index = 0; index < ramp; ++index) {
      const size_t sampleIndex = sampleCount - ramp + index;
      samples[sampleIndex] =
          static_cast<int16_t>(static_cast<int32_t>(samples[sampleIndex]) *
                               (ramp - 1 - index) / (ramp - 1));
    }
  }
}

bool containsSpeech(const uint8_t *data, size_t length) {
  if (data == nullptr || length < sizeof(int16_t))
    return false;
  const int16_t *samples = reinterpret_cast<const int16_t *>(data);
  const size_t sampleCount = length / sizeof(int16_t);
  uint64_t sumSquares = 0;
  for (size_t index = 0; index < sampleCount; ++index) {
    const int32_t sample = samples[index];
    sumSquares += static_cast<uint64_t>(sample * sample);
  }
  return sumSquares > static_cast<uint64_t>(kSpeechRmsThreshold) *
                          kSpeechRmsThreshold * sampleCount;
}

void postEvent(QueueHandle_t queue, InterviewerEventType type,
               const char *text = nullptr) {
  if (queue == nullptr)
    return;
  InterviewerEvent event;
  event.type = type;
  if (text != nullptr)
    snprintf(event.text, sizeof(event.text), "%s", text);
  xQueueSend(queue, &event, pdMS_TO_TICKS(20));
}

String interviewerUrl() {
  String url(kPediatricInterviewerWebSocketUrl);
  url.replace("/agents/angry-cat/", "/agents/pediatric-interviewer/");
  return url;
}

String newSessionUrl() {
  String url = interviewerUrl();
  char sessionName[24];
  snprintf(sessionName, sizeof(sessionName), "/esp32-%08lx",
           static_cast<unsigned long>(esp_random()));
  const int queryStart = url.indexOf('?');
  const int pathEnd = queryStart < 0 ? url.length() : queryStart;
  const int slash = url.lastIndexOf('/', pathEnd - 1);
  if (slash >= 0) {
    url = url.substring(0, slash) + sessionName + url.substring(pathEnd);
  }
  return url;
}

String reportUrl(const char *reportId) {
  String url = interviewerUrl();
  if (!url.startsWith("wss://"))
    return "";
  url = "https://" + url.substring(6);
  const int pathStart = url.indexOf('/', 8);
  if (pathStart >= 0)
    url.remove(pathStart);
  url += "/interviewer/reports/";
  url += reportId;
  url += ".json";
  return url;
}

bool validReportId(const char *value) {
  if (value == nullptr || strlen(value) != 36)
    return false;
  for (size_t index = 0; index < 36; ++index) {
    const bool separator =
        index == 8 || index == 13 || index == 18 || index == 23;
    if (separator ? value[index] != '-' : !isxdigit(value[index]))
      return false;
  }
  return true;
}

} // namespace

bool InterviewerClient::isConfigured() const {
  const char *rootCa = kPediatricInterviewerRootCa;
  rootCa += strspn(rootCa, " \t\r\n");
  return strncmp(kPediatricInterviewerWebSocketUrl, "wss://", 6) == 0 &&
         strlen(kPediatricInterviewerDeviceToken) >= 32 &&
         strncmp(rootCa, "-----BEGIN CERTIFICATE-----", 27) == 0;
}

void InterviewerClient::clearReport() {
  report_ = DeviceInterviewReport{};
  lastReportId_[0] = '\0';
}

bool InterviewerClient::fetchReport(const char *reportId,
                                    QueueHandle_t eventQueue) {
  report_ = DeviceInterviewReport{};
  if (!validReportId(reportId)) {
    postEvent(eventQueue, InterviewerEventType::ReviewUnavailable,
              "The saved report ID was invalid.");
    return false;
  }
  if (WiFi.status() != WL_CONNECTED) {
    postEvent(eventQueue, InterviewerEventType::ReviewUnavailable,
              "The review is saved, but Wi-Fi disconnected before it could be "
              "loaded.");
    return false;
  }

  postEvent(eventQueue, InterviewerEventType::ReviewLoading,
            "Loading your private review from R2.");
  WiFiClientSecure secureClient;
  secureClient.setCACert(kPediatricInterviewerRootCa);
  HTTPClient http;
  const String url = reportUrl(reportId);
  if (url.isEmpty() || !http.begin(secureClient, url)) {
    postEvent(eventQueue, InterviewerEventType::ReviewUnavailable,
              "Could not start the private report download.");
    return false;
  }
  http.setConnectTimeout(kReportConnectTimeoutMs);
  http.setTimeout(kReportResponseTimeoutMs);
  http.useHTTP10(true);
  http.addHeader("X-Device-Token", kPediatricInterviewerDeviceToken);
  const int status = http.GET();
  if (status != HTTP_CODE_OK) {
    char message[96];
    snprintf(message, sizeof(message),
             "The review is saved, but report download returned HTTP %d.",
             status);
    http.end();
    postEvent(eventQueue, InterviewerEventType::ReviewUnavailable, message);
    return false;
  }
  const int contentLength = http.getSize();
  if (contentLength > kMaximumReportBytes) {
    http.end();
    postEvent(eventQueue, InterviewerEventType::ReviewUnavailable,
              "The saved report was too large for the device review.");
    return false;
  }

  JsonDocument filter;
  filter["reportId"] = true;
  filter["topic"]["label"] = true;
  filter["evaluation"]["outcome"] = true;
  filter["evaluation"]["examinerSummary"] = true;
  filter["evaluation"]["scoreSummary"][0]["skillset"] = true;
  filter["evaluation"]["scoreSummary"][0]["skill"] = true;
  filter["evaluation"]["scoreSummary"][0]["score"] = true;
  filter["evaluation"]["scoreSummary"][0]["rationale"] = true;

  JsonDocument document;
  const DeserializationError jsonError = deserializeJson(
      document, http.getStream(), DeserializationOption::Filter(filter));
  http.end();
  if (jsonError) {
    char message[96];
    snprintf(message, sizeof(message), "Could not read the saved review: %s.",
             jsonError.c_str());
    postEvent(eventQueue, InterviewerEventType::ReviewUnavailable, message);
    return false;
  }

  const char *storedReportId = document["reportId"] | "";
  const char *domain = document["topic"]["label"] | "";
  const char *outcome = document["evaluation"]["outcome"] | "";
  const char *summary = document["evaluation"]["examinerSummary"] | "";
  JsonArrayConst scores =
      document["evaluation"]["scoreSummary"].as<JsonArrayConst>();
  if (strcmp(storedReportId, reportId) != 0 || domain[0] == '\0' ||
      outcome[0] == '\0' || summary[0] == '\0' || scores.size() == 0 ||
      scores.size() > kMaximumInterviewScores) {
    postEvent(eventQueue, InterviewerEventType::ReviewUnavailable,
              "The saved report was missing required review fields.");
    return false;
  }

  snprintf(report_.reportId, sizeof(report_.reportId), "%s", storedReportId);
  snprintf(report_.domain, sizeof(report_.domain), "%s", domain);
  snprintf(report_.outcome, sizeof(report_.outcome), "%s", outcome);
  snprintf(report_.examinerSummary, sizeof(report_.examinerSummary), "%s",
           summary);
  for (JsonObjectConst score : scores) {
    const char *skillset = score["skillset"] | "";
    const char *skill = score["skill"] | "";
    const char *rationale = score["rationale"] | "";
    const int value = score["score"] | 0;
    if (skillset[0] == '\0' || skill[0] == '\0' || rationale[0] == '\0' ||
        value < 1 || value > 3) {
      report_ = DeviceInterviewReport{};
      postEvent(eventQueue, InterviewerEventType::ReviewUnavailable,
                "The saved report contained an invalid score entry.");
      return false;
    }
    DeviceInterviewScore &destination = report_.scores[report_.scoreCount++];
    snprintf(destination.skillset, sizeof(destination.skillset), "%s",
             skillset);
    snprintf(destination.skill, sizeof(destination.skill), "%s", skill);
    destination.score = static_cast<uint8_t>(value);
    snprintf(destination.rationale, sizeof(destination.rationale), "%s",
             rationale);
  }
  report_.ready = true;
  snprintf(lastReportId_, sizeof(lastReportId_), "%s", storedReportId);
  Serial.printf("Interviewer report: loaded %u scores from %u-byte R2 JSON\n",
                report_.scoreCount,
                static_cast<unsigned>(max(contentLength, 0)));
  postEvent(eventQueue, InterviewerEventType::ReviewReady, report_.reportId);
  return true;
}

bool InterviewerClient::runSession(AngryCatAudio &audio, const char *topicId,
                                   QueueHandle_t eventQueue,
                                   std::atomic_bool &stopRequested,
                                   std::atomic_bool &commitTurnRequested) {
  using namespace websockets;
  clearReport();
  if (!isConfigured()) {
    postEvent(eventQueue, InterviewerEventType::Error,
              "Cloudflare interviewer is not configured.");
    return false;
  }
  if (!audio.isMicrophoneReady()) {
    postEvent(eventQueue, InterviewerEventType::Error,
              "The onboard microphone is unavailable.");
    return false;
  }

  bool connected = false;
  bool ready = false;
  bool microphoneActive = false;
  bool microphoneStartPending = false;
  bool serverComplete = false;
  bool spokeAfterComplete = false;
  bool complete = false;
  bool failed = false;
  bool closingLocally = false;
  bool assistantTranscript = false;
  bool receivedAudio = false;
  bool playbackStarted = false;
  bool playbackEnding = false;
  bool fadeInPlayback = false;
  uint32_t firstBufferedMs = 0;
  uint32_t playbackUnderruns = 0;
  bool candidateSpeechDetected = false;
  uint8_t consecutiveSpeechFrames = 0;
  uint32_t lastSpeechMs = 0;
  uint32_t stageStartedMs = millis();
  const uint32_t sessionStartedMs = millis();
  PcmRingBuffer playback(kPlaybackBufferBytes);
  if (!playback.isReady()) {
    postEvent(eventQueue, InterviewerEventType::Error,
              "Could not allocate the audio playback buffer.");
    return false;
  }

  WebsocketsClient client;
  client.setCACert(kPediatricInterviewerRootCa);
  client.addHeader("X-Device-Token", kPediatricInterviewerDeviceToken);
  client.onEvent([&](WebsocketsEvent event, String) {
    if (event == WebsocketsEvent::ConnectionOpened) {
      connected = true;
      postEvent(eventQueue, InterviewerEventType::Connected);
    } else if (event == WebsocketsEvent::ConnectionClosed && !complete &&
               !failed && !closingLocally) {
      failed = true;
      postEvent(eventQueue, InterviewerEventType::Error,
                "Cloudflare closed the interview connection.");
    }
  });
  client.onMessage([&](WebsocketsMessage message) {
    if (message.isBinary()) {
      microphoneActive = false;
      microphoneStartPending = false;
      const bool wasEmpty = playback.size() == 0;
      if (!playback.push(reinterpret_cast<const uint8_t *>(message.c_str()),
                         message.length())) {
        failed = true;
        postEvent(eventQueue, InterviewerEventType::Error,
                  "The interview audio buffer overflowed.");
      } else {
        if (wasEmpty)
          firstBufferedMs = millis();
        if (!receivedAudio) {
          receivedAudio = true;
          Serial.printf("Interviewer audio: buffering %lu Hz PCM frames (%u "
                        "bytes, %u-byte PSRAM queue, %u-byte prebuffer)\n",
                        static_cast<unsigned long>(kAudioSampleRate),
                        static_cast<unsigned>(message.length()),
                        static_cast<unsigned>(kPlaybackBufferBytes),
                        static_cast<unsigned>(kPlaybackPrebufferBytes));
        }
      }
      return;
    }
    if (!message.isText())
      return;

    JsonDocument document;
    if (deserializeJson(document, message.c_str(), message.length()) !=
        DeserializationError::Ok) {
      return;
    }
    const char *type = document["type"] | "";
    if (strcmp(type, "audio_config") == 0) {
      const char *format = document["format"] | "";
      const uint32_t sampleRate = document["sampleRate"] | 0;
      if (strcmp(format, "pcm16") != 0 || sampleRate != kAudioSampleRate) {
        failed = true;
        postEvent(eventQueue, InterviewerEventType::Error,
                  "The Worker and device audio formats do not match.");
      } else {
        Serial.printf("Interviewer audio: negotiated PCM16 at %lu Hz\n",
                      static_cast<unsigned long>(sampleRate));
      }
    } else if (strcmp(type, "status") == 0) {
      const char *status = document["status"] | "";
      stageStartedMs = millis();
      if (strcmp(status, "listening") == 0) {
        ready = true;
        playbackEnding = true;
        candidateSpeechDetected = false;
        consecutiveSpeechFrames = 0;
        lastSpeechMs = 0;
        if (serverComplete && spokeAfterComplete) {
          complete = true;
          microphoneActive = false;
          postEvent(eventQueue, InterviewerEventType::Complete);
        } else {
          microphoneStartPending = true;
        }
      } else if (strcmp(status, "thinking") == 0) {
        microphoneActive = false;
        microphoneStartPending = false;
        postEvent(eventQueue, InterviewerEventType::Thinking);
      } else if (strcmp(status, "evaluating") == 0) {
        microphoneActive = false;
        microphoneStartPending = false;
        postEvent(eventQueue, InterviewerEventType::Evaluating,
                  "Evaluating six answers and saving your review.");
      } else if (strcmp(status, "complete") == 0) {
        microphoneActive = false;
        microphoneStartPending = false;
        complete = true;
        postEvent(eventQueue, InterviewerEventType::Complete);
      } else if (strcmp(status, "speaking") == 0) {
        ready = true;
        playbackEnding = false;
        microphoneActive = false;
        microphoneStartPending = false;
        if (serverComplete)
          spokeAfterComplete = true;
        postEvent(eventQueue, InterviewerEventType::Speaking);
      }
    } else if (strcmp(type, "playback_interrupt") == 0) {
      playback.clear();
      playbackStarted = false;
      playbackEnding = false;
      fadeInPlayback = false;
      firstBufferedMs = 0;
      microphoneActive = false;
      microphoneStartPending = false;
      Serial.println("Interviewer audio: cancelled buffered playback");
    } else if (strcmp(type, "transcript") == 0 &&
               strcmp(document["role"] | "", "user") == 0) {
      postEvent(eventQueue, InterviewerEventType::CandidateTranscript,
                document["text"] | "");
    } else if (strcmp(type, "transcript_start") == 0) {
      assistantTranscript = strcmp(document["role"] | "", "assistant") == 0;
    } else if (strcmp(type, "transcript_end") == 0 && assistantTranscript) {
      assistantTranscript = false;
      postEvent(eventQueue, InterviewerEventType::InterviewerPrompt,
                document["text"] | "");
    } else if (strcmp(type, "interview_state") == 0) {
      InterviewerEvent event;
      event.type = InterviewerEventType::InterviewState;
      event.questionNumber = constrain(document["questionNumber"] | 0, 0, 255);
      event.totalQuestions = constrain(document["totalQuestions"] | 6, 1, 255);
      snprintf(event.phase, sizeof(event.phase), "%s", document["phase"] | "");
      snprintf(event.domain, sizeof(event.domain), "%s",
               document["domain"] | "");
      snprintf(event.text, sizeof(event.text), "%s", document["question"] | "");
      if (strcmp(event.phase, "complete") == 0)
        serverComplete = true;
      xQueueSend(eventQueue, &event, pdMS_TO_TICKS(20));
    } else if (strcmp(type, "metrics") == 0) {
      InterviewerEvent event;
      event.type = InterviewerEventType::Metrics;
      event.latencyMs = document["total_ms"] | 0;
      xQueueSend(eventQueue, &event, 0);
    } else if (strcmp(type, "interview_report") == 0) {
      InterviewerEvent event;
      event.type = InterviewerEventType::ReportReady;
      snprintf(event.phase, sizeof(event.phase), "%s",
               document["outcome"] | "");
      snprintf(event.text, sizeof(event.text), "%s", document["reportId"] | "");
      snprintf(lastReportId_, sizeof(lastReportId_), "%.36s", event.text);
      xQueueSend(eventQueue, &event, pdMS_TO_TICKS(20));
    } else if (strcmp(type, "error") == 0) {
      const char *message = document["message"] | "Cloudflare voice error.";
      const bool speechOnly = strstr(message, "Aura") != nullptr ||
                              strstr(message, "TTS") != nullptr ||
                              strstr(message, "neurons") != nullptr;
      if (speechOnly) {
        Serial.printf(
            "Interviewer audio unavailable; continuing text-only: %s\n",
            message);
        postEvent(
            eventQueue, InterviewerEventType::AudioUnavailable,
            "Speech quota unavailable; read the prompt and answer aloud.");
      } else {
        failed = true;
        postEvent(eventQueue, InterviewerEventType::Error, message);
      }
    }
  });

  const String url = newSessionUrl();
  if (!client.connect(url) || !connected) {
    postEvent(eventQueue, InterviewerEventType::Error,
              "Could not connect to Cloudflare voice.");
    return false;
  }
  Serial.printf("Interviewer: persistent voice connection open: %s\n",
                url.c_str());
  client.send("{\"type\":\"hello\",\"protocol_version\":1}");
  JsonDocument startCall;
  startCall["type"] = "start_call";
  startCall["preferred_format"] = "pcm16";
  startCall["topic_id"] = topicId == nullptr ? "behavior_guidance" : topicId;
  char startPayload[128];
  serializeJson(startCall, startPayload, sizeof(startPayload));
  client.send(startPayload);

  uint8_t pcm[kPcmChunkBytes];
  while (!complete && !failed && !stopRequested.load()) {
    client.poll();
    if (commitTurnRequested.exchange(false)) {
      if (microphoneActive) {
        microphoneActive = false;
        microphoneStartPending = false;
        candidateSpeechDetected = false;
        consecutiveSpeechFrames = 0;
        client.send("{\"type\":\"commit_turn\"}");
        postEvent(eventQueue, InterviewerEventType::Thinking,
                  "Answer committed. Waiting for Gemini Live.");
        stageStartedMs = millis();
      }
    }
    const uint32_t now = millis();
    if (!ready && now - sessionStartedMs > kCallStartupTimeoutMs) {
      failed = true;
      postEvent(eventQueue, InterviewerEventType::Error,
                "The voice session did not become ready.");
      continue;
    }
    if (ready && !microphoneActive &&
        now - stageStartedMs > kResponseTimeoutMs) {
      failed = true;
      postEvent(eventQueue, InterviewerEventType::Error,
                "The interviewer response timed out.");
      continue;
    }
    if (now - sessionStartedMs > kSessionTimeoutMs) {
      failed = true;
      postEvent(eventQueue, InterviewerEventType::Error,
                "The thirty-minute interview limit was reached.");
      continue;
    }
    if (!playbackStarted && playback.size() > 0 &&
        (playback.size() >= kPlaybackPrebufferBytes || playbackEnding ||
         now - firstBufferedMs >= kPlaybackPrebufferTimeoutMs)) {
      playbackStarted = true;
      fadeInPlayback = true;
    }
    if (playbackStarted && playback.size() > 0) {
      const bool finalChunk = playbackEnding && playback.size() <= sizeof(pcm);
      const size_t bytesToPlay = playback.pop(pcm, sizeof(pcm));
      fadePcmBoundary(pcm, bytesToPlay, fadeInPlayback, finalChunk);
      fadeInPlayback = false;
      if (bytesToPlay == 0 || !audio.playPcm16(pcm, bytesToPlay)) {
        failed = true;
        postEvent(eventQueue, InterviewerEventType::Error,
                  "Could not play the interviewer's speech.");
      }
      if (finalChunk) {
        playbackStarted = false;
        firstBufferedMs = 0;
      }
      continue;
    }
    if (playbackStarted && playback.size() == 0) {
      playbackStarted = false;
      fadeInPlayback = false;
      firstBufferedMs = 0;
      if (!playbackEnding) {
        ++playbackUnderruns;
        Serial.printf("Interviewer audio: jitter underrun %lu; rebuffering\n",
                      static_cast<unsigned long>(playbackUnderruns));
      }
    }
    if (microphoneStartPending) {
      microphoneStartPending = false;
      microphoneActive = true;
      postEvent(eventQueue, InterviewerEventType::Listening);
    }
    if (microphoneActive) {
      const size_t bytesRead = audio.readPcm16(pcm, sizeof(pcm));
      if (bytesRead == 0 ||
          !client.sendBinary(reinterpret_cast<const char *>(pcm), bytesRead)) {
        failed = true;
        postEvent(eventQueue, InterviewerEventType::Error,
                  "Could not stream microphone audio.");
      } else {
        const uint32_t audioNow = millis();
        if (containsSpeech(pcm, bytesRead)) {
          if (consecutiveSpeechFrames < kSpeechStartFrames) {
            ++consecutiveSpeechFrames;
          }
          if (consecutiveSpeechFrames >= kSpeechStartFrames) {
            if (!candidateSpeechDetected) {
              Serial.println(
                  "Interviewer microphone: candidate speech detected");
            }
            candidateSpeechDetected = true;
            lastSpeechMs = audioNow;
          }
        } else {
          consecutiveSpeechFrames = 0;
          if (candidateSpeechDetected &&
              audioNow - lastSpeechMs >= kAutomaticTurnSilenceMs) {
            microphoneActive = false;
            microphoneStartPending = false;
            candidateSpeechDetected = false;
            client.send("{\"type\":\"commit_turn\"}");
            postEvent(eventQueue, InterviewerEventType::Thinking,
                      "Pause detected. Waiting for Gemini Live.");
            stageStartedMs = audioNow;
            Serial.printf("Interviewer microphone: committed after %lu ms of "
                          "local silence\n",
                          static_cast<unsigned long>(kAutomaticTurnSilenceMs));
          }
        }
      }
    } else {
      delay(2);
    }
  }

  const bool stopped = stopRequested.load();
  if (client.available()) {
    closingLocally = true;
    client.send("{\"type\":\"end_call\"}");
    const uint32_t closeStartedMs = millis();
    while (client.available() && millis() - closeStartedMs < 120) {
      client.poll();
      delay(1);
    }
    client.close();
  }
  if (stopped)
    postEvent(eventQueue, InterviewerEventType::Stopped);
  Serial.printf("Interviewer: voice session %s\n",
                complete ? "complete" : (stopped ? "stopped" : "failed"));
  return complete || stopped;
}
