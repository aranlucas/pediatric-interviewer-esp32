#include "wokwi-api.h"

#include <stdio.h>
#include <stdlib.h>

#define DISPLAY_WIDTH 200
#define DISPLAY_HEIGHT 80
#define MAX_TEXT_BYTES 320
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
  bool waiting;
  uint16_t expected_text_bytes;
  uint16_t received_text_bytes;
  char text[MAX_TEXT_BYTES + 1];
} chip_state_t;

static const uint8_t packet_magic[] = {'A', 'C', 'M', '1'};

static void fill_rect(chip_state_t *chip, uint32_t x, uint32_t y,
                      uint32_t width, uint32_t height, uint32_t color) {
  for (uint32_t row = y; row < y + height && row < DISPLAY_HEIGHT; ++row) {
    for (uint32_t column = x; column < x + width && column < DISPLAY_WIDTH;
         ++column) {
      chip->pixels[row * DISPLAY_WIDTH + column] = color;
    }
  }
}

static void render_status(chip_state_t *chip) {
  const uint32_t background = 0xff121a2e;
  const uint32_t panel = 0xff223052;
  const uint32_t waiting_color = 0xffffb84d;
  const uint32_t queued_color = 0xff55d68c;
  const uint32_t inactive = 0xff4b5874;
  const uint32_t active = chip->waiting ? waiting_color : queued_color;
  fill_rect(chip, 0, 0, DISPLAY_WIDTH, DISPLAY_HEIGHT, background);
  fill_rect(chip, 10, 10, 180, 60, panel);
  fill_rect(chip, 20, 20, 24, 40, active);

  const uint32_t active_bars = chip->waiting
                                   ? 1
                                   : 1 + chip->received_text_bytes * 7 /
                                             MAX_TEXT_BYTES;
  for (uint32_t bar = 0; bar < 8; ++bar) {
    const uint32_t height = 8 + (bar % 4) * 8;
    fill_rect(chip, 58 + bar * 15, 58 - height, 9, height,
              bar < active_bars ? active : inactive);
  }
  buffer_write(chip->framebuffer, 0, (uint8_t *)chip->pixels,
               sizeof(chip->pixels));
}

static void process_packet(chip_state_t *chip) {
  chip->text[chip->received_text_bytes] = '\0';
  render_status(chip);
  printf("SIM_MIC: %s text input (%u chars): %s\n",
         chip->waiting ? "awaiting" : "queued", chip->received_text_bytes,
         chip->text);
}

static void reset_parser(chip_state_t *chip) {
  chip->parser_index = 0;
  chip->expected_text_bytes = 0;
  chip->received_text_bytes = 0;
  chip->text[0] = '\0';
}

static void process_byte(chip_state_t *chip, uint8_t value) {
  if (chip->parser_index < sizeof(packet_magic)) {
    if (value == packet_magic[chip->parser_index]) {
      ++chip->parser_index;
    } else {
      chip->parser_index = value == packet_magic[0] ? 1 : 0;
    }
    return;
  }

  if (chip->parser_index == 4) {
    chip->waiting = value != 0;
    ++chip->parser_index;
    return;
  }
  if (chip->parser_index == 5) {
    chip->expected_text_bytes = value;
    ++chip->parser_index;
    return;
  }
  if (chip->parser_index == 6) {
    chip->expected_text_bytes |= (uint16_t)value << 8;
    if (chip->expected_text_bytes > MAX_TEXT_BYTES) {
      reset_parser(chip);
      return;
    }
    ++chip->parser_index;
    if (chip->expected_text_bytes == 0) {
      process_packet(chip);
      reset_parser(chip);
    }
    return;
  }

  chip->text[chip->received_text_bytes++] = (char)value;
  if (chip->received_text_bytes == chip->expected_text_bytes) {
    process_packet(chip);
    reset_parser(chip);
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
  chip->waiting = true;
  render_status(chip);
  printf("SIM_MIC: terminal-fed text microphone ready\n");
}
