// Arduino CLI profiles cannot be combined with --library, so this adapter
// compiles the untouched driver source from the pinned Waveshare submodule as
// part of the sketch.
#include "../../third_party/waveshare/Arduino/libraries/esp_lcd_touch_axs15231b/esp_lcd_touch_axs15231b.cpp"
