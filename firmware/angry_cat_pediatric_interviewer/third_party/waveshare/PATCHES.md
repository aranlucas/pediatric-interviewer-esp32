# Local patches

## `esp_lcd_touch_axs15231b`

- Keep driver globals translation-unit local.
- Treat short I2C reads as failures.
- Clear the retained touch count before every read so released touches do not
  reuse stale coordinates.
- Stop parsing after a failed transaction.
- Copy the reported touch count into the caller's result.
