#pragma once

#include <stddef.h>
#include <stdint.h>

namespace angry_cat_simulator {

bool beginAudio();
bool playPcm16(const uint8_t *data, size_t size);
size_t readPcm16(uint8_t *output, size_t outputCapacity);
void queueAnswer();
bool beginDisplay(uint16_t width, uint16_t height);
void showDisplay(const uint16_t *framebuffer, uint16_t width, uint16_t height);
bool readTouch(uint16_t &x, uint16_t &y);
void showWifiStatus(bool connected, int32_t rssi, const uint8_t ip[4]);
void showMicrophoneText(const char *text, bool waiting);
void playSpeakerTestTone();

} // namespace angry_cat_simulator
