#include "angry_cat_audio.h"

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

#include <AudioBoard.h>
#include <Wire.h>

namespace {

constexpr int kI2sMclk = 44;
constexpr int kI2sDataOut = 16;
constexpr int kI2sDataIn = 14;
constexpr int kI2sBitClock = 13;
constexpr int kI2sWordSelect = 15;
// Gemini Live emits native 24 kHz PCM. Keep the codec and I2S bus at that
// rate so playback retains the model's full speech bandwidth. Microphone audio
// uses the same full-duplex clock and Gemini resamples the 24 kHz input.
constexpr uint32_t kVoiceSampleRate = 24000;
constexpr int kCodecVolumePercent = 80;
constexpr uint8_t kPlayerVolume = 8;
// First-order 7.5 kHz low-pass at 24 kHz. The Q15 coefficient keeps the hot
// playback loop floating-point free while gently taming the small speaker's
// harsh upper range.
constexpr int32_t kLowPassAlphaQ15 = 28'167;
constexpr int32_t kLowPassQ15Scale = 32'768;
constexpr int32_t kSpeakerLimiterThreshold = 9'000;
constexpr int32_t kSpeakerLimiterRatio = 3;
constexpr uint32_t kPlaybackDspResetGapMs = 250;
constexpr size_t kPcmSamplesPerFrame = 480;
constexpr int16_t kSilentStereoFrame[kPcmSamplesPerFrame * 2] = {};

audio_driver::DriverDeviceInfo codecPins;
audio_driver::AudioBoard codecBoard(audio_driver::AudioDriverES8311, codecPins);

int16_t limitSpeakerPeak(int32_t sample) {
  const bool negative = sample < 0;
  int32_t magnitude = negative ? -sample : sample;
  if (magnitude > kSpeakerLimiterThreshold) {
    magnitude = kSpeakerLimiterThreshold +
                (magnitude - kSpeakerLimiterThreshold) / kSpeakerLimiterRatio;
  }
  return static_cast<int16_t>(negative ? -magnitude : magnitude);
}

} // namespace

bool AngryCatAudio::initializeCodec() {
  // The display reset expander, touch controller, and codec share Wire. The
  // sketch initializes that bus before audio, so the codec driver must reuse
  // it without taking ownership or changing the verified bus configuration.
  if (!codecPins.addI2C(audio_driver::PinFunction::CODEC, Wire, false))
    return false;

  audio_driver::CodecConfig config;
  config.input_device = audio_driver::ADC_INPUT_LINE1;
  config.output_device = audio_driver::DAC_OUTPUT_ALL;
  config.i2s.bits = audio_driver::BIT_LENGTH_16BITS;
  config.i2s.rate = audio_driver::RATE_24K;
  config.i2s.channels = audio_driver::CHANNELS2;
  config.i2s.fmt = audio_driver::I2S_NORMAL;
  config.i2s.mode = audio_driver::MODE_SLAVE;
  config.i2s.signal_type = audio_driver::SIGNAL_DIGITAL;

  return codecBoard.begin(config) && codecBoard.setVolume(kCodecVolumePercent);
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
  const uint32_t now = millis();
  if (lastPlaybackMs_ == 0 || now - lastPlaybackMs_ > kPlaybackDspResetGapMs)
    playbackLowPassState_ = 0;

  int16_t stereo[kPcmSamplesPerFrame * 2];
  const int16_t *mono = reinterpret_cast<const int16_t *>(data);
  const size_t samples = size / sizeof(int16_t);
  size_t offset = 0;
  while (offset < samples) {
    const size_t chunkSamples = min(kPcmSamplesPerFrame, samples - offset);
    for (size_t index = 0; index < chunkSamples; ++index) {
      const int32_t scaled =
          static_cast<int32_t>(mono[offset + index]) * kPlayerVolume / 21;
      playbackLowPassState_ +=
          ((scaled - playbackLowPassState_) * kLowPassAlphaQ15) /
          kLowPassQ15Scale;
      const int16_t speakerSample = limitSpeakerPeak(playbackLowPassState_);
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
  lastPlaybackMs_ = millis();
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

#endif
