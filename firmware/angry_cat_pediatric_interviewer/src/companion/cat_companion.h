#pragma once

#include <stdint.h>

constexpr uint8_t kCompanionDomainCount = 10;
constexpr uint8_t kCompanionJournalEntries = 8;
constexpr uint8_t kCompanionScheduleBuckets = 24;
constexpr uint32_t kCompanionMinimumValidEpoch = 1704067200;
constexpr uint32_t kCompanionEpochSecondsPerDay = 86'400;

enum class CompanionMood : uint8_t {
  Curious,
  Content,
  Proud,
  Determined,
  Aloof,
};

enum class CompanionOutcome : uint8_t {
  Pass,
  Borderline,
  NotYet,
};

enum class CompanionJournalEvent : uint8_t {
  Started = 1,
  Completed = 2,
  Abandoned = 3,
};

struct CompanionJournalEntry {
  uint32_t dayUtc;
  uint8_t hourUtc;
  uint8_t type;
};

struct CatCompanionState {
  uint16_t streakDays;
  uint16_t bestStreak;
  uint32_t lastStudyDayUtc;
  uint16_t totalInterviews;
  uint16_t passCount;
  uint16_t borderlineCount;
  uint16_t notYetCount;
  uint8_t lastOutcome;
  uint8_t scheduleEma[kCompanionScheduleBuckets];
  uint32_t lastScheduleWeek;
  uint16_t domainCounts[kCompanionDomainCount];
  uint32_t domainLastDayUtc[kCompanionDomainCount];
  CompanionJournalEntry journal[kCompanionJournalEntries];
  uint8_t journalCursor;
};

static_assert(sizeof(CatCompanionState) <= 256,
              "companion state is persisted as one NVS blob");

class CatCompanion {
public:
  CatCompanion();

  bool load(const uint8_t *blob, uint32_t length);
  uint32_t serialize(uint8_t *blob, uint32_t capacity) const;
  static constexpr uint32_t kBlobSize = 5 + sizeof(CatCompanionState);

  bool onSessionStarted(uint32_t nowEpoch, uint8_t domainIndex);
  bool onSessionCompleted(uint32_t nowEpoch, CompanionOutcome outcome);
  bool onSessionAbandoned(uint32_t nowEpoch);

  CompanionMood mood(uint32_t nowEpoch) const;
  const char *moodPhrase(CompanionMood mood) const;
  uint16_t streakDays() const { return state_.streakDays; }
  uint16_t totalInterviews() const { return state_.totalInterviews; }
  uint8_t peakStudyHour() const;

private:
  void recordJournal(uint32_t nowEpoch, CompanionJournalEvent type);
  void touchSchedule(uint32_t nowEpoch);

  CatCompanionState state_;
  bool sessionOpen_;
  uint8_t sessionDomainIndex_;
};
