#include "angry_cat_audio.h"

#include "libraries/es8311/src/es8311.h"

namespace {

constexpr int kI2sMclk = 44;
constexpr int kI2sDataOut = 16;
constexpr int kI2sDataIn = 14;
constexpr int kI2sBitClock = 13;
constexpr int kI2sWordSelect = 15;
constexpr uint32_t kVoiceSampleRate = 16000;
constexpr uint32_t kMclkFrequency = kVoiceSampleRate * 256;
constexpr int kCodecVolumePercent = 80;
constexpr uint8_t kPlayerVolume = 18;
constexpr size_t kPcmSamplesPerFrame = 320;
constexpr int16_t kSilentStereoFrame[kPcmSamplesPerFrame * 2] = {};

} // namespace

bool AngryCatAudio::initializeCodec() {
  es8311_handle_t codec = es8311_create(I2C_NUM_0, ES8311_ADDRESS_0);
  if (codec == nullptr)
    return false;
  const es8311_clock_config_t clock = {
      .mclk_inverted = false,
      .sclk_inverted = false,
      .mclk_from_mclk_pin = true,
      .mclk_frequency = kMclkFrequency,
      .sample_frequency = kVoiceSampleRate,
  };
  const bool initialized =
      es8311_init(codec, &clock, ES8311_RESOLUTION_16, ES8311_RESOLUTION_16) ==
          ESP_OK &&
      es8311_voice_volume_set(codec, kCodecVolumePercent, nullptr) == ESP_OK &&
      es8311_microphone_config(codec, false) == ESP_OK;
  es8311_delete(codec);
  return initialized;
}

bool AngryCatAudio::begin() {
  if (!initializeCodec()) {
    Serial.println("Angry Cat audio: ES8311 not found at 0x18");
    return false;
  }
  // TX and RX must use one full-duplex I2S peripheral. Creating a separate
  // slave receiver on these same BCLK/LRCK pins makes Arduino's peripheral
  // manager detach the master transmitter, leaving the microphone unclocked.
  audioBus_.setPins(kI2sBitClock, kI2sWordSelect, kI2sDataOut, kI2sDataIn,
                    kI2sMclk);
  if (!audioBus_.begin(I2S_MODE_STD, kVoiceSampleRate, I2S_DATA_BIT_WIDTH_16BIT,
                       I2S_SLOT_MODE_STEREO, I2S_STD_SLOT_BOTH,
                       I2S_ROLE_MASTER)) {
    Serial.println("Angry Cat audio: I2S pin setup failed");
    return false;
  }
  if (!audioBus_.configureRX(kVoiceSampleRate, I2S_DATA_BIT_WIDTH_16BIT,
                             I2S_SLOT_MODE_STEREO,
                             I2S_RX_TRANSFORM_16_STEREO_TO_MONO)) {
    Serial.println("Angry Cat audio: microphone mono transform failed");
    audioBus_.end();
    return false;
  }
  microphoneReady_ = true;
  ready_ = true;
  return true;
}

bool AngryCatAudio::isMicrophoneReady() const {
  return ready_ && microphoneReady_;
}

bool AngryCatAudio::playPcm16(const uint8_t *data, size_t size) {
  if (!ready_ || data == nullptr || size < 2 || size % 2 != 0)
    return false;
  int16_t stereo[kPcmSamplesPerFrame * 2];
  const int16_t *mono = reinterpret_cast<const int16_t *>(data);
  const size_t samples = size / sizeof(int16_t);
  size_t offset = 0;
  while (offset < samples) {
    const size_t chunkSamples = min(kPcmSamplesPerFrame, samples - offset);
    for (size_t index = 0; index < chunkSamples; ++index) {
      const int32_t scaled =
          static_cast<int32_t>(mono[offset + index]) * kPlayerVolume / 21;
      stereo[index * 2] = static_cast<int16_t>(scaled);
      stereo[index * 2 + 1] = static_cast<int16_t>(scaled);
    }
    const size_t stereoBytes = chunkSamples * 2 * sizeof(int16_t);
    if (audioBus_.write(reinterpret_cast<const uint8_t *>(stereo),
                        stereoBytes) != stereoBytes) {
      return false;
    }
    offset += chunkSamples;
  }
  return true;
}

size_t AngryCatAudio::readPcm16(uint8_t *output, size_t outputCapacity) {
  if (!isMicrophoneReady() || output == nullptr ||
      outputCapacity < kPcmSamplesPerFrame * sizeof(int16_t)) {
    return 0;
  }

  // Full-duplex I2S starts RX and TX together. Sending one silent 20 ms frame
  // advances both DMA channels, then the matching microphone frame can be
  // drained without feeding speaker output back into the recording.
  if (audioBus_.write(kSilentStereoFrame, sizeof(kSilentStereoFrame)) !=
      sizeof(kSilentStereoFrame)) {
    return 0;
  }
  return audioBus_.readBytes(reinterpret_cast<char *>(output),
                             kPcmSamplesPerFrame * sizeof(int16_t));
}
