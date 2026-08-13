PORT ?= /dev/cu.usbmodem3101
PROFILE := waveshare-3.5b
SIMULATOR_FQBN := esp32:esp32:esp32s3:UploadSpeed=921600,USBMode=hwcdc,CDCOnBoot=default,UploadMode=default,CPUFreq=240,FlashMode=qio,FlashSize=16M,PartitionScheme=app3M_fat9M_16MB,DebugLevel=none,PSRAM=opi,LoopCore=1,EventsCore=1,EraseFlash=none,JTAGAdapter=default
ARDUINO_CLI ?= arduino-cli
BUILD_PATH ?= build/arduino
SIMULATOR_BUILD_PATH ?= build/wokwi-standard
SIMULATOR_INTEGRATION_BUILD_PATH ?= build/wokwi-integration
SIMULATOR_ACTIVE_PATH := build/wokwi-active
SKETCH_DIR := firmware/angry_cat_pediatric_interviewer
AUDIO_DRIVER_DIR := $(SKETCH_DIR)/third_party/arduino-audio-driver
AUDIO_DRIVER_INCLUDE := $(abspath $(AUDIO_DRIVER_DIR)/src)
CLANG_FORMAT ?= $(shell command -v clang-format 2>/dev/null || xcrun --find clang-format 2>/dev/null)
CLANG_TIDY ?=
PYTHON ?= python3
WOKWI_CLI ?= wokwi-cli
WOKWI_DIR := simulator/wokwi
SIMULATOR_STAGE_ROOT := build/wokwi-standard-sketch
SIMULATOR_SKETCH_DIR := $(SIMULATOR_STAGE_ROOT)/angry_cat_pediatric_interviewer
SIMULATOR_INTEGRATION_STAGE_ROOT := build/wokwi-integration-sketch
SIMULATOR_INTEGRATION_SKETCH_DIR := $(SIMULATOR_INTEGRATION_STAGE_ROOT)/angry_cat_pediatric_interviewer
SIMULATOR_FIXTURES := $(WOKWI_DIR)/fixtures
PET_ATLAS ?= $(HOME)/.codex/pets/angry-cat/spritesheet.webp
FORMAT_SOURCES := $(shell find $(SKETCH_DIR) -type f \( -name '*.ino' -o -name '*.cpp' -o -name '*.h' \) -not -name 'interviewer_config.h' -not -path '*/generated/*' -not -path '*/third_party/*' | sort)

.PHONY: setup pet-assets format format-check tidy lint compile stage-simulator stage-simulator-integration compile-simulator compile-simulator-integration simulator-config-check simulate simulate-integration simulate-turn-complete simulate-integration-interactive wokwi-mcp upload monitor all

all: compile

setup:
	git submodule update --init --recursive
	$(ARDUINO_CLI) core update-index
	$(ARDUINO_CLI) core install esp32:esp32@3.3.11
	$(ARDUINO_CLI) lib install "GFX Library for Arduino@1.6.7" "TCA9554@0.1.3" "ArduinoJson@7.4.3" "WiFiManager@2.0.17" "ArduinoWebsockets@0.5.4"

pet-assets:
	$(PYTHON) tools/generate_codex_pet.py --atlas "$(PET_ATLAS)" --output-dir $(SKETCH_DIR)/src/generated

format:
	@test -n "$(CLANG_FORMAT)" || { echo "clang-format was not found" >&2; exit 1; }
	$(CLANG_FORMAT) --style=LLVM -i $(FORMAT_SOURCES)

format-check:
	@test -n "$(CLANG_FORMAT)" || { echo "clang-format was not found" >&2; exit 1; }
	$(CLANG_FORMAT) --style=LLVM --dry-run --Werror $(FORMAT_SOURCES)

tidy:
	PROFILE=$(PROFILE) ARDUINO_CLI=$(ARDUINO_CLI) CLANG_TIDY="$(CLANG_TIDY)" AUDIO_DRIVER_INCLUDE="$(AUDIO_DRIVER_INCLUDE)" tools/run_clang_tidy.sh

lint: format-check tidy

compile:
	$(ARDUINO_CLI) compile --profile $(PROFILE) --build-path $(BUILD_PATH) --build-property "compiler.cpp.extra_flags=-I$(AUDIO_DRIVER_INCLUDE)" --clean --export-binaries $(SKETCH_DIR)

stage-simulator:
	@test "$(SIMULATOR_STAGE_ROOT)" = "build/wokwi-standard-sketch"
	rm -rf $(SIMULATOR_STAGE_ROOT)
	mkdir -p $(SIMULATOR_SKETCH_DIR)
	cp -R $(SKETCH_DIR)/. $(SIMULATOR_SKETCH_DIR)/
	cp $(SIMULATOR_FIXTURES)/AngryCatSimulator.h $(SIMULATOR_FIXTURES)/AngryCatSimulator.cpp $(SIMULATOR_SKETCH_DIR)/

compile-simulator: stage-simulator
	$(ARDUINO_CLI) compile --fqbn $(SIMULATOR_FQBN) --build-path $(SIMULATOR_BUILD_PATH) --build-property "compiler.cpp.extra_flags=-I$(AUDIO_DRIVER_INCLUDE) -DANGRY_CAT_SIMULATOR=1" --clean --export-binaries $(SIMULATOR_SKETCH_DIR)
	ln -sfn "$(notdir $(SIMULATOR_BUILD_PATH))" "$(SIMULATOR_ACTIVE_PATH).next"
	mv -f "$(SIMULATOR_ACTIVE_PATH).next" "$(SIMULATOR_ACTIVE_PATH)"

stage-simulator-integration:
	@test "$(SIMULATOR_INTEGRATION_STAGE_ROOT)" = "build/wokwi-integration-sketch"
	rm -rf $(SIMULATOR_INTEGRATION_STAGE_ROOT)
	mkdir -p $(SIMULATOR_INTEGRATION_SKETCH_DIR)
	cp -R $(SKETCH_DIR)/. $(SIMULATOR_INTEGRATION_SKETCH_DIR)/
	cp $(SIMULATOR_FIXTURES)/AngryCatSimulator.h $(SIMULATOR_FIXTURES)/AngryCatSimulator.cpp $(SIMULATOR_INTEGRATION_SKETCH_DIR)/

compile-simulator-integration: stage-simulator-integration
	$(ARDUINO_CLI) compile --fqbn $(SIMULATOR_FQBN) --build-path $(SIMULATOR_INTEGRATION_BUILD_PATH) --build-property "compiler.cpp.extra_flags=-I$(AUDIO_DRIVER_INCLUDE) -DANGRY_CAT_SIMULATOR=1 -DANGRY_CAT_SIMULATOR_LIVE=1" --clean --export-binaries $(SIMULATOR_INTEGRATION_SKETCH_DIR)
	ln -sfn "$(notdir $(SIMULATOR_INTEGRATION_BUILD_PATH))" "$(SIMULATOR_ACTIVE_PATH).next"
	mv -f "$(SIMULATOR_ACTIVE_PATH).next" "$(SIMULATOR_ACTIVE_PATH)"

simulator-config-check:
	jq empty $(WOKWI_DIR)/diagram.json
	ruby -e 'require "yaml"; YAML.load_file("$(WOKWI_DIR)/angry-cat.test.yaml")'
	ruby -e 'require "yaml"; YAML.load_file("$(WOKWI_DIR)/angry-cat-integration.test.yaml")'
	ruby -e 'require "yaml"; YAML.load_file("$(WOKWI_DIR)/angry-cat-turn-complete.test.yaml")'

simulate: compile-simulator simulator-config-check
	@command -v $(WOKWI_CLI) >/dev/null || { echo "wokwi-cli was not found" >&2; exit 1; }
	@test -n "$${WOKWI_CLI_TOKEN:-}" || { echo "WOKWI_CLI_TOKEN is not configured" >&2; exit 1; }
	$(WOKWI_CLI) $(WOKWI_DIR) --scenario angry-cat.test.yaml --timeout 20000 --timeout-exit-code 1 --fail-text "SIM_TEST: FAIL"

simulate-integration: compile-simulator-integration simulator-config-check
	@command -v $(WOKWI_CLI) >/dev/null || { echo "wokwi-cli was not found" >&2; exit 1; }
	@test -n "$${WOKWI_CLI_TOKEN:-}" || { echo "WOKWI_CLI_TOKEN is not configured" >&2; exit 1; }
	$(WOKWI_CLI) $(WOKWI_DIR) --scenario angry-cat-integration.test.yaml --timeout 720000 --timeout-exit-code 1 --fail-text "SIM_INTEGRATION: FAIL"

simulate-turn-complete: compile-simulator-integration simulator-config-check
	@command -v $(WOKWI_CLI) >/dev/null || { echo "wokwi-cli was not found" >&2; exit 1; }
	@test -n "$${WOKWI_CLI_TOKEN:-}" || { echo "WOKWI_CLI_TOKEN is not configured" >&2; exit 1; }
	$(WOKWI_CLI) $(WOKWI_DIR) --scenario angry-cat-turn-complete.test.yaml --timeout 180000 --timeout-exit-code 1 --fail-text "SIM_INTEGRATION: FAIL"

simulate-integration-interactive: compile-simulator-integration simulator-config-check
	@command -v $(WOKWI_CLI) >/dev/null || { echo "wokwi-cli was not found" >&2; exit 1; }
	@test -n "$${WOKWI_CLI_TOKEN:-}" || { echo "WOKWI_CLI_TOKEN is not configured" >&2; exit 1; }
	$(WOKWI_CLI) $(WOKWI_DIR) --interactive --timeout 1800000 --timeout-exit-code 1 --fail-text "SIM_INTEGRATION: FAIL"

wokwi-mcp:
	@command -v $(WOKWI_CLI) >/dev/null || { echo "wokwi-cli was not found" >&2; exit 1; }
	@test -n "$${WOKWI_CLI_TOKEN:-}" || { echo "WOKWI_CLI_TOKEN is not configured" >&2; exit 1; }
	$(WOKWI_CLI) mcp $(WOKWI_DIR)

upload: compile
	$(ARDUINO_CLI) upload --profile $(PROFILE) --build-path $(BUILD_PATH) --port $(PORT) $(SKETCH_DIR)

monitor:
	$(ARDUINO_CLI) monitor --port $(PORT) --config baudrate=115200
