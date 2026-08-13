#pragma once

#include <Arduino.h>

enum class AngryCatAnimation : uint8_t {
  Idle,
  Waving,
  Jumping,
  Failed,
  Waiting,
  Thinking,
  Review,
  Count,
};

struct AngryCatAnimationClip {
  uint8_t firstFrame;
  uint8_t frameCount;
  bool loops;
};

constexpr uint16_t kAngryCatFrameWidth = 144;
constexpr uint16_t kAngryCatFrameHeight = 156;
constexpr uint8_t kAngryCatFrameCount = 42;
constexpr uint8_t kAngryCatAnimationCount =
    static_cast<uint8_t>(AngryCatAnimation::Count);
constexpr uint32_t kAngryCatFramePixelCount =
    static_cast<uint32_t>(kAngryCatFrameWidth) * kAngryCatFrameHeight;
constexpr uint8_t kAngryCatTransparentIndex = 0;

extern const AngryCatAnimationClip
    kAngryCatAnimationClips[kAngryCatAnimationCount];
extern const uint16_t kAngryCatFrameDurationsMs[kAngryCatFrameCount];
extern const uint16_t kAngryCatPalette[256];
extern const uint8_t kAngryCatFrames[kAngryCatFrameCount]
                                    [kAngryCatFramePixelCount];
