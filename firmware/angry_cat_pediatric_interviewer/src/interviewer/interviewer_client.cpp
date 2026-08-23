#include "interviewer_client.h"

#include <ArduinoJson.h>
#include <AudioTools/Concurrency/RTOS/BufferRTOS.h>
#include <AudioTools/CoreAudio/BaseStream.h>
#include <HTTPClient.h>
#include <WebSocketsClient.h>
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
constexpr uint32_t kPcmChunkDurationMs =
    kPcmChunkBytes * 1000 / (kAudioSampleRate * sizeof(int16_t));
constexpr size_t kNetworkPcmFrameBytes = 4'800;
// The Worker paces 4,800-byte frames at their 100 ms playback duration. This
// ring remains far smaller than the former 1 MiB queue. Real Gemini output can
// pause between generated speech segments, so playback starts with roughly one
// second of audio and retains headroom for incoming network frames.
constexpr size_t kPlaybackBufferBytes = 64 * 1024;
constexpr size_t kPlaybackPrebufferBytes = 48 * 1024;
constexpr uint32_t kPlaybackPrebufferTimeoutMs = 2'000;
constexpr size_t kPlaybackReceiveHighWaterBytes = 48 * 1024;
constexpr size_t kPlaybackReceiveLowWaterBytes = 24 * 1024;
constexpr size_t kPlaybackFadeSamples = 120;
constexpr BaseType_t kPlaybackTaskCore = 1;
constexpr UBaseType_t kPlaybackTaskPriority = 2;
constexpr uint32_t kPlaybackTaskStackBytes = 6'144;
constexpr int32_t kSpeechRmsThreshold = 1'100;
constexpr uint8_t kSpeechStartFrames = 3;
// Long enough to discard codec start-up noise, short enough that a one-word
// answer such as "yes" is not swallowed before speech detection sees it.
constexpr uint32_t kMicrophoneSettleMs = 120;
constexpr uint32_t kAutomaticTurnSilenceMs = 5'000;
constexpr uint8_t kDeviceQuestionCount = 6;
constexpr char kDeviceDifficulty[] = "standard";
constexpr uint32_t kReportConnectTimeoutMs = 10'000;
constexpr uint32_t kReportResponseTimeoutMs = 15'000;
constexpr int kMaximumReportBytes = 128 * 1024;
constexpr uint8_t kReportDownloadAttempts = 4;
constexpr uint32_t kReportRetryBaseDelayMs = 250;

static_assert(kPlaybackPrebufferBytes < kPlaybackBufferBytes);
static_assert(kPlaybackReceiveLowWaterBytes < kPlaybackReceiveHighWaterBytes);
static_assert(kPlaybackReceiveHighWaterBytes + kNetworkPcmFrameBytes <
              kPlaybackBufferBytes);
static_assert(kPcmChunkDurationMs == 20);

class PcmPlaybackQueue {
public:
  explicit PcmPlaybackQueue(size_t capacity)
      : allocator_(MALLOC_CAP_SPIRAM | MALLOC_CAP_8BIT),
        buffer_(capacity, 1, 0, 0, allocator_), stream_(buffer_) {
    stream_.begin();
  }

  PcmPlaybackQueue(const PcmPlaybackQueue &) = delete;
  PcmPlaybackQueue &operator=(const PcmPlaybackQueue &) = delete;

  bool isReady() { return static_cast<bool>(buffer_); }
  size_t size() { return static_cast<size_t>(stream_.available()); }
  size_t freeSpace() {
    return static_cast<size_t>(stream_.availableForWrite());
  }

  void clear() { buffer_.reset(); }

  bool push(const uint8_t *input, size_t length) {
    return input != nullptr && length <= freeSpace() &&
           stream_.write(input, length) == length;
  }

  size_t pop(uint8_t *output, size_t capacity) {
    return output == nullptr ? 0 : stream_.readBytes(output, capacity);
  }

private:
  audio_tools::AllocatorESP32 allocator_;
  audio_tools::BufferRTOS<uint8_t> buffer_;
  audio_tools::QueueStream<uint8_t> stream_;
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

void postEvent(QueueHandle_t queue, InterviewerEventType type,
               const char *text);

struct PlaybackTaskContext {
  AngryCatAudio *audio = nullptr;
  PcmPlaybackQueue *buffer = nullptr;
  QueueHandle_t eventQueue = nullptr;
  std::atomic_bool stop{false};
  std::atomic_bool exited{false};
  std::atomic_bool failed{false};
  std::atomic_bool started{false};
  std::atomic_bool ending{false};
  std::atomic_uint32_t firstBufferedMs{0};
  std::atomic_uint32_t underruns{0};
  std::atomic_size_t playedBytes{0};
};

void playbackTask(void *parameter) {
  auto &context = *static_cast<PlaybackTaskContext *>(parameter);
  uint8_t pcm[kPcmChunkBytes];
  bool fadeIn = false;
  TickType_t nextPlaybackWake = xTaskGetTickCount();

  while (!context.stop.load()) {
    const size_t bufferedBytes = context.buffer->size();
    const uint32_t firstBufferedMs = context.firstBufferedMs.load();
    if (!context.started.load() && bufferedBytes > 0 &&
        (bufferedBytes >= kPlaybackPrebufferBytes ||
         (firstBufferedMs != 0 &&
          millis() - firstBufferedMs >= kPlaybackPrebufferTimeoutMs))) {
      context.started.store(true);
      fadeIn = true;
      nextPlaybackWake = xTaskGetTickCount();
      Serial.printf("Interviewer audio: starting playback with %u buffered "
                    "bytes\n",
                    static_cast<unsigned>(bufferedBytes));
    }

    if (context.started.load() && bufferedBytes > 0) {
      const bool finalChunk =
          context.ending.load() && bufferedBytes <= sizeof(pcm);
      const size_t bytesToPlay = context.buffer->pop(pcm, sizeof(pcm));
      if (bytesToPlay == 0)
        continue;
      fadePcmBoundary(pcm, bytesToPlay, fadeIn, finalChunk);
      fadeIn = false;
      if (!context.audio->playPcm16(pcm, bytesToPlay)) {
        context.failed.store(true);
        postEvent(context.eventQueue, InterviewerEventType::Error,
                  "Could not play the interviewer's speech.");
        break;
      }
      context.playedBytes.fetch_add(bytesToPlay);
      // I2S writes can return as soon as DMA has accepted a chunk, which is
      // faster than the samples actually leave the speaker. Pace the producer
      // at the PCM duration so this task cannot race ahead and create its own
      // artificial underruns between Worker frames.
      vTaskDelayUntil(&nextPlaybackWake, pdMS_TO_TICKS(kPcmChunkDurationMs));
      if (finalChunk) {
        context.started.store(false);
        context.firstBufferedMs.store(0);
      }
      continue;
    }

    if (context.started.load() && bufferedBytes == 0) {
      context.started.store(false);
      fadeIn = false;
      context.firstBufferedMs.store(0);
      if (!context.ending.load()) {
        const uint32_t underruns = context.underruns.fetch_add(1) + 1;
        Serial.printf("Interviewer audio: jitter underrun %lu; rebuffering\n",
                      static_cast<unsigned long>(underruns));
      }
    }
    vTaskDelay(pdMS_TO_TICKS(1));
  }

  context.started.store(false);
  context.exited.store(true);
  vTaskDelete(nullptr);
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

#if defined(ANGRY_CAT_SIMULATOR)
bool InterviewerClient::runPlaybackBufferSelfTest() {
  constexpr size_t kTestFrameBytes = 4'800;
  constexpr size_t kTestFrameCount = 400;
  static uint8_t input[kTestFrameBytes];
  uint8_t output[kPcmChunkBytes];
  size_t inputOffset = 0;
  size_t outputOffset = 0;
  PcmPlaybackQueue playback(kPlaybackBufferBytes);
  if (!playback.isReady())
    return false;

  const auto drainChunk = [&]() {
    const size_t bytesRead = playback.pop(output, sizeof(output));
    if (bytesRead == 0)
      return false;
    for (size_t index = 0; index < bytesRead; ++index) {
      const uint8_t expected =
          static_cast<uint8_t>((outputOffset + index) & 0xff);
      if (output[index] != expected)
        return false;
    }
    outputOffset += bytesRead;
    return true;
  };

  for (size_t frame = 0; frame < kTestFrameCount; ++frame) {
    for (size_t index = 0; index < sizeof(input); ++index) {
      input[index] = static_cast<uint8_t>((inputOffset + index) & 0xff);
    }
    if (!playback.push(input, sizeof(input)))
      return false;
    inputOffset += sizeof(input);
    if ((frame + 1) % 10 == 0) {
      while (playback.size() > 0) {
        if (!drainChunk())
          return false;
      }
    }
  }
  while (playback.size() > 0) {
    if (!drainChunk())
      return false;
  }
  return outputOffset == inputOffset &&
         playback.freeSpace() == kPlaybackBufferBytes;
}
#endif

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
  const String url = reportUrl(reportId);
  if (url.isEmpty()) {
    postEvent(eventQueue, InterviewerEventType::ReviewUnavailable,
              "Could not start the private report download.");
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
  int contentLength = 0;
  bool downloaded = false;
  for (uint8_t attempt = 1; attempt <= kReportDownloadAttempts; ++attempt) {
    if (WiFi.status() != WL_CONNECTED) {
      postEvent(eventQueue, InterviewerEventType::ReviewUnavailable,
                "The review is saved, but Wi-Fi disconnected before it could "
                "be loaded.");
      return false;
    }

    WiFiClientSecure secureClient;
    secureClient.setCACert(kPediatricInterviewerRootCa);
    HTTPClient http;
    if (!http.begin(secureClient, url)) {
      Serial.printf("Interviewer report: attempt %u could not start HTTPS\n",
                    attempt);
    } else {
      http.setConnectTimeout(kReportConnectTimeoutMs);
      http.setTimeout(kReportResponseTimeoutMs);
      http.useHTTP10(true);
      http.addHeader("X-Device-Token", kPediatricInterviewerDeviceToken);
      const int status = http.GET();
      if (status == HTTP_CODE_OK) {
        contentLength = http.getSize();
        if (contentLength > kMaximumReportBytes) {
          http.end();
          postEvent(eventQueue, InterviewerEventType::ReviewUnavailable,
                    "The saved report was too large for the device review.");
          return false;
        }
        document.clear();
        const DeserializationError jsonError = deserializeJson(
            document, http.getStream(), DeserializationOption::Filter(filter));
        http.end();
        if (!jsonError) {
          downloaded = true;
          break;
        }
        Serial.printf("Interviewer report: attempt %u/%u returned %d bytes "
                      "with JSON error %s\n",
                      attempt, kReportDownloadAttempts, contentLength,
                      jsonError.c_str());
      } else {
        Serial.printf("Interviewer report: attempt %u/%u returned HTTP %d\n",
                      attempt, kReportDownloadAttempts, status);
        http.end();
        if (attempt == kReportDownloadAttempts) {
          char message[96];
          snprintf(message, sizeof(message),
                   "The review is saved, but report download returned HTTP "
                   "%d.",
                   status);
          postEvent(eventQueue, InterviewerEventType::ReviewUnavailable,
                    message);
          return false;
        }
      }
    }

    if (attempt < kReportDownloadAttempts) {
      const uint32_t retryDelayMs = kReportRetryBaseDelayMs << (attempt - 1);
      Serial.printf("Interviewer report: retrying in %lu ms\n",
                    static_cast<unsigned long>(retryDelayMs));
      delay(retryDelayMs);
    }
  }
  if (!downloaded) {
    postEvent(eventQueue, InterviewerEventType::ReviewUnavailable,
              "Could not read the complete saved review after four attempts.");
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
                                   std::atomic_bool &commitTurnRequested,
                                   QueueHandle_t simulatorTextAnswerQueue) {
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
  size_t peakPlaybackBytes = 0;
  size_t receivedPlaybackBytes = 0;
  uint32_t lastPlaybackFrameMs = 0;
  uint32_t maximumPlaybackFrameGapMs = 0;
  bool playbackReceivePaused = false;
  uint32_t playbackReceivePauseCycles = 0;
  bool candidateSpeechDetected = false;
  uint8_t consecutiveSpeechFrames = 0;
  uint32_t microphoneActivatedMs = 0;
  uint32_t lastSpeechMs = 0;
  uint32_t stageStartedMs = millis();
  const uint32_t sessionStartedMs = millis();
  const uint32_t playbackPsramCaps = MALLOC_CAP_SPIRAM | MALLOC_CAP_8BIT;
  const size_t freePsramBefore = heap_caps_get_free_size(playbackPsramCaps);
  const size_t largestPsramBefore =
      heap_caps_get_largest_free_block(playbackPsramCaps);
  PcmPlaybackQueue playback(kPlaybackBufferBytes);
  if (!playback.isReady()) {
    Serial.printf("Interviewer audio: could not allocate %u-byte PSRAM queue "
                  "(%u free, %u largest block)\n",
                  static_cast<unsigned>(kPlaybackBufferBytes),
                  static_cast<unsigned>(freePsramBefore),
                  static_cast<unsigned>(largestPsramBefore));
    postEvent(eventQueue, InterviewerEventType::Error,
              "Could not allocate the audio playback buffer.");
    return false;
  }
  Serial.printf(
      "Interviewer audio: allocated %u-byte PSRAM queue (%u free "
      "before, %u largest block, %u free after)\n",
      static_cast<unsigned>(kPlaybackBufferBytes),
      static_cast<unsigned>(freePsramBefore),
      static_cast<unsigned>(largestPsramBefore),
      static_cast<unsigned>(heap_caps_get_free_size(playbackPsramCaps)));

  PlaybackTaskContext playbackContext;
  playbackContext.audio = &audio;
  playbackContext.buffer = &playback;
  playbackContext.eventQueue = eventQueue;
  TaskHandle_t playbackTaskHandle = nullptr;
  uint8_t pcm[kPcmChunkBytes];

  WebSocketsClient client;
  client.onEvent([&](WStype_t event, uint8_t *payload, size_t length) {
    if (event == WStype_CONNECTED) {
      connected = true;
      postEvent(eventQueue, InterviewerEventType::Connected);
      return;
    }
    if (event == WStype_DISCONNECTED) {
      const bool wasConnected = connected;
      connected = false;
      if (wasConnected && !complete && !failed && !closingLocally) {
        failed = true;
        postEvent(eventQueue, InterviewerEventType::Error,
                  "Cloudflare closed the interview connection.");
      }
      return;
    }
    if (event == WStype_ERROR) {
      Serial.printf("Interviewer WebSocket error (%u bytes)\n",
                    static_cast<unsigned>(length));
      return;
    }
    if (event == WStype_BIN) {
      if (failed || stopRequested.load())
        return;
      const uint32_t frameReceivedMs = millis();
      if (lastPlaybackFrameMs != 0) {
        maximumPlaybackFrameGapMs = max(maximumPlaybackFrameGapMs,
                                        frameReceivedMs - lastPlaybackFrameMs);
      }
      lastPlaybackFrameMs = frameReceivedMs;
      microphoneActive = false;
      microphoneStartPending = false;
      const bool wasEmpty = playback.size() == 0;
      if (!playback.push(payload, length)) {
        failed = true;
        Serial.printf("Interviewer audio: protected queue rejected %u-byte "
                      "frame with %u bytes free (peak %u)\n",
                      static_cast<unsigned>(length),
                      static_cast<unsigned>(playback.freeSpace()),
                      static_cast<unsigned>(peakPlaybackBytes));
        postEvent(eventQueue, InterviewerEventType::Error,
                  "The interview audio buffer overflowed.");
      } else {
        receivedPlaybackBytes += length;
        peakPlaybackBytes = max(peakPlaybackBytes, playback.size());
        if (wasEmpty)
          playbackContext.firstBufferedMs.store(millis());
        if (!receivedAudio) {
          receivedAudio = true;
          Serial.printf("Interviewer audio: buffering %lu Hz PCM frames (%u "
                        "bytes, %u-byte PSRAM queue, %u-byte prebuffer)\n",
                        static_cast<unsigned long>(kAudioSampleRate),
                        static_cast<unsigned>(length),
                        static_cast<unsigned>(kPlaybackBufferBytes),
                        static_cast<unsigned>(kPlaybackPrebufferBytes));
        }
      }
      return;
    }
    if (event != WStype_TEXT)
      return;

    JsonDocument document;
    if (deserializeJson(document, payload, length) !=
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
        playbackContext.ending.store(true);
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
        playbackContext.ending.store(false);
        lastPlaybackFrameMs = 0;
        microphoneActive = false;
        microphoneStartPending = false;
        if (serverComplete)
          spokeAfterComplete = true;
        postEvent(eventQueue, InterviewerEventType::Speaking);
      }
    } else if (strcmp(type, "playback_interrupt") == 0) {
      playback.clear();
      playbackContext.started.store(false);
      playbackContext.ending.store(false);
      playbackContext.firstBufferedMs.store(0);
      microphoneActive = false;
      microphoneStartPending = false;
      Serial.println("Interviewer audio: cancelled buffered playback");
    } else if (strcmp(type, "candidate_text_ack") == 0) {
      const bool accepted = document["accepted"] | false;
      const bool turnComplete = document["turnComplete"] | false;
      Serial.printf("SIM_MIC: Worker %s typed answer; client turn complete=%s; "
                    "reason=%s\n",
                    accepted ? "accepted" : "rejected",
                    turnComplete ? "true" : "false",
                    document["reason"] | "none");
    } else if (strcmp(type, "turn_complete") == 0) {
      Serial.printf("Interviewer: Gemini turn complete; answer count=%u; next "
                    "question=%u\n",
                    static_cast<unsigned>(document["answerCount"] | 0),
                    static_cast<unsigned>(document["questionNumber"] | 0));
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
      event.answerCount = constrain(document["answerCount"] | 0, 0, 255);
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
  constexpr char kSecureWebSocketPrefix[] = "wss://";
  const int pathOffset = url.indexOf('/', strlen(kSecureWebSocketPrefix));
  if (!url.startsWith(kSecureWebSocketPrefix) || pathOffset < 0) {
    postEvent(eventQueue, InterviewerEventType::Error,
              "The Cloudflare voice URL is invalid.");
    return false;
  }
  const String host = url.substring(strlen(kSecureWebSocketPrefix), pathOffset);
  const String path = url.substring(pathOffset);
  String extraHeaders = "X-Device-Token: ";
  extraHeaders += kPediatricInterviewerDeviceToken;
  client.setExtraHeaders(extraHeaders.c_str());
  // WebSockets 2.7.2 leaves its optional client-certificate pointers
  // uninitialized when beginSslWithCA() is used on ESP32. This public entry
  // point initializes them explicitly while still performing ordinary
  // server-only CA verification.
  client.beginSslWithClientKey(host.c_str(), 443, path.c_str(),
                               kPediatricInterviewerRootCa, nullptr, nullptr,
                               "");
  client.enableHeartbeat(15000, 5000, 2);
  const uint32_t connectStartedMs = millis();
  while (!connected && !failed &&
         millis() - connectStartedMs < kCallStartupTimeoutMs) {
    client.loop();
    delay(1);
  }
  if (!connected) {
    closingLocally = true;
    client.disconnect();
    postEvent(eventQueue, InterviewerEventType::Error,
              "Could not connect to Cloudflare voice.");
    return false;
  }
  Serial.printf("Interviewer: persistent voice connection open: %s\n",
                url.c_str());
  if (xTaskCreatePinnedToCore(playbackTask, "interview-speaker",
                              kPlaybackTaskStackBytes, &playbackContext,
                              kPlaybackTaskPriority, &playbackTaskHandle,
                              kPlaybackTaskCore) != pdPASS) {
    closingLocally = true;
    client.disconnect();
    postEvent(eventQueue, InterviewerEventType::Error,
              "Could not start the audio playback task.");
    return false;
  }
  JsonDocument startCall;
  startCall["type"] = "start_call";
  startCall["preferred_format"] = "pcm16";
  startCall["topic_id"] = topicId == nullptr ? "behavior_guidance" : topicId;
  startCall["question_count"] = kDeviceQuestionCount;
  startCall["difficulty"] = kDeviceDifficulty;
  char startPayload[192];
  serializeJson(startCall, startPayload, sizeof(startPayload));
  client.sendTXT(startPayload);

  while (!complete && !failed && !playbackContext.failed.load() &&
         !stopRequested.load()) {
    const size_t queuedPlaybackBytes = playback.size();
    if (!playbackReceivePaused &&
        queuedPlaybackBytes >= kPlaybackReceiveHighWaterBytes) {
      playbackReceivePaused = true;
      ++playbackReceivePauseCycles;
      Serial.printf("Interviewer audio: pausing receive at %u queued bytes\n",
                    static_cast<unsigned>(queuedPlaybackBytes));
    } else if (playbackReceivePaused &&
               queuedPlaybackBytes <= kPlaybackReceiveLowWaterBytes) {
      playbackReceivePaused = false;
      Serial.printf("Interviewer audio: resuming receive at %u queued bytes\n",
                    static_cast<unsigned>(queuedPlaybackBytes));
    }
    if (!playbackReceivePaused)
      client.loop();
    if (commitTurnRequested.exchange(false)) {
      if (microphoneActive) {
        // A deliberate tap always ends the turn. Gating this on detected
        // speech strands the session whenever detection misses a short
        // answer, because the silence auto-commit below is gated the same
        // way and the candidate is then left with no way to continue.
        if (!candidateSpeechDetected)
          Serial.println("Interviewer microphone: committing tap before "
                         "speech was detected");
        microphoneActive = false;
        microphoneStartPending = false;
        candidateSpeechDetected = false;
        consecutiveSpeechFrames = 0;
        client.sendTXT("{\"type\":\"commit_turn\"}");
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
    if (microphoneStartPending && !playbackContext.started.load() &&
        playback.size() == 0) {
      microphoneStartPending = false;
      microphoneActive = true;
      microphoneActivatedMs = millis();
      postEvent(eventQueue, InterviewerEventType::Listening);
    }
    if (microphoneActive) {
#if defined(ANGRY_CAT_SIMULATOR_LIVE)
      SimulatorTextAnswer textAnswer;
      if (simulatorTextAnswerQueue != nullptr &&
          xQueueReceive(simulatorTextAnswerQueue, &textAnswer, 0) == pdTRUE) {
        JsonDocument textTurn;
        textTurn["type"] = "candidate_text";
        textTurn["text"] = textAnswer.text;
        char textPayload[kSimulatorTextAnswerBytes + 80];
        const size_t payloadLength =
            serializeJson(textTurn, textPayload, sizeof(textPayload));
        if (payloadLength == 0 || payloadLength >= sizeof(textPayload) - 1 ||
            !client.sendTXT(reinterpret_cast<uint8_t *>(textPayload),
                            payloadLength)) {
          failed = true;
          postEvent(eventQueue, InterviewerEventType::Error,
                    "Could not send the simulator text answer.");
        } else {
          microphoneActive = false;
          microphoneStartPending = false;
          candidateSpeechDetected = false;
          consecutiveSpeechFrames = 0;
          postEvent(eventQueue, InterviewerEventType::Thinking,
                    "Typed answer sent to Gemini Live.");
          stageStartedMs = millis();
          Serial.printf("SIM_MIC: sent typed answer (%u characters)\n",
                        static_cast<unsigned>(strlen(textAnswer.text)));
        }
        continue;
      }
#else
      (void)simulatorTextAnswerQueue;
#endif
      const size_t bytesRead = audio.readPcm16(pcm, sizeof(pcm));
      if (bytesRead == 0) {
        failed = true;
        postEvent(eventQueue, InterviewerEventType::Error,
                  "Could not read microphone audio.");
      } else {
        const uint32_t audioNow = millis();
        if (audioNow - microphoneActivatedMs < kMicrophoneSettleMs)
          continue;
        if (!client.sendBIN(pcm, bytesRead)) {
          failed = true;
          postEvent(eventQueue, InterviewerEventType::Error,
                    "Could not stream microphone audio.");
          continue;
        }
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
            client.sendTXT("{\"type\":\"commit_turn\"}");
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

  failed = failed || playbackContext.failed.load();
  const bool stopped = stopRequested.load();
  if (client.isConnected()) {
    closingLocally = true;
    client.sendTXT("{\"type\":\"end_call\"}");
    const uint32_t closeStartedMs = millis();
    while (client.isConnected() && millis() - closeStartedMs < 120) {
      client.loop();
      delay(1);
    }
    client.disconnect();
  }
  playbackContext.stop.store(true);
  const uint32_t playbackStopStartedMs = millis();
  while (!playbackContext.exited.load() &&
         millis() - playbackStopStartedMs < 1'000) {
    delay(1);
  }
  if (!playbackContext.exited.load() && playbackTaskHandle != nullptr) {
    vTaskDelete(playbackTaskHandle);
    playbackContext.exited.store(true);
  }
  if (stopped)
    postEvent(eventQueue, InterviewerEventType::Stopped);
  Serial.printf("Interviewer audio: received %u bytes; played %u bytes; peak "
                "%u of %u bytes; %lu underruns; max frame gap %lu ms; %lu "
                "flow-control cycles\n",
                static_cast<unsigned>(receivedPlaybackBytes),
                static_cast<unsigned>(playbackContext.playedBytes.load()),
                static_cast<unsigned>(peakPlaybackBytes),
                static_cast<unsigned>(kPlaybackBufferBytes),
                static_cast<unsigned long>(playbackContext.underruns.load()),
                static_cast<unsigned long>(maximumPlaybackFrameGapMs),
                static_cast<unsigned long>(playbackReceivePauseCycles));
  Serial.printf("Interviewer: voice session %s\n",
                complete ? "complete" : (stopped ? "stopped" : "failed"));
  return complete || stopped;
}
