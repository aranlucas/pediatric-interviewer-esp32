#include "cat_companion.h"

#include <string.h>

namespace {

constexpr uint32_t kCompanionMagic = 0x41434154; // "ACAT"
constexpr uint8_t kCompanionVersion = 1;
constexpr uint8_t kCompanionOutcomePass = 1;
constexpr uint8_t kCompanionOutcomeBorderline = 2;
constexpr uint8_t kCompanionOutcomeNotYet = 3;
constexpr uint32_t kCompanionAloofAfterDays = 3;
constexpr uint32_t kCompanionProudForDays = 2;
constexpr uint32_t kCompanionEpochSecondsPerWeek = 7 * 86'400;

uint32_t dayOf(uint32_t nowEpoch) {
  return nowEpoch / kCompanionEpochSecondsPerDay;
}

} // namespace

CatCompanion::CatCompanion() : sessionOpen_(false), sessionDomainIndex_(0) {
  memset(&state_, 0, sizeof(state_));
}

bool CatCompanion::load(const uint8_t *blob, uint32_t length) {
  if (blob == nullptr || length != kBlobSize)
    return false;
  uint32_t magic = 0;
  memcpy(&magic, blob, sizeof(magic));
  if (magic != kCompanionMagic || blob[4] != kCompanionVersion)
    return false;
  CatCompanionState restored;
  memcpy(&restored, blob + 5, sizeof(restored));
  state_ = restored;
  sessionOpen_ = false;
  sessionDomainIndex_ = 0;
  return true;
}

uint32_t CatCompanion::serialize(uint8_t *blob, uint32_t capacity) const {
  if (blob == nullptr || capacity < kBlobSize)
    return 0;
  memcpy(blob, &kCompanionMagic, sizeof(kCompanionMagic));
  blob[4] = kCompanionVersion;
  memcpy(blob + 5, &state_, sizeof(state_));
  return kBlobSize;
}

void CatCompanion::recordJournal(uint32_t nowEpoch,
                                 CompanionJournalEvent type) {
  CompanionJournalEntry &entry = state_.journal[state_.journalCursor];
  entry.dayUtc = dayOf(nowEpoch);
  entry.hourUtc = static_cast<uint8_t>((nowEpoch / 3'600) % 24);
  entry.type = static_cast<uint8_t>(type);
  state_.journalCursor = static_cast<uint8_t>((state_.journalCursor + 1) %
                                              kCompanionJournalEntries);
}

void CatCompanion::touchSchedule(uint32_t nowEpoch) {
  const uint32_t week = nowEpoch / kCompanionEpochSecondsPerWeek;
  if (state_.lastScheduleWeek != 0 && week > state_.lastScheduleWeek) {
    const uint32_t decay =
        week - state_.lastScheduleWeek > 8 ? 8 : week - state_.lastScheduleWeek;
    for (uint8_t bucket = 0; bucket < kCompanionScheduleBuckets; ++bucket)
      state_.scheduleEma[bucket] >>= decay;
  }
  state_.lastScheduleWeek = week;
  const uint8_t hour = static_cast<uint8_t>((nowEpoch / 3'600) % 24);
  state_.scheduleEma[hour] +=
      static_cast<uint8_t>((255 - state_.scheduleEma[hour]) / 4);
}

bool CatCompanion::onSessionStarted(uint32_t nowEpoch, uint8_t domainIndex) {
  if (nowEpoch < kCompanionMinimumValidEpoch ||
      domainIndex >= kCompanionDomainCount)
    return false;
  sessionOpen_ = true;
  sessionDomainIndex_ = domainIndex;
  touchSchedule(nowEpoch);
  recordJournal(nowEpoch, CompanionJournalEvent::Started);
  return true;
}

bool CatCompanion::onSessionCompleted(uint32_t nowEpoch,
                                      CompanionOutcome outcome) {
  if (!sessionOpen_)
    return false;
  sessionOpen_ = false;
  if (nowEpoch < kCompanionMinimumValidEpoch)
    return false;

  const uint32_t today = dayOf(nowEpoch);
  if (state_.totalInterviews == 0 || state_.lastStudyDayUtc != today) {
    const uint32_t yesterday = today - 1;
    state_.streakDays =
        state_.totalInterviews > 0 && state_.lastStudyDayUtc == yesterday
            ? static_cast<uint16_t>(state_.streakDays + 1)
            : 1;
    if (state_.streakDays > state_.bestStreak)
      state_.bestStreak = state_.streakDays;
    state_.lastStudyDayUtc = today;
  }

  state_.domainCounts[sessionDomainIndex_] += 1;
  state_.domainLastDayUtc[sessionDomainIndex_] = today;
  state_.totalInterviews += 1;
  switch (outcome) {
  case CompanionOutcome::Pass:
    state_.passCount += 1;
    state_.lastOutcome = kCompanionOutcomePass;
    break;
  case CompanionOutcome::Borderline:
    state_.borderlineCount += 1;
    state_.lastOutcome = kCompanionOutcomeBorderline;
    break;
  case CompanionOutcome::NotYet:
    state_.notYetCount += 1;
    state_.lastOutcome = kCompanionOutcomeNotYet;
    break;
  }
  recordJournal(nowEpoch, CompanionJournalEvent::Completed);
  return true;
}

bool CatCompanion::onSessionAbandoned(uint32_t nowEpoch) {
  if (!sessionOpen_)
    return false;
  sessionOpen_ = false;
  if (nowEpoch < kCompanionMinimumValidEpoch)
    return false;
  recordJournal(nowEpoch, CompanionJournalEvent::Abandoned);
  return true;
}

CompanionMood CatCompanion::mood(uint32_t nowEpoch) const {
  if (state_.totalInterviews == 0)
    return CompanionMood::Curious;
  const uint32_t today = nowEpoch < kCompanionMinimumValidEpoch
                             ? state_.lastStudyDayUtc
                             : dayOf(nowEpoch);
  const uint32_t idleDays =
      today > state_.lastStudyDayUtc ? today - state_.lastStudyDayUtc : 0;
  if (idleDays >= kCompanionAloofAfterDays)
    return CompanionMood::Aloof;
  if (idleDays <= kCompanionProudForDays &&
      state_.lastOutcome == kCompanionOutcomePass)
    return CompanionMood::Proud;
  if (idleDays <= kCompanionProudForDays &&
      state_.lastOutcome == kCompanionOutcomeNotYet)
    return CompanionMood::Determined;
  return CompanionMood::Content;
}

const char *CatCompanion::moodPhrase(CompanionMood mood) const {
  switch (mood) {
  case CompanionMood::Curious:
    return "A NEW CAT AWAITS YOUR FIRST CASE";
  case CompanionMood::Proud:
    return "CAT IS PROUD OF YOUR LAST ROUND";
  case CompanionMood::Determined:
    return "CAT WANTS A REMATCH";
  case CompanionMood::Aloof:
    return "THE CAT ALOOFLY WAITS FOR YOU";
  default:
    return "CAT IS READY FOR ROUNDS";
  }
}

uint8_t CatCompanion::peakStudyHour() const {
  uint8_t best = 0;
  for (uint8_t bucket = 1; bucket < kCompanionScheduleBuckets; ++bucket) {
    if (state_.scheduleEma[bucket] > state_.scheduleEma[best])
      best = bucket;
  }
  return best;
}
