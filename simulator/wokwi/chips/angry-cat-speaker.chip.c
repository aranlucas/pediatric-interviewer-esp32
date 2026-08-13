#include "wokwi-api.h"

#include <stdio.h>
#include <stdlib.h>

#define DISPLAY_WIDTH 160
#define DISPLAY_HEIGHT 64
#define PACKET_HEADER_SIZE 6
#define PCM_RING_SIZE 8192
#define SPI_BUFFER_SIZE 4096

typedef enum {
  PARSER_MAGIC,
  PARSER_COUNT_LOW,
  PARSER_COUNT_HIGH,
  PARSER_SAMPLES,
} parser_state_t;

typedef struct {
  pin_t cs_pin;
  pin_t audio_out;
  spi_dev_t spi;
  uint8_t spi_buffer[SPI_BUFFER_SIZE];
  buffer_t framebuffer;
  uint32_t display_width;
  uint32_t display_height;
  uint32_t pixels[DISPLAY_WIDTH * DISPLAY_HEIGHT];
  uint32_t volume_attr;
  timer_t sample_timer;

  parser_state_t parser_state;
  uint8_t magic_index;
  uint16_t packet_samples;
  uint16_t packet_sample_index;
  uint8_t sample_low;
  bool has_sample_low;
  bool first_audio_received;

  int16_t pcm_ring[PCM_RING_SIZE];
  uint16_t read_index;
  uint16_t write_index;
  uint16_t meter_samples;
  uint16_t peak;
} chip_state_t;

static const uint8_t packet_magic[] = {'A', 'C', 'S', '1'};

static void fill_rect(chip_state_t *chip, uint32_t x, uint32_t y,
                      uint32_t width, uint32_t height, uint32_t color) {
  for (uint32_t row = y; row < y + height && row < DISPLAY_HEIGHT; ++row) {
    for (uint32_t column = x; column < x + width && column < DISPLAY_WIDTH;
         ++column) {
      chip->pixels[row * DISPLAY_WIDTH + column] = color;
    }
  }
}

static void render_meter(chip_state_t *chip, uint16_t peak) {
  const uint32_t background = 0xff17122b;
  const uint32_t panel = 0xff2a2150;
  const uint32_t active = 0xff55d68c;
  const uint32_t idle = 0xff54466f;
  fill_rect(chip, 0, 0, DISPLAY_WIDTH, DISPLAY_HEIGHT, background);
  fill_rect(chip, 12, 12, 136, 40, panel);

  const uint32_t active_bars = (uint32_t)peak * 12 / 32768;
  for (uint32_t bar = 0; bar < 12; ++bar) {
    const uint32_t height = 6 + bar * 2;
    fill_rect(chip, 18 + bar * 10, 46 - height, 6, height,
              bar < active_bars ? active : idle);
  }
  buffer_write(chip->framebuffer, 0, (uint8_t *)chip->pixels,
               sizeof(chip->pixels));
}

static void reset_parser(chip_state_t *chip) {
  chip->parser_state = PARSER_MAGIC;
  chip->magic_index = 0;
  chip->packet_samples = 0;
  chip->packet_sample_index = 0;
  chip->has_sample_low = false;
}

static void queue_sample(chip_state_t *chip, int16_t sample) {
  uint16_t next = (chip->write_index + 1) % PCM_RING_SIZE;
  if (next == chip->read_index)
    chip->read_index = (chip->read_index + 1) % PCM_RING_SIZE;
  chip->pcm_ring[chip->write_index] = sample;
  chip->write_index = next;
}

static void process_byte(chip_state_t *chip, uint8_t value) {
  if (chip->parser_state == PARSER_MAGIC) {
    if (value == packet_magic[chip->magic_index]) {
      chip->magic_index++;
      if (chip->magic_index == sizeof(packet_magic))
        chip->parser_state = PARSER_COUNT_LOW;
    } else {
      chip->magic_index = value == packet_magic[0] ? 1 : 0;
    }
    return;
  }

  if (chip->parser_state == PARSER_COUNT_LOW) {
    chip->packet_samples = value;
    chip->parser_state = PARSER_COUNT_HIGH;
    return;
  }
  if (chip->parser_state == PARSER_COUNT_HIGH) {
    chip->packet_samples |= (uint16_t)value << 8;
    if (chip->packet_samples == 0) {
      reset_parser(chip);
    } else {
      chip->parser_state = PARSER_SAMPLES;
    }
    return;
  }

  if (!chip->has_sample_low) {
    chip->sample_low = value;
    chip->has_sample_low = true;
    return;
  }

  const int16_t sample =
      (int16_t)((uint16_t)chip->sample_low | ((uint16_t)value << 8));
  chip->has_sample_low = false;
  queue_sample(chip, sample);
  chip->packet_sample_index++;
  if (chip->packet_sample_index == chip->packet_samples) {
    if (!chip->first_audio_received) {
      chip->first_audio_received = true;
      printf("SIM_SPEAKER: first PCM packet received\n");
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

static void cs_changed(void *user_data, pin_t pin, uint32_t value) {
  chip_state_t *chip = (chip_state_t *)user_data;
  (void)pin;
  if (value == LOW)
    spi_start(chip->spi, chip->spi_buffer, sizeof(chip->spi_buffer));
  else
    spi_stop(chip->spi);
}

static void output_sample(void *user_data) {
  chip_state_t *chip = (chip_state_t *)user_data;
  int16_t sample = 0;
  if (chip->read_index != chip->write_index) {
    sample = chip->pcm_ring[chip->read_index];
    chip->read_index = (chip->read_index + 1) % PCM_RING_SIZE;
  }

  const uint32_t volume = attr_read(chip->volume_attr);
  const float voltage =
      2.5f + (float)sample * 2.0f * (float)volume / (32768.0f * 100.0f);
  pin_dac_write(chip->audio_out, voltage);

  const uint16_t magnitude =
      sample == INT16_MIN ? 32768 : (sample < 0 ? -sample : sample);
  if (magnitude > chip->peak)
    chip->peak = magnitude;
  chip->meter_samples++;
  if (chip->meter_samples >= 1200) {
    render_meter(chip, chip->peak);
    chip->meter_samples = 0;
    chip->peak = 0;
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
      .miso = NO_PIN,
      .mode = 0,
      .done = spi_done,
  };
  chip->spi = spi_init(&spi_config);
  chip->audio_out = pin_init("AUDIO_OUT", ANALOG);
  chip->volume_attr = attr_init("volume", 75);
  chip->framebuffer =
      framebuffer_init(&chip->display_width, &chip->display_height);
  render_meter(chip, 0);
  reset_parser(chip);

  const timer_config_t sample_timer_config = {
      .user_data = chip,
      .callback = output_sample,
  };
  chip->sample_timer = timer_init(&sample_timer_config);
  timer_start_ns(chip->sample_timer, 41667, true);
  printf("SIM_SPEAKER: visible 24 kHz PCM DAC ready\n");
}
