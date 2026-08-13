#pragma once

#include <Arduino.h>

#if !defined(ANGRY_CAT_SIMULATOR)
#include <ESP_I2S.h>
#endif

class AngryCatAudio {
public:
  bool begin();
  bool isMicrophoneReady() const;
  bool playPcm16(const uint8_t *data, size_t size);
  size_t readPcm16(uint8_t *output, size_t outputCapacity);
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
};
