# Waveshare touch driver

This Arduino driver is vendored from Waveshare's official
`ESP32-S3-Touch-LCD-3.5B` repository at commit
`840daf2df7cb6b1f023fafc435371016e66f2ae0`.

It remains vendored because Arduino_GFX's `Arduino_AXS15231B` class drives the
QSPI LCD but not the capacitive-touch interface at `0x3B`. Arduino_GFX's
suggested TouchLib dependency does not support this AXS15231B/AXS5106L touch
protocol, and there is no direct Arduino Library Manager package for it.

The translation unit in `../../src/board` compiles the source as part of the
sketch. See `PATCHES.md` for the local reliability changes retained on top of
Waveshare's source.
