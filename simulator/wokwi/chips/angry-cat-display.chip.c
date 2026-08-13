#include "wokwi-api.h"

#include <stdio.h>
#include <stdlib.h>

#define PACKET_HEADER_SIZE 12
#define SPI_BUFFER_SIZE 4096
#define MAX_DISPLAY_WIDTH 320

typedef enum {
  PARSER_MAGIC,
  PARSER_HEADER,
  PARSER_PIXELS,
} parser_state_t;

typedef struct {
  pin_t cs_pin;
  spi_dev_t spi;
  uint8_t spi_buffer[SPI_BUFFER_SIZE];
  buffer_t framebuffer;
  uint32_t width;
  uint32_t height;

  parser_state_t parser_state;
  uint8_t magic_index;
  uint8_t header[PACKET_HEADER_SIZE - 4];
  uint8_t header_index;
  uint16_t rect_x;
  uint16_t rect_y;
  uint16_t rect_width;
  uint16_t rect_height;
  uint32_t pixel_index;
  uint8_t low_byte;
  bool has_low_byte;
  bool first_frame_received;
  uint32_t row_rgba[MAX_DISPLAY_WIDTH];

  uint32_t touch_x_attr;
  uint32_t touch_y_attr;
  uint32_t touch_pressed_attr;
  uint16_t touch_x;
  uint16_t touch_y;
  bool touch_pressed;
  bool touch_initialized;
} chip_state_t;

static const uint8_t packet_magic[] = {'A', 'C', 'D', '1'};

static uint16_t read_u16(const uint8_t *data) {
  return (uint16_t)data[0] | ((uint16_t)data[1] << 8);
}

static uint32_t rgb565_to_rgba(uint16_t color) {
  const uint32_t red5 = (color >> 11) & 0x1f;
  const uint32_t green6 = (color >> 5) & 0x3f;
  const uint32_t blue5 = color & 0x1f;
  const uint32_t red8 = (red5 << 3) | (red5 >> 2);
  const uint32_t green8 = (green6 << 2) | (green6 >> 4);
  const uint32_t blue8 = (blue5 << 3) | (blue5 >> 2);
  return red8 | (green8 << 8) | (blue8 << 16) | 0xff000000;
}

static void reset_parser(chip_state_t *chip) {
  chip->parser_state = PARSER_MAGIC;
  chip->magic_index = 0;
  chip->header_index = 0;
  chip->pixel_index = 0;
  chip->has_low_byte = false;
}

static bool begin_rectangle(chip_state_t *chip) {
  chip->rect_x = read_u16(chip->header);
  chip->rect_y = read_u16(chip->header + 2);
  chip->rect_width = read_u16(chip->header + 4);
  chip->rect_height = read_u16(chip->header + 6);
  chip->pixel_index = 0;
  chip->has_low_byte = false;

  return chip->rect_width > 0 && chip->rect_height > 0 &&
         chip->rect_width <= MAX_DISPLAY_WIDTH &&
         (uint32_t)chip->rect_x + chip->rect_width <= chip->width &&
         (uint32_t)chip->rect_y + chip->rect_height <= chip->height;
}

static void finish_row(chip_state_t *chip, uint32_t row) {
  const uint32_t offset =
      ((chip->rect_y + row) * chip->width + chip->rect_x) * sizeof(uint32_t);
  buffer_write(chip->framebuffer, offset, (uint8_t *)chip->row_rgba,
               chip->rect_width * sizeof(uint32_t));
}

static void process_byte(chip_state_t *chip, uint8_t value) {
  if (chip->parser_state == PARSER_MAGIC) {
    if (value == packet_magic[chip->magic_index]) {
      chip->magic_index++;
      if (chip->magic_index == sizeof(packet_magic)) {
        chip->parser_state = PARSER_HEADER;
        chip->header_index = 0;
      }
    } else {
      chip->magic_index = value == packet_magic[0] ? 1 : 0;
    }
    return;
  }

  if (chip->parser_state == PARSER_HEADER) {
    chip->header[chip->header_index++] = value;
    if (chip->header_index == sizeof(chip->header)) {
      if (begin_rectangle(chip)) {
        chip->parser_state = PARSER_PIXELS;
      } else {
        printf("SIM_DISPLAY: rejected invalid rectangle\n");
        reset_parser(chip);
      }
    }
    return;
  }

  if (!chip->has_low_byte) {
    chip->low_byte = value;
    chip->has_low_byte = true;
    return;
  }

  const uint16_t rgb565 = (uint16_t)chip->low_byte | ((uint16_t)value << 8);
  chip->has_low_byte = false;
  const uint32_t column = chip->pixel_index % chip->rect_width;
  const uint32_t row = chip->pixel_index / chip->rect_width;
  chip->row_rgba[column] = rgb565_to_rgba(rgb565);
  chip->pixel_index++;

  if (column + 1 == chip->rect_width)
    finish_row(chip, row);

  if (chip->pixel_index == (uint32_t)chip->rect_width * chip->rect_height) {
    if (!chip->first_frame_received) {
      chip->first_frame_received = true;
      printf("SIM_DISPLAY: first visible frame received\n");
    }
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

static void prepare_touch_response(chip_state_t *chip) {
  const uint16_t x = attr_read(chip->touch_x_attr);
  const uint16_t y = attr_read(chip->touch_y_attr);
  const bool pressed = attr_read(chip->touch_pressed_attr) != 0;

  const bool changed = !chip->touch_initialized || x != chip->touch_x ||
                       y != chip->touch_y || pressed != chip->touch_pressed;
  chip->touch_x = x;
  chip->touch_y = y;
  chip->touch_pressed = pressed;
  chip->touch_initialized = true;
  chip->spi_buffer[0] = 'A';
  chip->spi_buffer[1] = 'C';
  chip->spi_buffer[2] = x & 0xff;
  chip->spi_buffer[3] = x >> 8;
  chip->spi_buffer[4] = y & 0xff;
  chip->spi_buffer[5] = y >> 8;
  chip->spi_buffer[6] = pressed ? 1 : 0;
  if (changed) {
    printf("SIM_TOUCH: %s at %u,%u\n", pressed ? "down" : "released", x, y);
  }
}

static void cs_changed(void *user_data, pin_t pin, uint32_t value) {
  chip_state_t *chip = (chip_state_t *)user_data;
  (void)pin;
  if (value == LOW) {
    prepare_touch_response(chip);
    spi_start(chip->spi, chip->spi_buffer, sizeof(chip->spi_buffer));
  } else {
    spi_stop(chip->spi);
  }
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
      .miso = pin_init("MISO", INPUT),
      .mode = 0,
      .done = spi_done,
  };
  chip->spi = spi_init(&spi_config);
  chip->framebuffer = framebuffer_init(&chip->width, &chip->height);

  chip->touch_x_attr = attr_init("touchX", 20);
  chip->touch_y_attr = attr_init("touchY", 100);
  chip->touch_pressed_attr = attr_init("touchPressed", 0);

  reset_parser(chip);
  printf("SIM_DISPLAY: visible framebuffer ready %ux%u\n", chip->width,
         chip->height);
}
