#pragma once

#include <stddef.h>
#include <stdint.h>

namespace angry_cat_simulator {

bool beginAudio();
bool playPcm16(const uint8_t *data, size_t size);
size_t readPcm16(uint8_t *output, size_t outputCapacity);
void queueAnswer();

} // namespace angry_cat_simulator
