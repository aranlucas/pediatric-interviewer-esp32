#!/usr/bin/env bash

set -euo pipefail

project_dir=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
sketch_dir="$project_dir/firmware/angry_cat_pediatric_interviewer"
build_dir="$project_dir/build/clang-tidy"
profile=${PROFILE:-waveshare-3.5b}
arduino_cli=${ARDUINO_CLI:-arduino-cli}
audio_driver_include=${AUDIO_DRIVER_INCLUDE:-$sketch_dir/third_party/arduino-audio-driver/src}
audio_tools_include=${AUDIO_TOOLS_INCLUDE:-$sketch_dir/third_party/arduino-audio-tools/src}
waveshare_touch_include=${WAVESHARE_TOUCH_INCLUDE:-$sketch_dir/third_party/waveshare/Arduino/libraries/esp_lcd_touch_axs15231b}

if [[ -n ${CLANG_TIDY:-} ]]; then
  clang_tidy=$CLANG_TIDY
elif command -v clang-tidy >/dev/null 2>&1; then
  clang_tidy=$(command -v clang-tidy)
else
  clang_tidy=$(find "$HOME/Library/Android/sdk/ndk" -type f -path '*/bin/clang-tidy' 2>/dev/null | sort | tail -n 1)
fi

if [[ -z ${clang_tidy:-} || ! -x $clang_tidy ]]; then
  echo "clang-tidy was not found; set CLANG_TIDY=/path/to/clang-tidy" >&2
  exit 1
fi

clang_cxx=$(dirname "$clang_tidy")/clang++
if [[ ! -x $clang_cxx ]]; then
  echo "clang++ was not found next to $clang_tidy" >&2
  exit 1
fi

for command in "$arduino_cli" jq; do
  if ! command -v "$command" >/dev/null 2>&1; then
    echo "$command was not found" >&2
    exit 1
  fi
done

"$arduino_cli" compile --profile "$profile" --only-compilation-database --clean \
  --build-path "$build_dir" \
  --build-property "compiler.cpp.extra_flags=-I$audio_driver_include -I$audio_tools_include -I$waveshare_touch_include" \
  "$sketch_dir" >/dev/null

compile_database="$build_dir/compile_commands.json"
if [[ ! -s $compile_database ]]; then
  echo "Arduino did not produce $compile_database" >&2
  exit 1
fi

xtensa_cxx=$(jq -r '.[0].arguments[0]' "$compile_database")
cpp_response=$(jq -r '
  [.[].arguments[] | select(startswith("@") and endswith("/flags/cpp_flags"))][0]
' "$compile_database")
cpp_flags=${cpp_response#@}

if [[ ! -x $xtensa_cxx || ! -f $cpp_flags ]]; then
  echo "The ESP32 compiler database is missing its compiler or C++ flags" >&2
  exit 1
fi

temporary_dir=$(mktemp -d "${TMPDIR:-/tmp}/angry-cat-clang-tidy.XXXXXX")
trap 'rm -rf "$temporary_dir"' EXIT

filtered_flags="$temporary_dir/cpp_flags"
sed \
  -e 's/-mlongcalls //g' \
  -e 's/-mdisable-hardware-atomics //g' \
  -e 's/-fstrict-volatile-bitfields //g' \
  -e 's/-fno-tree-switch-conversion //g' \
  "$cpp_flags" >"$filtered_flags"

include_paths=()
while IFS= read -r include_path; do
  [[ -n $include_path ]] && include_paths+=("$include_path")
done < <(
  "$xtensa_cxx" -E -x c++ - -v </dev/null 2>&1 |
    awk '
      /#include <\.\.\.> search starts here:/ { capture = 1; next }
      /End of search list\./ { capture = 0 }
      capture { sub(/^[[:space:]]+/, ""); print }
    '
)

system_arguments=$(printf '%s\n' "${include_paths[@]}" | jq -R . | jq -s 'map(["-isystem", .]) | add // []')
adapted_database="$temporary_dir/compile_commands.json"
jq \
  --arg compiler "$clang_cxx" \
  --arg response "@$filtered_flags" \
  --argjson system_arguments "$system_arguments" \
  '
    map(
      .arguments |= map(
        if startswith("@") and endswith("/flags/cpp_flags")
        then $response
        else .
        end
      )
      | .arguments[0] = $compiler
      | .arguments = (
          .arguments[0:-3] + $system_arguments + .arguments[-3:]
        )
    )
  ' "$compile_database" >"$adapted_database"

sources=()
while IFS= read -r source; do
  [[ -n $source ]] && sources+=("$source")
done < <(
  jq -r --arg prefix "$build_dir/sketch/" '
    .[].file
    | select(startswith($prefix) and endswith(".cpp"))
    | select(contains("/src/generated/") | not)
    | select(contains("/third_party/") | not)
  ' "$compile_database" | sort -u
)

if [[ ${#sources[@]} -eq 0 ]]; then
  echo "No project translation units were found in the compilation database" >&2
  exit 1
fi

# The Android clang target used for analysis aliases int32_t to int. The
# ESP32-specific upstream header also exposes an optional int overload, which
# is distinct under the Xtensa ABI but a false duplicate under this host-side
# analysis target. Keep the actual ESP32 build flags unchanged and model that
# ABI distinction only for this host-side analysis.
for source in "${sources[@]}"; do
  "$clang_tidy" -p "$temporary_dir" "$source" \
    --warnings-as-errors='*' \
    --extra-arg=-D__INT32_TYPE__=long \
    --extra-arg-before=--target=armv7-none-eabi \
    --extra-arg-before=-D__XTENSA__ \
    --extra-arg-before=-D__block=__newlib_block \
    --extra-arg-before=-include \
    --extra-arg-before="$project_dir/tools/clang_tidy_shim.h" \
    --quiet
done
