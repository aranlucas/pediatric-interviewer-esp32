#include "angry_cat_audio.h"

constexpr uint8_t AngryCatAudio::kVolumeNumerators[];

void AngryCatAudio::setVolumeStep(uint8_t step) {
  volumeStep_ = step > kLoudestVolumeStep ? kLoudestVolumeStep : step;
}

uint8_t AngryCatAudio::cycleVolumeStep() {
  volumeStep_ = volumeStep_ >= kLoudestVolumeStep ? 0 : volumeStep_ + 1;
  return volumeStep_;
}

#if defined(ANGRY_CAT_SIMULATOR)

#include <AngryCatSimulator.h>

bool AngryCatAudio::begin() {
  ready_ = angry_cat_simulator::beginAudio();
  microphoneReady_ = ready_;
  return ready_;
}

bool AngryCatAudio::isMicrophoneReady() const {
  return ready_ && microphoneReady_;
}

bool AngryCatAudio::primePlayback() { return ready_; }

bool AngryCatAudio::playPcm16(const uint8_t *data, size_t size) {
  return ready_ && angry_cat_simulator::playPcm16(data, size);
}

size_t AngryCatAudio::readPcm16(uint8_t *output, size_t outputCapacity) {
  return isMicrophoneReady()
             ? angry_cat_simulator::readPcm16(output, outputCapacity)
             : 0;
}

#if defined(ANGRY_CAT_SIMULATOR_LIVE)
void AngryCatAudio::queueSimulatorAnswer() {
  angry_cat_simulator::queueAnswer();
}
#endif

#else

#include <Wire.h>

namespace {

constexpr uint8_t kCodecAddress = 0x18;
constexpr int kI2sMclk = 44;
constexpr int kI2sDataOut = 16;
constexpr int kI2sDataIn = 14;
constexpr int kI2sBitClock = 13;
constexpr int kI2sWordSelect = 15;
// Gemini Live emits native 24 kHz PCM. Keep the codec and I2S bus at that
// rate so playback retains the model's full speech bandwidth. Microphone audio
// uses the same full-duplex clock and Gemini resamples the 24 kHz input.
constexpr uint32_t kVoiceSampleRate = 24000;
constexpr uint8_t kCodecVolume80Percent = 0xCB;
constexpr size_t kPcmSamplesPerFrame = 480;
constexpr uint8_t kPlaybackPrimeFrames = 5;
constexpr int16_t kSilentStereoFrame[kPcmSamplesPerFrame * 2] = {};

} // namespace

bool AngryCatAudio::writeCodecRegister(uint8_t address, uint8_t value) {
  Wire.beginTransmission(kCodecAddress);
  Wire.write(address);
  Wire.write(value);
  return Wire.endTransmission() == 0;
}

bool AngryCatAudio::initializeCodec() {
  if (!writeCodecRegister(0x00, 0x1F))
    return false;
  delay(20);

  // Waveshare's verified ES8311 sequence for 16-bit I2S with a 256x MCLK.
  // The divider ratio is unchanged at 24 kHz; I2S supplies a 6.144 MHz MCLK.
  const uint8_t configuration[][2] = {
      {0x00, 0x00}, {0x00, 0x80},
      {0x01, 0x3F}, {0x02, 0x00},
      {0x03, 0x10}, {0x04, 0x10},
      {0x05, 0x00}, {0x06, 0x03},
      {0x07, 0x00}, {0x08, 0xFF},
      {0x00, 0x80}, {0x09, 0x0C},
      {0x0A, 0x0C}, {0x0D, 0x01},
      {0x0E, 0x02}, {0x12, 0x00},
      {0x13, 0x10}, {0x17, 0xC8},
      {0x14, 0x1A}, {0x1C, 0x6A},
      {0x37, 0x08}, {0x32, kCodecVolume80Percent},
  };
  for (const auto &entry : configuration) {
    if (!writeCodecRegister(entry[0], entry[1]))
      return false;
  }
  return true;
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
  microphoneReady_ = audioBus_.rxChan() != nullptr;
  if (!microphoneReady_)
    Serial.println("Angry Cat audio: microphone I2S setup failed");
  ready_ = true;
  return true;
}

bool AngryCatAudio::isMicrophoneReady() const {
  return ready_ && microphoneReady_;
}

bool AngryCatAudio::primePlayback() {
  if (!ready_)
    return false;

  // Keep I2S, its DMA buffers, the codec DAC, and the speaker output at a
  // settled zero level before the first real waveform arrives. Five 20 ms
  // frames are long enough to fill the ESP32 TX descriptors and reach the
  // physical output without adding time to Wi-Fi startup.
  for (uint8_t frame = 0; frame < kPlaybackPrimeFrames; ++frame) {
    if (audioBus_.write(kSilentStereoFrame, sizeof(kSilentStereoFrame)) !=
        sizeof(kSilentStereoFrame)) {
      return false;
    }
  }
  return true;
}

bool AngryCatAudio::playPcm16(const uint8_t *data, size_t size) {
  if (!ready_ || data == nullptr || size < 2 || size % 2 != 0)
    return false;

  int16_t stereo[kPcmSamplesPerFrame * 2];
  const int16_t *mono = reinterpret_cast<const int16_t *>(data);
  const size_t samples = size / sizeof(int16_t);
  const uint8_t numerator = kVolumeNumerators[volumeStep_];
  const bool unityGain = numerator >= kVolumeScaleDenominator;
  size_t offset = 0;
  while (offset < samples) {
    const size_t chunkSamples = min(kPcmSamplesPerFrame, samples - offset);
    for (size_t index = 0; index < chunkSamples; ++index) {
      // At the top step the sample is passed through rather than scaled, so
      // the loudest setting cannot lose a bit to integer division.
      const int16_t speakerSample =
          unityGain ? mono[offset + index]
                    : static_cast<int16_t>(
                          static_cast<int32_t>(mono[offset + index]) *
                          numerator / kVolumeScaleDenominator);
      stereo[index * 2] = speakerSample;
      stereo[index * 2 + 1] = speakerSample;
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
  int16_t input[kPcmSamplesPerFrame * 2];
  const size_t bytesRead =
      audioBus_.readBytes(reinterpret_cast<char *>(input), sizeof(input));
  const size_t framesRead = bytesRead / (2 * sizeof(int16_t));
  int16_t *pcm = reinterpret_cast<int16_t *>(output);
  size_t outputSamples = 0;
  for (size_t frame = 0;
       frame < framesRead && outputSamples < kPcmSamplesPerFrame; ++frame) {
    const int16_t left = input[frame * 2];
    const int16_t right = input[frame * 2 + 1];
    pcm[outputSamples++] =
        abs(static_cast<int32_t>(left)) >= abs(static_cast<int32_t>(right))
            ? left
            : right;
  }
  return outputSamples * sizeof(int16_t);
}

#endif
