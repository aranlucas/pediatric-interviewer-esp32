#pragma once

#include <Arduino.h>

#if !defined(ANGRY_CAT_SIMULATOR)
#include <ESP_I2S.h>
#endif

class AngryCatAudio {
public:
  // Playback attenuation steps, quietest first. The top step is unity gain:
  // samples pass through untouched, which is as loud as the codec setting
  // allows without adding gain in the ES8311 and risking clipping.
  static constexpr uint8_t kVolumeStepCount = 6;
  static constexpr uint8_t kVolumeScaleDenominator = 21;
  static constexpr uint8_t kVolumeNumerators[kVolumeStepCount] = {3,  6,  10,
                                                                  14, 18, 21};
  static constexpr uint8_t kLoudestVolumeStep = kVolumeStepCount - 1;

  bool begin();
  bool isMicrophoneReady() const;
  bool primePlayback();
  bool playPcm16(const uint8_t *data, size_t size);
  size_t readPcm16(uint8_t *output, size_t outputCapacity);

  /** Selects a playback step; values past the end clamp to the loudest. */
  void setVolumeStep(uint8_t step);
  uint8_t volumeStep() const { return volumeStep_; }
  /** Advances one step and wraps to the quietest, for a single-button cycle. */
  uint8_t cycleVolumeStep();
#if defined(ANGRY_CAT_SIMULATOR_LIVE)
  void queueSimulatorAnswer();
#endif

private:
#if !defined(ANGRY_CAT_SIMULATOR)
  bool writeCodecRegister(uint8_t address, uint8_t value);
  bool initializeCodec();

  I2SClass audioBus_{I2S_NUM_0};
#endif
  bool microphoneReady_ = false;
  bool ready_ = false;
  uint8_t volumeStep_ = kLoudestVolumeStep;
};
