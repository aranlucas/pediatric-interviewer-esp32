#include "wokwi-api.h"

#include <stdio.h>
#include <stdlib.h>

#define DISPLAY_WIDTH 160
#define DISPLAY_HEIGHT 80
#define PACKET_SIZE 10
#define SPI_BUFFER_SIZE 64

typedef struct {
  pin_t cs_pin;
  spi_dev_t spi;
  uint8_t spi_buffer[SPI_BUFFER_SIZE];
  buffer_t framebuffer;
  uint32_t display_width;
  uint32_t display_height;
  uint32_t pixels[DISPLAY_WIDTH * DISPLAY_HEIGHT];
  uint8_t parser_index;
  uint8_t packet[PACKET_SIZE];
} chip_state_t;

static const uint8_t packet_magic[] = {'A', 'C', 'W', '1'};

static void fill_rect(chip_state_t *chip, uint32_t x, uint32_t y,
                      uint32_t width, uint32_t height, uint32_t color) {
  for (uint32_t row = y; row < y + height && row < DISPLAY_HEIGHT; ++row) {
    for (uint32_t column = x; column < x + width && column < DISPLAY_WIDTH;
         ++column) {
      chip->pixels[row * DISPLAY_WIDTH + column] = color;
    }
  }
}

static void render_status(chip_state_t *chip, bool connected, int8_t rssi) {
  const uint32_t background = 0xff121a2e;
  const uint32_t panel = 0xff223052;
  const uint32_t connected_color = 0xff55d68c;
  const uint32_t disconnected_color = 0xffef6471;
  const uint32_t inactive = 0xff4b5874;
  fill_rect(chip, 0, 0, DISPLAY_WIDTH, DISPLAY_HEIGHT, background);
  fill_rect(chip, 10, 10, 140, 60, panel);
  fill_rect(chip, 20, 22, 18, 36,
            connected ? connected_color : disconnected_color);

  uint32_t bars = 0;
  if (connected) {
    if (rssi >= -55)
      bars = 4;
    else if (rssi >= -67)
      bars = 3;
    else if (rssi >= -75)
      bars = 2;
    else
      bars = 1;
  }
  for (uint32_t bar = 0; bar < 4; ++bar) {
    const uint32_t height = 8 + bar * 10;
    fill_rect(chip, 58 + bar * 20, 58 - height, 12, height,
              bar < bars ? connected_color : inactive);
  }
  buffer_write(chip->framebuffer, 0, (uint8_t *)chip->pixels,
               sizeof(chip->pixels));
}

static void process_packet(chip_state_t *chip) {
  const bool connected = chip->packet[4] != 0;
  const int8_t rssi = (int8_t)chip->packet[5];
  render_status(chip, connected, rssi);
  printf("SIM_WIFI: %s rssi=%d ip=%u.%u.%u.%u\n",
         connected ? "connected" : "disconnected", rssi, chip->packet[6],
         chip->packet[7], chip->packet[8], chip->packet[9]);
}

static void process_byte(chip_state_t *chip, uint8_t value) {
  if (chip->parser_index < sizeof(packet_magic)) {
    if (value == packet_magic[chip->parser_index]) {
      chip->packet[chip->parser_index++] = value;
    } else {
      chip->parser_index = value == packet_magic[0] ? 1 : 0;
      if (chip->parser_index == 1)
        chip->packet[0] = value;
    }
    return;
  }

  chip->packet[chip->parser_index++] = value;
  if (chip->parser_index == PACKET_SIZE) {
    process_packet(chip);
    chip->parser_index = 0;
  }
}

static void spi_done(void *user_data, uint8_t *buffer, uint32_t count) {
  chip_state_t *chip = (chip_state_t *)user_data;
  for (uint32_t index = 0; index < count; ++index)
    process_byte(chip, buffer[index]);
  if (pin_read(chip->cs_pin) == LOW)
    spi_start(chip->spi, chip->spi_buffer, sizeof(chip->spi_buffer));
}

static void cs_changed(void *user_data, pin_t pin, uint32_t value) {
  chip_state_t *chip = (chip_state_t *)user_data;
  (void)pin;
  if (value == LOW)
    spi_start(chip->spi, chip->spi_buffer, sizeof(chip->spi_buffer));
  else
    spi_stop(chip->spi);
}

void chip_init(void) {
  chip_state_t *chip = calloc(1, sizeof(chip_state_t));
  chip->cs_pin = pin_init("CS", INPUT_PULLUP);
  const pin_watch_config_t cs_watch = {
      .user_data = chip,
      .edge = BOTH,
      .pin_change = cs_changed,
  };
  pin_watch(chip->cs_pin, &cs_watch);

  const spi_config_t spi_config = {
      .user_data = chip,
      .sck = pin_init("SCK", INPUT),
      .mosi = pin_init("MOSI", INPUT),
      .miso = NO_PIN,
      .mode = 0,
      .done = spi_done,
  };
  chip->spi = spi_init(&spi_config);
  chip->framebuffer =
      framebuffer_init(&chip->display_width, &chip->display_height);
  render_status(chip, false, -127);
  printf("SIM_WIFI: status monitor ready; ESP32 radio remains Wokwi-native\n");
}
