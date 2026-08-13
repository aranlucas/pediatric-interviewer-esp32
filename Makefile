PORT ?= /dev/cu.usbmodem3101
PROFILE := waveshare-3.5b
ARDUINO_CLI ?= arduino-cli
CLANG_FORMAT ?= $(shell command -v clang-format 2>/dev/null || xcrun --find clang-format 2>/dev/null)
CLANG_TIDY ?=
PYTHON ?= python3
PET_ATLAS ?= $(HOME)/.codex/pets/angry-cat/spritesheet.webp
FORMAT_SOURCES := $(shell find . -maxdepth 2 -type f \( -name '*.ino' -o -name '*.cpp' -o -name '*.h' \) -not -path './build/*' | sort)

.PHONY: setup pet-assets format format-check tidy lint compile upload monitor all

all: compile

setup:
	$(ARDUINO_CLI) core update-index
	$(ARDUINO_CLI) core install esp32:esp32@3.3.11
	$(ARDUINO_CLI) lib install "GFX Library for Arduino@1.6.7" "TCA9554@0.1.3" "ArduinoJson@7.4.3" "WiFiManager@2.0.17" "ArduinoWebsockets@0.5.4"

pet-assets:
	$(PYTHON) tools/generate_codex_pet.py --atlas "$(PET_ATLAS)" --output-dir .

format:
	@test -n "$(CLANG_FORMAT)" || { echo "clang-format was not found" >&2; exit 1; }
	$(CLANG_FORMAT) --style=LLVM -i $(FORMAT_SOURCES)

format-check:
	@test -n "$(CLANG_FORMAT)" || { echo "clang-format was not found" >&2; exit 1; }
	$(CLANG_FORMAT) --style=LLVM --dry-run --Werror $(FORMAT_SOURCES)

tidy:
	PROFILE=$(PROFILE) ARDUINO_CLI=$(ARDUINO_CLI) CLANG_TIDY="$(CLANG_TIDY)" tools/run_clang_tidy.sh

lint: format-check tidy

compile:
	$(ARDUINO_CLI) compile --profile $(PROFILE) --clean --export-binaries .

upload: compile
	$(ARDUINO_CLI) upload --profile $(PROFILE) --port $(PORT) .

monitor:
	$(ARDUINO_CLI) monitor --port $(PORT) --config baudrate=115200
