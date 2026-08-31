#include <Arduino.h>
#include <Arduino_GFX_Library.h>
#include <Preferences.h>
#include <TCA9554.h>
#include <WiFi.h>
#include <WiFiManager.h>
#include <Wire.h>
#include <atomic>
#include <freertos/FreeRTOS.h>
#include <freertos/queue.h>
#include <freertos/task.h>
#include <time.h>
#if defined(ANGRY_CAT_SIMULATOR_LIVE)
#include <esp_task_wdt.h>
#endif
// Simulator builds stage this fixture beside a generated copy of the sketch.
// Its implementation and test assets stay outside the production source tree.
#if __has_include(<AngryCatSimulator.h>)
#include <AngryCatSimulator.h>
#endif

#include "src/audio/angry_cat_audio.h"
#include "src/companion/cat_companion.h"
#include "src/generated/angry_cat_frames.h"
#include "src/interviewer/interviewer_client.h"
#include <esp_lcd_touch_axs15231b.h>

namespace {

constexpr uint16_t kScreenWidth = 320;
constexpr uint16_t kScreenHeight = 480;
constexpr int kI2cSda = 8;
constexpr int kI2cScl = 7;
constexpr int kLcdCs = 12;
constexpr int kLcdClock = 5;
constexpr int kLcdData0 = 1;
constexpr int kLcdData1 = 2;
constexpr int kLcdData2 = 3;
constexpr int kLcdData3 = 4;
constexpr int kBacklight = 6;
constexpr uint8_t kIoExpanderAddress = 0x20;
constexpr uint8_t kLcdResetExpanderPin = 1;
constexpr uint8_t kI2cStartupAttempts = 10;
constexpr uint32_t kI2cStartupRetryMs = 100;
constexpr uint32_t kLongPressMs = 2500;
constexpr uint32_t kTouchReleaseDebounceMs = 100;
// The only user button on this board is BOOT on GPIO0; RESET and PWR are wired
// to the enable line and the power management IC and cannot be read in
// software. It idles high through the SoC pull-up and reads LOW when pressed.
constexpr int kBootButtonPin = 0;
constexpr uint32_t kButtonDebounceMs = 40;
// One button carries both actions, so a press is only a volume step once it is
// released short of the hold threshold.
constexpr uint32_t kButtonHoldMs = 1200;
constexpr uint32_t kVolumeOverlayMs = 1500;
constexpr char kSettingsNamespace[] = "angrycat";
constexpr char kVolumeSettingKey[] = "volume";
constexpr int kPetX = (kScreenWidth - kAngryCatFrameWidth) / 2;
constexpr int kPetY = 8;

constexpr uint16_t kWhite = 0xFFFF;
constexpr uint16_t kSoftWhite = 0xD69A;
constexpr uint16_t kInk = 0x2149;
constexpr uint16_t kPetCard = 0x29AB;
constexpr uint16_t kListening = 0x4E69;
constexpr uint16_t kThinking = 0xFD20;
constexpr uint16_t kSpeaking = 0x8E7F;
constexpr uint16_t kError = 0xF986;

#if defined(ANGRY_CAT_SIMULATOR)
Arduino_Canvas display(kScreenWidth, kScreenHeight, nullptr, 0, 0, 0);
#else
Arduino_ESP32QSPI displayBus(kLcdCs, kLcdClock, kLcdData0, kLcdData1, kLcdData2,
                             kLcdData3);
Arduino_AXS15231B panel(&displayBus, GFX_NOT_DEFINED, 0, false, kScreenWidth,
                        kScreenHeight);
Arduino_Canvas display(kScreenWidth, kScreenHeight, &panel, 0, 0, 0);
#endif
TCA9554 ioExpander(kIoExpanderAddress, &Wire);
AngryCatAudio audio;
InterviewerClient interviewer;
CatCompanion companion;

void primeAudioDuringWifi(void *parameter) {
  auto *audioDevice = static_cast<AngryCatAudio *>(parameter);
  const bool primed = audioDevice != nullptr && audioDevice->primePlayback();
  Serial.printf("Audio: speaker prime during Wi-Fi setup %s\n",
                primed ? "complete" : "failed");
  vTaskDelete(nullptr);
}

using TouchPoint = coords_t;

QueueHandle_t eventQueue = nullptr;
std::atomic_bool stopRequested = false;
std::atomic_bool commitTurnRequested = false;
std::atomic_bool sessionTaskRunning = false;
bool sessionActive = false;
bool returnToTopicsAfterStop = false;
bool wasTouched = false;
bool touchTracking = false;
bool longPressHandled = false;
bool tlsClockReady = false;
uint32_t touchStartedMs = 0;
uint32_t lastTouchSeenMs = 0;
TouchPoint touchStart;
TouchPoint lastTouch;
bool buttonPressed = false;
bool buttonHoldHandled = false;
uint32_t buttonChangedMs = 0;
uint32_t buttonPressedMs = 0;
uint32_t volumeOverlayUntilMs = 0;
bool volumeOverlayShown = false;

void handleLongPress();
void loadCompanion();
void saveCompanion();
#if defined(ANGRY_CAT_SIMULATOR)
uint8_t simulatedTouchFrames = 0;
bool simulatorTopicCheckPending = false;
bool simulatorEventCheckPending = false;
#if defined(ANGRY_CAT_SIMULATOR_LIVE)
uint8_t simulatorLiveAnswerCount = 0;
QueueHandle_t simulatorTextAnswerQueue = nullptr;
bool simulatorInteractiveText = false;
#endif
#endif

enum class ScreenStatus : uint8_t {
  Ready,
  Connecting,
  Listening,
  Thinking,
  Evaluating,
  Speaking,
  Complete,
  Stopped,
  Error,
};

enum class AppView : uint8_t { Topics, Interview, Review };

struct StudyTopic {
  const char *id;
  const char *label;
  const char *material;
};

constexpr StudyTopic kStudyTopics[] = {
    {"behavior_guidance", "Behavior Guidance", "AAPD behavior guidance"},
    {"growth_development", "Growth & Development", "AAPD developing dentition"},
    {"facial_injury_emergency_surgery",
     "Oral Facial Injury, Emergency Care & Oral Surgery",
     "AAPD trauma + oral surgery"},
    {"diagnosis_pathology_radiology_medicine",
     "Diagnosis, Oral Pathology, Oral Radiology, and Oral Medicine",
     "AAPD diagnostic guidance"},
    {"prevention_health_promotion", "Prevention & Health Promotion",
     "AAPD prevention guidance"},
    {"caries_management_restorative",
     "Dental Caries Diagnosis, Non-Restorative Caries Management and "
     "Restorative Treatment",
     "AAPD caries + restorative"},
    {"pulp_therapy", "Pulp Therapy", "AAPD pulp therapy guidance"},
    {"special_health_care_needs", "Special Health Care Needs",
     "AAPD SHCN guidance"},
    {"advocacy_education", "Advocacy and Education",
     "ABPD + AAPD policy resources"},
    {"pediatric_dental_practice", "Elements of Pediatric Dental Practice",
     "ABPD + AAPD practice safety"},
};
constexpr uint8_t kTopicCount = sizeof(kStudyTopics) / sizeof(kStudyTopics[0]);
constexpr int kTopicGridY = 70;
constexpr int kTopicRowHeight = 72;
constexpr int kTopicColumnWidth = 154;

AppView appView = AppView::Topics;
ScreenStatus screenStatus = ScreenStatus::Ready;
AngryCatAnimation currentAnimation = AngryCatAnimation::Waving;
uint8_t currentFrame = 0;
uint8_t questionNumber = 0;
uint8_t answeredQuestions = 0;
uint8_t totalQuestions = 6;
uint32_t lastFrameMs = 0;
uint8_t selectedTopicIndex = 0;
uint8_t reviewPage = 0;
bool reviewLoading = false;
bool screenDirty = false;
char currentDomain[48] = "PEDIATRIC DENTISTRY";
char currentQuestion[384] = "Tap Angry Cat to begin. Answer aloud; the "
                            "six-question interview advances automatically.";
char statusDetail[96] = "TAP TO BEGIN - HOLD FOR WI-FI";
char savedReportId[40] = {};

uint16_t blend565(uint16_t from, uint16_t to, uint16_t amount,
                  uint16_t maximum) {
  const int fromR = (from >> 11) & 0x1F;
  const int fromG = (from >> 5) & 0x3F;
  const int fromB = from & 0x1F;
  const int toR = (to >> 11) & 0x1F;
  const int toG = (to >> 5) & 0x3F;
  const int toB = to & 0x1F;
  return static_cast<uint16_t>(
      ((fromR + (toR - fromR) * amount / maximum) << 11) |
      ((fromG + (toG - fromG) * amount / maximum) << 5) |
      (fromB + (toB - fromB) * amount / maximum));
}

void drawBackground() {
  constexpr uint16_t top = RGB565(17, 25, 53);
  constexpr uint16_t bottom = RGB565(54, 32, 76);
  for (uint16_t y = 0; y < kScreenHeight; ++y) {
    display.drawFastHLine(0, y, kScreenWidth,
                          blend565(top, bottom, y, kScreenHeight - 1));
  }
}

void setFont(uint8_t size, uint16_t color) {
  display.setFont(nullptr);
  display.setTextSize(size);
  display.setTextColor(color);
  display.setTextWrap(false);
}

void drawCentered(const char *text, int centerX, int baselineY, uint8_t size,
                  uint16_t color) {
  int16_t x1;
  int16_t y1;
  uint16_t width;
  uint16_t height;
  setFont(size, color);
  display.getTextBounds(text, 0, 0, &x1, &y1, &width, &height);
  display.setCursor(centerX - static_cast<int>(width) / 2, baselineY);
  display.print(text);
}

void formatLabel(const char *source, char *destination, size_t capacity) {
  if (destination == nullptr || capacity == 0)
    return;
  size_t written = 0;
  for (size_t index = 0;
       source != nullptr && source[index] != '\0' && written + 1 < capacity;
       ++index) {
    char value = source[index] == '_' ? ' ' : source[index];
    if (value >= 'a' && value <= 'z')
      value = value - 'a' + 'A';
    destination[written++] = value;
  }
  destination[written] = '\0';
}

void appendWord(char *line, size_t capacity, const char *word) {
  size_t used = strlen(line);
  if (used != 0 && used + 1 < capacity)
    line[used++] = ' ';
  const size_t copied = min(strlen(word), capacity - used - 1);
  memcpy(line + used, word, copied);
  line[used + copied] = '\0';
}

void drawWrappedBlock(const char *text, int x, int firstBaseline,
                      size_t charactersPerLine, size_t maximumLines,
                      int lineHeight, uint16_t color) {
  if (text == nullptr || text[0] == '\0' || charactersPerLine == 0 ||
      charactersPerLine > 48 || maximumLines == 0) {
    return;
  }
  const char *cursor = text;
  for (size_t lineIndex = 0; lineIndex < maximumLines && *cursor != '\0';
       ++lineIndex) {
    while (*cursor == ' ' || *cursor == '\n' || *cursor == '\r' ||
           *cursor == '\t') {
      ++cursor;
    }
    if (*cursor == '\0')
      break;

    char line[49] = {};
    size_t used = 0;
    while (*cursor != '\0' && *cursor != '\n' && *cursor != '\r') {
      while (*cursor == ' ' || *cursor == '\t')
        ++cursor;
      const char *word = cursor;
      size_t wordLength = 0;
      while (word[wordLength] != '\0' && word[wordLength] != ' ' &&
             word[wordLength] != '\t' && word[wordLength] != '\n' &&
             word[wordLength] != '\r') {
        ++wordLength;
      }
      if (wordLength == 0)
        break;
      const size_t separator = used == 0 ? 0 : 1;
      if (used > 0 && used + separator + wordLength > charactersPerLine)
        break;
      if (separator != 0)
        line[used++] = ' ';
      const size_t available = charactersPerLine - used;
      const size_t copied = min(wordLength, available);
      memcpy(line + used, word, copied);
      used += copied;
      line[used] = '\0';
      cursor += copied;
      if (copied < wordLength)
        break;
    }
    while (*cursor == '\n' || *cursor == '\r')
      ++cursor;

    const char *remaining = cursor;
    while (*remaining == ' ' || *remaining == '\n' || *remaining == '\r' ||
           *remaining == '\t') {
      ++remaining;
    }
    if (lineIndex + 1 == maximumLines && *remaining != '\0' && used >= 3) {
      memcpy(line + used - 3, "...", 3);
    }
    setFont(1, color);
    display.setCursor(x,
                      firstBaseline + static_cast<int>(lineIndex) * lineHeight);
    display.print(line);
  }
}

const AngryCatAnimationClip &animationClip() {
  return kAngryCatAnimationClips[static_cast<uint8_t>(currentAnimation)];
}

uint8_t absoluteFrame() { return animationClip().firstFrame + currentFrame; }

void flushDisplay() {
  display.flush();
#if defined(ANGRY_CAT_SIMULATOR)
  angry_cat_simulator::showDisplay(display.getFramebuffer(), kScreenWidth,
                                   kScreenHeight);
#endif
}

void drawCatFrame() {
  display.fillRect(kPetX, kPetY, kAngryCatFrameWidth, kAngryCatFrameHeight,
                   kPetCard);
  display.drawIndexedBitmap(
      kPetX, kPetY, const_cast<uint8_t *>(kAngryCatFrames[absoluteFrame()]),
      const_cast<uint16_t *>(kAngryCatPalette), kAngryCatTransparentIndex,
      kAngryCatFrameWidth, kAngryCatFrameHeight);
}

AngryCatAnimation animationForStatus() {
  switch (screenStatus) {
  case ScreenStatus::Connecting:
  case ScreenStatus::Listening:
    return AngryCatAnimation::Waiting;
  case ScreenStatus::Thinking:
  case ScreenStatus::Evaluating:
    return AngryCatAnimation::Thinking;
  case ScreenStatus::Speaking:
    return AngryCatAnimation::Waving;
  case ScreenStatus::Complete:
    return AngryCatAnimation::Review;
  case ScreenStatus::Error:
    return AngryCatAnimation::Failed;
  default:
    return AngryCatAnimation::Idle;
  }
}

uint16_t statusColor() {
  switch (screenStatus) {
  case ScreenStatus::Listening:
    return kListening;
  case ScreenStatus::Thinking:
  case ScreenStatus::Evaluating:
    return kThinking;
  case ScreenStatus::Speaking:
    return kSpeaking;
  case ScreenStatus::Complete:
    return kListening;
  case ScreenStatus::Error:
    return kError;
  default:
    return kSoftWhite;
  }
}

const char *statusLabel() {
  switch (screenStatus) {
  case ScreenStatus::Connecting:
    return "CONNECTING";
  case ScreenStatus::Listening:
    return "YOUR TURN - SPEAK";
  case ScreenStatus::Thinking:
    return "CAT IS THINKING";
  case ScreenStatus::Evaluating:
    return "SAVING YOUR REVIEW";
  case ScreenStatus::Speaking:
    return "INTERVIEWER SPEAKING";
  case ScreenStatus::Complete:
    return "INTERVIEW COMPLETE";
  case ScreenStatus::Stopped:
    return "INTERVIEW STOPPED";
  case ScreenStatus::Error:
    return "CONNECTION ERROR";
  default:
    return "READY";
  }
}

void drawWrappedQuestion(const char *text) {
  constexpr size_t kMaximumLines = 13;
  constexpr size_t kCharactersPerLine = 43;
  char lines[kMaximumLines][kCharactersPerLine + 1] = {};
  char scratch[sizeof(currentQuestion)];
  snprintf(scratch, sizeof(scratch), "%s", text);
  size_t lineIndex = 0;
  bool truncated = false;
  char *save = nullptr;
  for (char *word = strtok_r(scratch, " ", &save); word != nullptr;
       word = strtok_r(nullptr, " ", &save)) {
    const size_t used = strlen(lines[lineIndex]);
    const size_t needed = strlen(word) + (used == 0 ? 0 : 1);
    if (used + needed > kCharactersPerLine) {
      if (lineIndex + 1 >= kMaximumLines) {
        truncated = true;
        break;
      }
      ++lineIndex;
    }
    appendWord(lines[lineIndex], sizeof(lines[lineIndex]), word);
  }
  if (truncated) {
    const size_t length = strlen(lines[kMaximumLines - 1]);
    if (length > 3)
      memcpy(lines[kMaximumLines - 1] + length - 3, "...", 4);
  }

  const size_t lineCount = lineIndex + 1;
  const int firstY = 317 - static_cast<int>((lineCount - 1) * 15) / 2;
  for (size_t index = 0; index < lineCount; ++index) {
    drawCentered(lines[index], kScreenWidth / 2,
                 firstY + static_cast<int>(index) * 15, 1, kInk);
  }
}

void renderTopicMenu() {
  drawBackground();
  drawCentered("CHOOSE A STUDY TOPIC", kScreenWidth / 2, 13, 2, kWhite);
  drawCentered("PEDIATRIC ORAL BOARDS", kScreenWidth / 2, 39, 1, kSoftWhite);

  char companionLine[64];
  snprintf(companionLine, sizeof(companionLine), "%s",
           companion.moodPhrase(companion.mood(time(nullptr))));
  if (companion.streakDays() >= 2) {
    const size_t used = strlen(companionLine);
    snprintf(companionLine + used, sizeof(companionLine) - used,
             " - %u-DAY STREAK", static_cast<unsigned>(companion.streakDays()));
  }
  drawCentered(companionLine, kScreenWidth / 2, 56, 1,
               companion.mood(time(nullptr)) == CompanionMood::Aloof
                   ? kThinking
                   : kListening);

  for (uint8_t index = 0; index < kTopicCount; ++index) {
    const uint8_t column = index / 5;
    const uint8_t rowIndex = index % 5;
    const int x = column == 0 ? 5 : 161;
    const int y = kTopicGridY + rowIndex * kTopicRowHeight;
    const uint16_t tile =
        column == 0
            ? (rowIndex % 2 == 0 ? RGB565(48, 145, 78) : RGB565(42, 130, 70))
            : (rowIndex % 2 == 0 ? RGB565(119, 91, 157) : RGB565(102, 76, 141));
    display.fillRoundRect(x, y, kTopicColumnWidth, kTopicRowHeight - 3, 6,
                          tile);

    constexpr size_t kMaxLines = 4;
    constexpr size_t kChars = 24;
    char lines[kMaxLines][kChars + 1] = {};
    char scratch[128];
    snprintf(scratch, sizeof(scratch), "%s", kStudyTopics[index].label);
    size_t line = 0;
    char *save = nullptr;
    for (char *word = strtok_r(scratch, " ", &save); word != nullptr;
         word = strtok_r(nullptr, " ", &save)) {
      const size_t used = strlen(lines[line]);
      const size_t needed = strlen(word) + (used == 0 ? 0 : 1);
      if (used + needed > kChars && line + 1 < kMaxLines)
        ++line;
      appendWord(lines[line], sizeof(lines[line]), word);
    }
    const size_t lineCount = line + 1;
    const int firstBaseline =
        y + (kTopicRowHeight - static_cast<int>(lineCount) * 12) / 2 + 2;
    for (size_t textLine = 0; textLine < lineCount; ++textLine) {
      drawCentered(lines[textLine], x + kTopicColumnWidth / 2,
                   firstBaseline + static_cast<int>(textLine) * 12, 1, kWhite);
    }
  }
  drawCentered(WiFi.status() == WL_CONNECTED
                   ? "TAP A TOPIC - HOLD TITLE FOR WI-FI"
                   : "WI-FI OFFLINE - TAP A TOPIC TO SET UP",
               kScreenWidth / 2, 470, 1,
               WiFi.status() == WL_CONNECTED ? kListening : kThinking);
  flushDisplay();
}

void renderReviewScreen() {
  const DeviceInterviewReport &report = interviewer.report();
  const uint8_t pageCount = report.scoreCount + 1;
  if (reviewPage >= pageCount)
    reviewPage = pageCount - 1;
  drawBackground();
  drawCentered("INTERVIEW REVIEW", kScreenWidth / 2, 13, 2, kWhite);

  char outcome[24];
  formatLabel(report.outcome, outcome, sizeof(outcome));
  const uint16_t outcomeColor =
      strcmp(report.outcome, "pass") == 0
          ? kListening
          : (strcmp(report.outcome, "borderline") == 0 ? kThinking : kError);
  display.fillRoundRect(58, 41, 204, 25, 12, RGB565(31, 38, 70));
  drawCentered(outcome, kScreenWidth / 2, 49, 1, outcomeColor);

  display.fillRoundRect(10, 76, 300, 348, 16, kWhite);
  char pageLabel[24];
  snprintf(pageLabel, sizeof(pageLabel), "PAGE %u OF %u", reviewPage + 1,
           pageCount);
  drawCentered(pageLabel, kScreenWidth / 2, 86, 1, RGB565(95, 77, 128));

  if (reviewPage == 0) {
    drawWrappedBlock(report.domain, 22, 108, 46, 2, 14, kInk);
    uint16_t scoreTotal = 0;
    for (uint8_t index = 0; index < report.scoreCount; ++index) {
      scoreTotal += report.scores[index].score;
    }
    const uint16_t averageTenths =
        report.scoreCount == 0 ? 0 : scoreTotal * 10 / report.scoreCount;
    char average[48];
    snprintf(average, sizeof(average), "PRACTICE AVERAGE  %u.%u / 3",
             averageTenths / 10, averageTenths % 10);
    display.fillRoundRect(37, 139, 246, 26, 13, RGB565(232, 238, 246));
    drawCentered(average, kScreenWidth / 2, 147, 1, RGB565(63, 74, 96));
    setFont(1, RGB565(95, 77, 128));
    display.setCursor(22, 181);
    display.print("EXAMINER SUMMARY");
    drawWrappedBlock(report.examinerSummary, 22, 202, 46, 14, 15, kInk);
  } else {
    const DeviceInterviewScore &score = report.scores[reviewPage - 1];
    drawWrappedBlock(score.skillset, 22, 109, 46, 3, 14, kInk);
    char skill[32];
    formatLabel(score.skill, skill, sizeof(skill));
    char scoreLabel[48];
    snprintf(scoreLabel, sizeof(scoreLabel), "%s  -  %u / 3", skill,
             score.score);
    display.fillRoundRect(27, 154, 266, 27, 13, RGB565(232, 238, 246));
    drawCentered(scoreLabel, kScreenWidth / 2, 163, 1, RGB565(63, 74, 96));
    setFont(1, RGB565(95, 77, 128));
    display.setCursor(22, 201);
    display.print("WHY THIS SCORE");
    drawWrappedBlock(score.rationale, 22, 223, 46, 12, 15, kInk);
  }

  char reportLabel[32];
  snprintf(reportLabel, sizeof(reportLabel), "REPORT %.8s", report.reportId);
  drawCentered(reportLabel, kScreenWidth / 2, 436, 1, kSoftWhite);
  drawCentered("SWIPE FOR PAGES - HOLD FOR TOPICS", kScreenWidth / 2, 462, 1,
               kSoftWhite);
  flushDisplay();
}

void renderScreen() {
  screenDirty = false;
  if (appView == AppView::Topics) {
    renderTopicMenu();
    return;
  }
  if (appView == AppView::Review) {
    if (interviewer.report().ready) {
      renderReviewScreen();
      return;
    }
    appView = AppView::Interview;
  }
  drawBackground();
  display.fillRoundRect(20, 4, 280, 164, 22, kPetCard);
  currentAnimation = animationForStatus();
  currentFrame = 0;
  lastFrameMs = millis();
  drawCatFrame();

  display.fillTriangle(142, 186, 160, 165, 178, 186, kWhite);
  display.fillRoundRect(14, 182, 292, 248, 18, kWhite);
  char domainLabel[49];
  snprintf(domainLabel, sizeof(domainLabel), "%.48s", currentDomain);
  drawCentered(domainLabel, kScreenWidth / 2, 195, 1, RGB565(95, 77, 128));
  drawWrappedQuestion(currentQuestion);

  display.fillRoundRect(42, 439, 236, 26, 13, RGB565(25, 31, 62));
  drawCentered(statusLabel(), kScreenWidth / 2, 447, 1, statusColor());
  drawCentered(statusDetail, kScreenWidth / 2, 470, 1, kSoftWhite);
  flushDisplay();
}

void setScreenStatus(ScreenStatus status, const char *detail = nullptr) {
  screenStatus = status;
  if (detail != nullptr) {
    snprintf(statusDetail, sizeof(statusDetail), "%s", detail);
  }
  screenDirty = true;
}

void sessionTask(void *) {
  const bool finished =
      interviewer.runSession(audio, kStudyTopics[selectedTopicIndex].id,
                             eventQueue, stopRequested, commitTurnRequested
#if defined(ANGRY_CAT_SIMULATOR_LIVE)
                             ,
                             simulatorTextAnswerQueue
#endif
      );
  if (finished && interviewer.lastReportId()[0] != '\0') {
    interviewer.fetchReport(interviewer.lastReportId(), eventQueue);
  }
  sessionTaskRunning.store(false);
  vTaskDelete(nullptr);
}

void startInterview() {
  if (sessionActive || sessionTaskRunning.load())
    return;
  if (WiFi.status() != WL_CONNECTED) {
    setScreenStatus(ScreenStatus::Error, "TAP TO OPEN WI-FI SETUP");
    snprintf(currentQuestion, sizeof(currentQuestion),
             "Wi-Fi is disconnected. Tap again to open setup, then restart the "
             "interview.");
    renderScreen();
    return;
  }
  if (!audio.isMicrophoneReady() || !interviewer.isConfigured() ||
      !tlsClockReady) {
    snprintf(currentQuestion, sizeof(currentQuestion),
             "The microphone, TLS clock, or Cloudflare interviewer is not "
             "ready.");
    setScreenStatus(ScreenStatus::Error, "CHECK SERIAL OUTPUT");
    return;
  }

  xQueueReset(eventQueue);
  stopRequested.store(false);
  commitTurnRequested.store(false);
  appView = AppView::Interview;
  sessionActive = true;
  sessionTaskRunning.store(true);
  questionNumber = 0;
  answeredQuestions = 0;
  reviewPage = 0;
  reviewLoading = false;
  savedReportId[0] = '\0';
  if (companion.onSessionStarted(time(nullptr), selectedTopicIndex))
    saveCompanion();
  snprintf(currentDomain, sizeof(currentDomain), "%s",
           kStudyTopics[selectedTopicIndex].label);
  snprintf(currentQuestion, sizeof(currentQuestion),
           "Study map: %s. Angry Cat is opening one continuous interview; no "
           "tapping between questions.",
           kStudyTopics[selectedTopicIndex].material);
  setScreenStatus(ScreenStatus::Connecting, "HANDS-FREE - HOLD TO END");
  if (xTaskCreatePinnedToCore(sessionTask, "oral-boards", 14336, nullptr, 1,
                              nullptr, 0) != pdPASS) {
    sessionActive = false;
    sessionTaskRunning.store(false);
    setScreenStatus(ScreenStatus::Error, "COULD NOT START VOICE TASK");
  }
}

void stopInterview() {
  if (!sessionActive)
    return;
  stopRequested.store(true);
  setScreenStatus(ScreenStatus::Stopped, "CLOSING VOICE SESSION...");
  renderScreen();
}

void processInterviewerEvents() {
  InterviewerEvent event;
  while (xQueueReceive(eventQueue, &event, 0) == pdTRUE) {
    switch (event.type) {
    case InterviewerEventType::Connected:
      setScreenStatus(ScreenStatus::Connecting, "STARTING VOICE CALL...");
      break;
    case InterviewerEventType::Listening:
      setScreenStatus(ScreenStatus::Listening,
                      "PAUSE OR TAP TO END YOUR ANSWER");
#if defined(ANGRY_CAT_SIMULATOR_LIVE)
      if (simulatorInteractiveText) {
        Serial.println(
            "SIM_MIC: awaiting answer; type a <answer text> and press Enter");
        angry_cat_simulator::showMicrophoneText("AWAITING TYPED ANSWER", true);
      } else {
        audio.queueSimulatorAnswer();
        angry_cat_simulator::showMicrophoneText("PRERECORDED PCM ANSWER",
                                                false);
        ++simulatorLiveAnswerCount;
        Serial.printf("SIM_INTEGRATION: streaming answer %u\n",
                      simulatorLiveAnswerCount);
      }
#endif
      break;
    case InterviewerEventType::Thinking:
      setScreenStatus(ScreenStatus::Thinking, "ANSWER RECEIVED - PLEASE WAIT");
      break;
    case InterviewerEventType::Evaluating:
      snprintf(statusDetail, sizeof(statusDetail),
               "EVALUATING %u OF %u ANSWERS - SAVING",
               static_cast<unsigned>(answeredQuestions),
               static_cast<unsigned>(totalQuestions));
      setScreenStatus(ScreenStatus::Evaluating);
      break;
    case InterviewerEventType::Speaking:
      setScreenStatus(ScreenStatus::Speaking, "LISTEN - THEN ANSWER ALOUD");
      break;
    case InterviewerEventType::CandidateTranscript:
      Serial.printf("Candidate: %s\n", event.text);
      break;
    case InterviewerEventType::InterviewerPrompt: {
      const char *question = strstr(event.text, "Question one. ");
      question = question == nullptr ? event.text : question + 14;
      if (strchr(question, '?') != nullptr) {
        snprintf(currentQuestion, sizeof(currentQuestion), "%s", question);
        screenDirty = true;
      }
      Serial.printf("Interviewer: %s\n", event.text);
      break;
    }
    case InterviewerEventType::InterviewState:
      questionNumber = event.questionNumber;
      answeredQuestions = event.answerCount;
      totalQuestions = event.totalQuestions;
      snprintf(currentDomain, sizeof(currentDomain), "%s", event.domain);
      if (event.text[0] != '\0') {
        snprintf(currentQuestion, sizeof(currentQuestion), "%s", event.text);
      }
      screenDirty = true;
      break;
    case InterviewerEventType::Metrics:
      Serial.printf("Interviewer latency: %lu ms total\n",
                    static_cast<unsigned long>(event.latencyMs));
      break;
    case InterviewerEventType::AudioUnavailable:
      snprintf(statusDetail, sizeof(statusDetail),
               "READ PROMPT - ANSWER ALOUD");
      screenDirty = true;
      break;
    case InterviewerEventType::ReportReady:
      snprintf(savedReportId, sizeof(savedReportId), "%.36s", event.text);
      snprintf(statusDetail, sizeof(statusDetail), "REVIEW SAVED - %.8s",
               savedReportId);
      screenDirty = true;
      Serial.printf("Interview report saved: id=%s outcome=%s\n", savedReportId,
                    event.phase);
      if (companion.onSessionCompleted(time(nullptr),
                                       strcmp(event.phase, "pass") == 0
                                           ? CompanionOutcome::Pass
                                       : strcmp(event.phase, "borderline") == 0
                                           ? CompanionOutcome::Borderline
                                           : CompanionOutcome::NotYet)) {
        saveCompanion();
      }
#if defined(ANGRY_CAT_SIMULATOR_LIVE)
      Serial.println("SIM_INTEGRATION: report saved");
#endif
      break;
    case InterviewerEventType::ReviewLoading:
      reviewLoading = true;
      snprintf(statusDetail, sizeof(statusDetail), "LOADING REVIEW FROM R2");
      screenDirty = true;
      Serial.printf("Interviewer report: %s\n", event.text);
      break;
    case InterviewerEventType::ReviewReady:
      reviewLoading = false;
      if (appView == AppView::Interview) {
        reviewPage = 0;
        appView = AppView::Review;
        screenDirty = true;
      }
      Serial.printf("Interviewer report ready on device: %s\n", event.text);
#if defined(ANGRY_CAT_SIMULATOR_LIVE)
      if (simulatorLiveAnswerCount >= 6 && interviewer.report().ready &&
          interviewer.report().scoreCount > 0) {
        Serial.println("SIM_INTEGRATION: END_TO_END_PASSED");
      } else {
        Serial.println("SIM_INTEGRATION: FAIL incomplete report path");
      }
#endif
      break;
    case InterviewerEventType::ReviewUnavailable:
      reviewLoading = false;
      snprintf(currentQuestion, sizeof(currentQuestion),
               "%.330s The full report is published in Reports as %.8s.",
               event.text,
               savedReportId[0] == '\0' ? "unknown" : savedReportId);
      setScreenStatus(ScreenStatus::Complete, "TAP TO CHOOSE ANOTHER TOPIC");
      Serial.printf("Interviewer report display unavailable: %s\n", event.text);
      break;
    case InterviewerEventType::Complete:
      sessionActive = false;
      if (returnToTopicsAfterStop || appView == AppView::Topics) {
        returnToTopicsAfterStop = false;
        appView = AppView::Topics;
        screenDirty = true;
        break;
      }
      reviewLoading = savedReportId[0] != '\0';
      snprintf(currentDomain, sizeof(currentDomain), "INTERVIEW COMPLETE");
      if (answeredQuestions >= totalQuestions) {
        snprintf(
            currentQuestion, sizeof(currentQuestion),
            "Six questions complete. Your review was published in Reports. "
            "Loading report %.8s for this screen.",
            savedReportId[0] == '\0' ? "pending" : savedReportId);
      } else {
        snprintf(currentQuestion, sizeof(currentQuestion),
                 "Interview ended after %u of %u answered questions. Your "
                 "partial review was published in Reports as %.8s.",
                 static_cast<unsigned>(answeredQuestions),
                 static_cast<unsigned>(totalQuestions),
                 savedReportId[0] == '\0' ? "pending" : savedReportId);
      }
      setScreenStatus(ScreenStatus::Complete,
                      reviewLoading ? "LOADING PUBLISHED REVIEW"
                                    : "TAP TO CHOOSE ANOTHER TOPIC");
#if defined(ANGRY_CAT_SIMULATOR_LIVE)
      Serial.println("SIM_INTEGRATION: interview complete");
#endif
      break;
    case InterviewerEventType::Stopped:
      if (sessionActive && companion.onSessionAbandoned(time(nullptr)))
        saveCompanion();
      sessionActive = false;
      if (returnToTopicsAfterStop || appView == AppView::Topics) {
        returnToTopicsAfterStop = false;
        appView = AppView::Topics;
        screenDirty = true;
        break;
      }
      snprintf(currentQuestion, sizeof(currentQuestion),
               "The interview was stopped. Tap Angry Cat to choose another "
               "topic.");
      setScreenStatus(ScreenStatus::Stopped, "TAP TO RETURN TO TOPICS");
      break;
    case InterviewerEventType::Error:
      if (sessionActive && companion.onSessionAbandoned(time(nullptr)))
        saveCompanion();
      sessionActive = false;
      if (returnToTopicsAfterStop || appView == AppView::Topics) {
        returnToTopicsAfterStop = false;
        appView = AppView::Topics;
        screenDirty = true;
        Serial.printf("Interviewer stopped while returning to topics: %s\n",
                      event.text);
        break;
      }
      snprintf(currentQuestion, sizeof(currentQuestion), "%s", event.text);
      setScreenStatus(ScreenStatus::Error, "TAP TO CHOOSE A TOPIC");
      Serial.printf("Interviewer error: %s\n", event.text);
#if defined(ANGRY_CAT_SIMULATOR_LIVE)
      Serial.printf("SIM_INTEGRATION: FAIL %s\n", event.text);
#endif
      break;
    }
  }
}

void updateAnimation() {
  if (appView != AppView::Interview)
    return;
  const uint8_t frame = absoluteFrame();
  if (millis() - lastFrameMs < kAngryCatFrameDurationsMs[frame])
    return;
  ++currentFrame;
  const AngryCatAnimationClip &clip = animationClip();
  if (currentFrame >= clip.frameCount) {
    currentFrame = clip.loops ? 0 : clip.frameCount - 1;
  }
  lastFrameMs = millis();
  drawCatFrame();
  flushDisplay();
}

uint8_t probeI2cDevice(uint8_t address) {
  Wire.beginTransmission(address);
  return Wire.endTransmission();
}

void recoverI2cBus() {
  Wire.end();

  pinMode(kI2cSda, INPUT_PULLUP);
  pinMode(kI2cScl, OUTPUT_OPEN_DRAIN);
  digitalWrite(kI2cScl, HIGH);
  delayMicroseconds(5);

  for (uint8_t pulse = 0; pulse < 9 && digitalRead(kI2cSda) == LOW; ++pulse) {
    digitalWrite(kI2cScl, LOW);
    delayMicroseconds(5);
    digitalWrite(kI2cScl, HIGH);
    delayMicroseconds(5);
  }

  pinMode(kI2cSda, OUTPUT_OPEN_DRAIN);
  digitalWrite(kI2cSda, LOW);
  delayMicroseconds(5);
  digitalWrite(kI2cScl, HIGH);
  delayMicroseconds(5);
  digitalWrite(kI2cSda, HIGH);
  delayMicroseconds(5);

  pinMode(kI2cSda, INPUT_PULLUP);
  pinMode(kI2cScl, INPUT_PULLUP);
  Wire.begin(kI2cSda, kI2cScl, 100000);
}

bool beginIoExpander() {
  for (uint8_t attempt = 1; attempt <= kI2cStartupAttempts; ++attempt) {
    const uint8_t expanderStatus = probeI2cDevice(kIoExpanderAddress);
    if (expanderStatus == 0 && ioExpander.begin())
      return true;

    const uint8_t touchStatus = probeI2cDevice(AXS5106L_ADDR);
    Serial.printf(
        "I2C startup attempt %u/%u: TCA9554=%u, touch=%u, SDA=%d, SCL=%d\n",
        attempt, kI2cStartupAttempts, expanderStatus, touchStatus,
        digitalRead(kI2cSda), digitalRead(kI2cScl));
    recoverI2cBus();
    delay(kI2cStartupRetryMs);
  }
  return false;
}

void resetDisplayController() {
#if defined(ANGRY_CAT_SIMULATOR)
  Serial.println("SIM_TEST: display reset mock ready");
#else
  if (!beginIoExpander()) {
    Serial.println("ERROR: TCA9554 not found at 0x20 after I2C recovery");
    while (true)
      delay(1000);
  }
  Wire.setClock(400000);
  if (!ioExpander.pinMode1(kLcdResetExpanderPin, OUTPUT)) {
    Serial.println("ERROR: could not configure LCD reset");
    while (true)
      delay(1000);
  }
  ioExpander.write1(kLcdResetExpanderPin, HIGH);
  delay(10);
  ioExpander.write1(kLcdResetExpanderPin, LOW);
  delay(10);
  ioExpander.write1(kLcdResetExpanderPin, HIGH);
  delay(200);
#endif
}

bool beginTouch() {
#if defined(ANGRY_CAT_SIMULATOR)
  return true;
#else
  Wire.beginTransmission(AXS5106L_ADDR);
  if (Wire.endTransmission() != 0)
    return false;
  bsp_touch_init(&Wire, -1, 0, kScreenWidth, kScreenHeight);
  return true;
#endif
}

bool readTouch(TouchPoint &point) {
#if defined(ANGRY_CAT_SIMULATOR)
  uint16_t simulatorX = 0;
  uint16_t simulatorY = 0;
  if (angry_cat_simulator::readTouch(simulatorX, simulatorY)) {
    point.x = simulatorX;
    point.y = simulatorY;
    return true;
  }
  if (simulatedTouchFrames == 0)
    return false;
  --simulatedTouchFrames;
  point.x = 20;
  point.y = 100;
  return true;
#else
  bsp_touch_read();
  touch_data_t data{};
  if (!bsp_touch_get_coordinates(&data))
    return false;
  point = data.coords[0];
  return point.x < kScreenWidth && point.y < kScreenHeight;
#endif
}

bool synchronizeTlsClock() {
  constexpr time_t kMinimumValidEpoch = 1704067200; // 2024-01-01 UTC
  if (time(nullptr) >= kMinimumValidEpoch)
    return true;

  configTime(0, 0, "time.cloudflare.com", "pool.ntp.org");
  const uint32_t startedMs = millis();
  while (time(nullptr) < kMinimumValidEpoch && millis() - startedMs < 15000)
    delay(100);

  const bool synchronized = time(nullptr) >= kMinimumValidEpoch;
  Serial.printf("TLS clock: %s\n",
                synchronized ? "synchronized" : "NTP timed out");
  return synchronized;
}

bool configureWiFi(bool forcePortal = false) {
  bool connected = false;
#if defined(ANGRY_CAT_SIMULATOR)
  (void)forcePortal;
  WiFi.mode(WIFI_STA);
  WiFi.begin("Wokwi-GUEST", "", 6);
  const uint32_t startedMs = millis();
  while (WiFi.status() != WL_CONNECTED && millis() - startedMs < 10000)
    delay(100);
  connected = WiFi.status() == WL_CONNECTED;
  Serial.printf("SIM_TEST: Wi-Fi %s\n", connected ? "connected" : "failed");
#else
  snprintf(currentQuestion, sizeof(currentQuestion),
           "Join the Pediatric Boards Setup network. Saved Wi-Fi credentials "
           "are preserved.");
  setScreenStatus(ScreenStatus::Connecting, "WI-FI SETUP: 192.168.4.1");
  renderScreen();
  WiFiManager manager;
  manager.setTitle("Pediatric Boards Setup");
  manager.setConnectTimeout(20);
  manager.setConfigPortalTimeout(180);
  manager.setBreakAfterConfig(true);
  connected = forcePortal ? manager.startConfigPortal("Pediatric Boards Setup")
                          : manager.autoConnect("Pediatric Boards Setup");
  Serial.printf("Wi-Fi setup: %s\n", connected ? "connected" : "timed out");
  connected = connected && WiFi.status() == WL_CONNECTED;
#endif

  if (connected)
    WiFi.setSleep(false);

  tlsClockReady =
      connected && (!interviewer.isConfigured() || synchronizeTlsClock());
#if defined(ANGRY_CAT_SIMULATOR)
  const IPAddress localIp = WiFi.localIP();
  const uint8_t ip[] = {localIp[0], localIp[1], localIp[2], localIp[3]};
  angry_cat_simulator::showWifiStatus(connected, connected ? WiFi.RSSI() : -127,
                                      ip);
#endif
  return connected;
}

void handleSerial() {
  while (Serial.available() > 0) {
    const int command = Serial.read();
    if (command == 's' || command == 'S') {
      sessionActive ? stopInterview() : startInterview();
#if defined(ANGRY_CAT_SIMULATOR)
    } else if (command == 't' || command == 'T') {
      simulatedTouchFrames = 1;
      simulatorTopicCheckPending = true;
      Serial.println("SIM_TEST: injecting topic touch");
    } else if (command == 'p' || command == 'P') {
      Serial.println("SIM_SPEAKER: playing 440 Hz test tone");
      angry_cat_simulator::playSpeakerTestTone();
    } else if (command == 'b' || command == 'B') {
      Serial.printf("SIM_TEST: playback burst %s\n",
                    InterviewerClient::runPlaybackBufferSelfTest() ? "passed"
                                                                   : "failed");
#if defined(ANGRY_CAT_SIMULATOR_LIVE)
    } else if (command == 'i' || command == 'I') {
      simulatorInteractiveText = !simulatorInteractiveText;
      xQueueReset(simulatorTextAnswerQueue);
      Serial.printf("SIM_MIC: interactive text mode %s\n",
                    simulatorInteractiveText ? "enabled" : "disabled");
      angry_cat_simulator::showMicrophoneText(
          simulatorInteractiveText ? "TYPE a <answer> IN TERMINAL"
                                   : "PRERECORDED PCM MODE",
          simulatorInteractiveText);
    } else if (command == 'a' || command == 'A') {
      SimulatorTextAnswer answer;
      const size_t bytesRead =
          Serial.readBytesUntil('\n', answer.text, sizeof(answer.text) - 1);
      answer.text[bytesRead] = '\0';
      bool answerTooLong = false;
      if (bytesRead == sizeof(answer.text) - 1) {
        const uint32_t drainStartedMs = millis();
        int nextCharacter = -1;
        while (nextCharacter < 0 && millis() - drainStartedMs < 100) {
          if (Serial.available() > 0)
            nextCharacter = Serial.read();
          else
            delay(1);
        }
        if (nextCharacter != '\n') {
          answerTooLong = true;
          while (millis() - drainStartedMs < 100) {
            if (Serial.available() == 0) {
              delay(1);
              continue;
            }
            if (Serial.read() == '\n')
              break;
          }
        }
      }
      char *text = answer.text;
      while (*text == ' ' || *text == '\t')
        ++text;
      size_t textLength = strlen(text);
      while (textLength > 0 &&
             (text[textLength - 1] == '\r' || text[textLength - 1] == ' ' ||
              text[textLength - 1] == '\t')) {
        text[--textLength] = '\0';
      }
      if (answerTooLong) {
        Serial.println("SIM_MIC: answer exceeds the 1000-character limit");
      } else if (!simulatorInteractiveText) {
        Serial.println("SIM_MIC: type i first to enable interactive text mode");
      } else if (textLength == 0) {
        Serial.println("SIM_MIC: answer text was empty");
      } else {
        SimulatorTextAnswer queuedAnswer;
        snprintf(queuedAnswer.text, sizeof(queuedAnswer.text), "%s", text);
        if (xQueueSend(simulatorTextAnswerQueue, &queuedAnswer,
                       pdMS_TO_TICKS(20)) == pdTRUE) {
          ++simulatorLiveAnswerCount;
          angry_cat_simulator::showMicrophoneText(queuedAnswer.text, false);
          Serial.printf("SIM_MIC: queued typed answer %u (%u characters)\n",
                        simulatorLiveAnswerCount,
                        static_cast<unsigned>(textLength));
        } else {
          Serial.println("SIM_MIC: answer queue is full");
        }
      }
#endif
    } else if (command == 'e' || command == 'E') {
      InterviewerEvent event;
      event.type = InterviewerEventType::InterviewState;
      event.questionNumber = 2;
      event.totalQuestions = 6;
      snprintf(event.phase, sizeof(event.phase), "questioning");
      snprintf(event.domain, sizeof(event.domain), "SIMULATED DOMAIN");
      snprintf(event.text, sizeof(event.text), "Simulated queue event?");
      simulatorEventCheckPending =
          xQueueSend(eventQueue, &event, pdMS_TO_TICKS(20)) == pdTRUE;
      Serial.println("SIM_TEST: injecting interviewer event");
#endif
    }
  }
}

void loadVolumeStep() {
  Preferences settings;
  if (!settings.begin(kSettingsNamespace, true)) {
    // No namespace yet on a fresh device; the default is already the loudest.
    return;
  }
  audio.setVolumeStep(
      settings.getUChar(kVolumeSettingKey, AngryCatAudio::kLoudestVolumeStep));
  settings.end();
}

void saveVolumeStep(uint8_t step) {
  Preferences settings;
  if (!settings.begin(kSettingsNamespace, false))
    return;
  settings.putUChar(kVolumeSettingKey, step);
  settings.end();
}

constexpr char kCompanionSettingKey[] = "companion";

void loadCompanion() {
  Preferences settings;
  if (!settings.begin(kSettingsNamespace, true))
    return;
  uint8_t blob[CatCompanion::kBlobSize] = {};
  const size_t length =
      settings.getBytes(kCompanionSettingKey, blob, sizeof(blob));
  if (!companion.load(blob, static_cast<uint32_t>(length)))
    Serial.println("Companion: starting a fresh cat");
  settings.end();
}

void saveCompanion() {
  Preferences settings;
  if (!settings.begin(kSettingsNamespace, false))
    return;
  uint8_t blob[CatCompanion::kBlobSize] = {};
  const uint32_t length = companion.serialize(blob, sizeof(blob));
  if (length != 0)
    settings.putBytes(kCompanionSettingKey, blob, length);
  settings.end();
}

/**
 * BOOT is the only readable button, so it carries both actions: a short press
 * steps the volume and wrapping round to the quietest, and a hold runs the
 * same reset the touchscreen long-press performs.
 */
void pollButton() {
  const uint32_t now = millis();
  const bool pressedNow = digitalRead(kBootButtonPin) == LOW;
  if (pressedNow != buttonPressed &&
      now - buttonChangedMs >= kButtonDebounceMs) {
    buttonChangedMs = now;
    buttonPressed = pressedNow;
    if (pressedNow) {
      buttonPressedMs = now;
      buttonHoldHandled = false;
    } else if (!buttonHoldHandled) {
      const uint8_t step = audio.cycleVolumeStep();
      saveVolumeStep(step);
      volumeOverlayUntilMs = now + kVolumeOverlayMs;
      screenDirty = true;
      Serial.printf("Volume: step %u/%u\n", step + 1,
                    AngryCatAudio::kVolumeStepCount);
    }
  }
  if (buttonPressed && !buttonHoldHandled &&
      now - buttonPressedMs >= kButtonHoldMs) {
    buttonHoldHandled = true;
    Serial.println("Button hold: reset");
    handleLongPress();
  }
}

/** Transient volume readout drawn over whatever view is on screen. */
void drawVolumeOverlay() {
  constexpr int kOverlayWidth = 200;
  constexpr int kOverlayHeight = 54;
  const int x = (kScreenWidth - kOverlayWidth) / 2;
  const int y = kScreenHeight - kOverlayHeight - 24;
  display.fillRoundRect(x, y, kOverlayWidth, kOverlayHeight, 14,
                        RGB565(25, 31, 62));
  drawCentered("VOLUME", kScreenWidth / 2, y + 16, 1, kSoftWhite);
  constexpr int kPipWidth = 22;
  constexpr int kPipGap = 6;
  const int pipsWidth = AngryCatAudio::kVolumeStepCount * kPipWidth +
                        (AngryCatAudio::kVolumeStepCount - 1) * kPipGap;
  int pipX = (kScreenWidth - pipsWidth) / 2;
  for (uint8_t index = 0; index < AngryCatAudio::kVolumeStepCount; ++index) {
    display.fillRoundRect(pipX, y + 28, kPipWidth, 14, 4,
                          index <= audio.volumeStep() ? kWhite
                                                      : RGB565(60, 68, 104));
    pipX += kPipWidth + kPipGap;
  }
}

void handleLongPress() {
  if (appView == AppView::Interview) {
    returnToTopicsAfterStop = sessionActive || sessionTaskRunning.load();
    if (sessionActive)
      stopRequested.store(true);
    appView = AppView::Topics;
    renderScreen();
  } else if (appView == AppView::Review) {
    appView = AppView::Topics;
    renderScreen();
  } else {
    configureWiFi(true);
    appView = AppView::Topics;
    renderScreen();
  }
}

} // namespace

void setup() {
  Serial.begin(115200);
  delay(250);
  Serial.println("Angry Cat Pediatric Dentistry Oral Boards");
#if defined(ANGRY_CAT_SIMULATOR_LIVE)
  // Wokwi's software TLS handshake can hold a simulated core longer than the
  // ESP-IDF idle-task watchdog window. The production firmware keeps both
  // watchdogs at their normal timeout; only the opt-in integration profile
  // gives the registered tasks more time.
  const esp_task_wdt_config_t simulatorWatchdogConfig = {
      .timeout_ms = 120000,
      .idle_core_mask = (1U << portNUM_PROCESSORS) - 1U,
      .trigger_panic = true,
  };
  if (esp_task_wdt_reconfigure(&simulatorWatchdogConfig) == ESP_OK) {
    Serial.println("SIM_INTEGRATION: simulator watchdog timeout extended");
  } else {
    Serial.println("SIM_INTEGRATION: FAIL watchdog configuration");
  }
#endif

  Wire.begin(kI2cSda, kI2cScl, 100000);
  resetDisplayController();
#if defined(ANGRY_CAT_SIMULATOR)
  const bool displayReady = display.begin(GFX_SKIP_OUTPUT_BEGIN);
  const bool simulatorDisplayReady =
      displayReady &&
      angry_cat_simulator::beginDisplay(kScreenWidth, kScreenHeight);
#else
  const bool displayReady = display.begin(32000000);
#endif
  if (!displayReady) {
    Serial.println("ERROR: display or PSRAM framebuffer initialization failed");
    while (true)
      delay(1000);
  }
  pinMode(kBacklight, OUTPUT);
  digitalWrite(kBacklight, HIGH);
  if (!beginTouch()) {
    Serial.println("ERROR: touch controller was not found at 0x3B");
    while (true)
      delay(1000);
  }

  Serial.printf(
      "Flash: %lu MB, PSRAM: %lu MB\n",
      static_cast<unsigned long>(ESP.getFlashChipSize() / (1024 * 1024)),
      static_cast<unsigned long>(ESP.getPsramSize() / (1024 * 1024)));
  Serial.println("Touch controller: ready at 0x3B");
  const bool audioReady = audio.begin();
  pinMode(kBootButtonPin, INPUT_PULLUP);
  loadVolumeStep();
  loadCompanion();
  Serial.printf("Audio: %s; microphone: %s; volume step %u/%u\n",
                audioReady ? "ES8311 ready" : "unavailable",
                audio.isMicrophoneReady() ? "ready on GPIO 14" : "unavailable",
                audio.volumeStep() + 1, AngryCatAudio::kVolumeStepCount);
  Serial.printf("BOOT button on GPIO %d: press for volume, hold to reset\n",
                kBootButtonPin);
  Serial.printf("Cloudflare interviewer: %s\n",
                interviewer.isConfigured() ? "configured" : "not configured");

  eventQueue = xQueueCreate(12, sizeof(InterviewerEvent));
  if (eventQueue == nullptr) {
    Serial.println("ERROR: could not create interviewer event queue");
    while (true)
      delay(1000);
  }
#if defined(ANGRY_CAT_SIMULATOR_LIVE)
  simulatorTextAnswerQueue = xQueueCreate(4, sizeof(SimulatorTextAnswer));
  if (simulatorTextAnswerQueue == nullptr) {
    Serial.println("SIM_INTEGRATION: FAIL text answer queue allocation");
    while (true)
      delay(1000);
  }
  Serial.setTimeout(100);
#endif
  appView = AppView::Topics;
  renderScreen();
  if (audioReady &&
      xTaskCreatePinnedToCore(primeAudioDuringWifi, "audio-prime", 3072, &audio,
                              1, nullptr, 0) != pdPASS) {
    Serial.println("Audio: could not start speaker prime task");
  }
  configureWiFi();
  appView = AppView::Topics;
  renderScreen();
#if defined(ANGRY_CAT_SIMULATOR)
  if (audioReady && audio.isMicrophoneReady() &&
      display.getFramebuffer() != nullptr && eventQueue != nullptr &&
      simulatorDisplayReady && WiFi.status() == WL_CONNECTED
#if defined(ANGRY_CAT_SIMULATOR_LIVE)
      && interviewer.isConfigured() && tlsClockReady &&
      simulatorTextAnswerQueue != nullptr
#endif
  ) {
#if defined(ANGRY_CAT_SIMULATOR_LIVE)
    Serial.println("SIM_INTEGRATION: READY");
#else
    Serial.println("SIM_TEST: READY");
#endif
  } else {
#if defined(ANGRY_CAT_SIMULATOR_LIVE)
    Serial.println("SIM_INTEGRATION: FAIL boot invariants");
#else
    Serial.println("SIM_TEST: FAIL boot invariants");
#endif
  }
#endif
}

void loop() {
  handleSerial();
  processInterviewerEvents();
#if defined(ANGRY_CAT_SIMULATOR)
  if (simulatorEventCheckPending && questionNumber == 2 &&
      strcmp(currentDomain, "SIMULATED DOMAIN") == 0) {
    simulatorEventCheckPending = false;
    Serial.println("SIM_TEST: event queue passed");
  }
#endif
  pollButton();
  TouchPoint point{};
  const uint32_t now = millis();
  const bool rawTouched = readTouch(point);
  if (rawTouched)
    lastTouchSeenMs = now;
  const bool touched =
      rawTouched ||
      (wasTouched && now - lastTouchSeenMs < kTouchReleaseDebounceMs);
  if (rawTouched && !wasTouched) {
    if (appView == AppView::Topics && point.y >= kTopicGridY &&
        point.y < kTopicGridY + 5 * kTopicRowHeight) {
      const uint8_t column = point.x < kScreenWidth / 2 ? 0 : 1;
      const uint8_t row =
          constrain((point.y - kTopicGridY) / kTopicRowHeight, 0, 4);
      selectedTopicIndex = column * 5 + row;
      Serial.printf("Topic touch: x=%u y=%u index=%u id=%s\n", point.x, point.y,
                    selectedTopicIndex, kStudyTopics[selectedTopicIndex].id);
      touchTracking = false;
      if (WiFi.status() != WL_CONNECTED && !configureWiFi()) {
        appView = AppView::Topics;
        renderScreen();
      } else {
        startInterview();
      }
#if defined(ANGRY_CAT_SIMULATOR)
      if (simulatorTopicCheckPending && selectedTopicIndex == 0 &&
          screenStatus == ScreenStatus::Error && !sessionActive) {
        simulatorTopicCheckPending = false;
        Serial.println("SIM_TEST: topic guard passed");
      }
#endif
    } else {
      touchTracking = true;
      longPressHandled = false;
      touchStartedMs = now;
      touchStart = point;
      lastTouch = point;
    }
  } else if (rawTouched && touchTracking) {
    lastTouch = point;
  }

  if (touchTracking && !longPressHandled &&
      now - touchStartedMs >= kLongPressMs) {
    const int movement = abs(static_cast<int>(lastTouch.x) - touchStart.x) +
                         abs(static_cast<int>(lastTouch.y) - touchStart.y);
    if (movement < 70) {
      longPressHandled = true;
      touchTracking = false;
      handleLongPress();
    }
  }

  const bool released = wasTouched && !touched;
  wasTouched = touched;
  if (released && touchTracking) {
    const uint32_t duration = millis() - touchStartedMs;
    const int movement = abs(static_cast<int>(lastTouch.x) - touchStart.x) +
                         abs(static_cast<int>(lastTouch.y) - touchStart.y);
    touchTracking = false;
    if (duration < kLongPressMs && appView == AppView::Review) {
      const int horizontalMovement =
          static_cast<int>(lastTouch.x) - static_cast<int>(touchStart.x);
      const uint8_t pageCount = interviewer.report().scoreCount + 1;
      if (horizontalMovement <= -60 && reviewPage + 1 < pageCount) {
        ++reviewPage;
      } else if (horizontalMovement >= 60 && reviewPage > 0) {
        --reviewPage;
      } else if (movement < 50 && pageCount > 1) {
        reviewPage = (reviewPage + 1) % pageCount;
      }
      renderScreen();
    } else if (duration < kLongPressMs && appView == AppView::Interview) {
      if (sessionActive && screenStatus == ScreenStatus::Listening &&
          movement < 70) {
        commitTurnRequested.store(true);
        setScreenStatus(ScreenStatus::Thinking,
                        "ANSWER COMMITTED - GEMINI IS RESPONDING");
      } else if (!sessionActive && !reviewLoading) {
        appView = AppView::Topics;
        renderScreen();
      }
    }
  }
  if (released)
    longPressHandled = false;

  // Clear the overlay once it expires; renderScreen redraws without it.
  if (volumeOverlayShown && now >= volumeOverlayUntilMs) {
    volumeOverlayShown = false;
    screenDirty = true;
  }

  if (screenDirty) {
    renderScreen();
    if (now < volumeOverlayUntilMs) {
      // renderScreen has already flushed; paint over the canvas and flush the
      // overlay on top of it.
      volumeOverlayShown = true;
      drawVolumeOverlay();
      flushDisplay();
    }
  } else {
    updateAnimation();
  }
  delay(15);
}
