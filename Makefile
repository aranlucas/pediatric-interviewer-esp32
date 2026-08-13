PORT ?= /dev/cu.usbmodem3101
PROFILE := waveshare-3.5b
PYTHON ?= python3
PET_ATLAS ?= $(HOME)/.codex/pets/angry-cat/spritesheet.webp

.PHONY: setup pet-assets compile upload monitor all

all: compile

setup:
	arduino-cli core update-index
	arduino-cli core install esp32:esp32@3.3.11
	arduino-cli lib install "GFX Library for Arduino@1.6.7" "TCA9554@0.1.3" "ArduinoJson@7.4.3" "WiFiManager@2.0.17" "ArduinoWebsockets@0.5.4"

pet-assets:
	$(PYTHON) tools/generate_codex_pet.py --atlas "$(PET_ATLAS)" --output-dir .

compile:
	arduino-cli compile --profile $(PROFILE) --clean --export-binaries .

upload: compile
	arduino-cli upload --profile $(PROFILE) --port $(PORT) .

monitor:
	arduino-cli monitor --port $(PORT) --config baudrate=115200
