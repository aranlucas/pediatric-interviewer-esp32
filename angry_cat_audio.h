#pragma once

#include <ESP_I2S.h>

class AngryCatAudio {
public:
  bool begin();
  bool isMicrophoneReady() const;
  bool playPcm16(const uint8_t *data, size_t size);
  size_t readPcm16(uint8_t *output, size_t outputCapacity);

private:
  bool initializeCodec();

  I2SClass audioBus_{I2S_NUM_0};
  bool microphoneReady_ = false;
  bool ready_ = false;
};
