#!/usr/bin/env python3
"""Convert Angry Cat's standard Codex animations into ESP32 C++ assets."""

from __future__ import annotations

import argparse
from dataclasses import dataclass
from pathlib import Path

from PIL import Image, ImageDraw


CELL_WIDTH = 192
CELL_HEIGHT = 208
ATLAS_COLUMNS = 8
ATLAS_ROWS = 11
TRANSPARENT_INDEX = 0


@dataclass(frozen=True)
class Animation:
    cpp_name: str
    label: str
    row: int
    frame_count: int
    durations_ms: tuple[int, ...]
    loops: bool


ANIMATIONS = (
    Animation("Idle", "idle", 0, 7, (280, 110, 110, 140, 140, 320, 500), True),
    Animation("Waving", "waving", 3, 4, (140, 140, 140, 280), False),
    Animation("Jumping", "jumping", 4, 5, (140, 140, 140, 140, 280), False),
    Animation("Failed", "failed", 5, 8, (140, 140, 140, 140, 140, 140, 140, 240), False),
    Animation("Waiting", "waiting", 6, 6, (150, 150, 150, 150, 150, 260), False),
    Animation("Thinking", "thinking", 7, 6, (120, 120, 120, 120, 120, 220), True),
    Animation("Review", "review", 8, 6, (150, 150, 150, 150, 150, 280), False),
)


def rgb565(red: int, green: int, blue: int) -> int:
    return ((red & 0xF8) << 8) | ((green & 0xFC) << 3) | (blue >> 3)


def expand_rgb565(color: int) -> tuple[int, int, int]:
    red = (color >> 11) & 0x1F
    green = (color >> 5) & 0x3F
    blue = color & 0x1F
    return (
        (red << 3) | (red >> 2),
        (green << 2) | (green >> 4),
        (blue << 3) | (blue >> 2),
    )


def format_values(values: list[int], formatter, per_line: int) -> str:
    lines = []
    for offset in range(0, len(values), per_line):
        chunk = values[offset : offset + per_line]
        lines.append("  " + ", ".join(formatter(value) for value in chunk))
    return ",\n".join(lines)


def composite_frame(
    frame: Image.Image, width: int, height: int, background: tuple[int, int, int]
) -> tuple[Image.Image, Image.Image]:
    resized = frame.resize((width, height), Image.Resampling.LANCZOS)
    alpha = resized.getchannel("A")
    solid_background = Image.new("RGBA", resized.size, (*background, 255))
    composited = Image.alpha_composite(solid_background, resized).convert("RGB")
    return composited, alpha


def extract_frames(atlas: Image.Image) -> list[tuple[Animation, list[Image.Image]]]:
    extracted: list[tuple[Animation, list[Image.Image]]] = []
    for animation in ANIMATIONS:
        frames = []
        for column in range(animation.frame_count):
            frame = atlas.crop(
                (
                    column * CELL_WIDTH,
                    animation.row * CELL_HEIGHT,
                    (column + 1) * CELL_WIDTH,
                    (animation.row + 1) * CELL_HEIGHT,
                )
            )
            if frame.getchannel("A").getbbox() is None:
                raise SystemExit(
                    f"{animation.label} frame {column} is unexpectedly empty"
                )
            frames.append(frame)
        extracted.append((animation, frames))
    return extracted


def write_previews(
    preview_dir: Path,
    rgba_frames: dict[str, list[Image.Image]],
    background: tuple[int, int, int],
) -> None:
    preview_dir.mkdir(parents=True, exist_ok=True)
    width, height = next(iter(rgba_frames.values()))[0].size
    contact = Image.new(
        "RGB",
        (width * max(len(frames) for frames in rgba_frames.values()),
         (height + 24) * len(ANIMATIONS)),
        background,
    )
    draw = ImageDraw.Draw(contact)

    y = 0
    for animation in ANIMATIONS:
        frames = rgba_frames[animation.label]
        frames[0].save(
            preview_dir / f"{animation.label}.gif",
            save_all=True,
            append_images=frames[1:],
            duration=list(animation.durations_ms),
            loop=0,
            disposal=2,
        )
        draw.text((4, y + 5), animation.label, fill=(255, 255, 255))
        for index, frame in enumerate(frames):
            flattened = Image.new("RGBA", frame.size, (*background, 255))
            flattened.alpha_composite(frame)
            contact.paste(flattened.convert("RGB"), (index * width, y + 24))
        y += height + 24
    contact.save(preview_dir / "contact-sheet.png")


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--atlas", required=True, type=Path)
    parser.add_argument("--output-dir", required=True, type=Path)
    parser.add_argument("--preview-dir", type=Path)
    parser.add_argument("--width", type=int, default=144)
    parser.add_argument("--height", type=int, default=156)
    parser.add_argument("--card-rgb", default="43,54,94")
    args = parser.parse_args()

    card_rgb = tuple(int(component) for component in args.card_rgb.split(","))
    if len(card_rgb) != 3 or any(component < 0 or component > 255 for component in card_rgb):
        raise SystemExit("--card-rgb must contain three values from 0 to 255")
    card_rgb = expand_rgb565(rgb565(*card_rgb))

    atlas = Image.open(args.atlas).convert("RGBA")
    expected_size = (CELL_WIDTH * ATLAS_COLUMNS, CELL_HEIGHT * ATLAS_ROWS)
    if atlas.size != expected_size:
        raise SystemExit(f"expected a Codex v2 atlas at {expected_size}, got {atlas.size}")

    extracted = extract_frames(atlas)
    composited_frames: list[Image.Image] = []
    alpha_frames: list[Image.Image] = []
    rgba_previews: dict[str, list[Image.Image]] = {}
    for animation, source_frames in extracted:
        rgba_previews[animation.label] = []
        for frame in source_frames:
            composited, alpha = composite_frame(
                frame, args.width, args.height, card_rgb
            )
            composited_frames.append(composited)
            alpha_frames.append(alpha)
            preview = composited.convert("RGBA")
            preview.putalpha(alpha)
            rgba_previews[animation.label].append(preview)

    combined = Image.new("RGB", (args.width, args.height * len(composited_frames)))
    for index, frame in enumerate(composited_frames):
        combined.paste(frame, (0, index * args.height))
    quantized = combined.quantize(colors=255, method=Image.Quantize.MEDIANCUT)
    palette_bytes = quantized.getpalette()[: 255 * 3]
    palette = [
        rgb565(*palette_bytes[index : index + 3])
        for index in range(0, len(palette_bytes), 3)
    ]
    palette = [rgb565(*card_rgb), *palette]
    palette.extend([palette[0]] * (256 - len(palette)))

    frames: list[list[int]] = []
    for index, alpha in enumerate(alpha_frames):
        row = quantized.crop(
            (0, index * args.height, args.width, (index + 1) * args.height)
        )
        indices = list(row.tobytes())
        alpha_values = list(alpha.tobytes())
        frames.append(
            [
                pixel + 1 if alpha_value > 0 else TRANSPARENT_INDEX
                for pixel, alpha_value in zip(indices, alpha_values)
            ]
        )

    output_dir = args.output_dir
    header = output_dir / "angry_cat_frames.h"
    source = output_dir / "angry_cat_frames.cpp"
    output_dir.mkdir(parents=True, exist_ok=True)

    animation_names = ",\n".join(
        f"  {animation.cpp_name}" for animation in ANIMATIONS
    )
    header.write_text(
        """#pragma once

#include <Arduino.h>

enum class AngryCatAnimation : uint8_t {
%s,
  Count,
};

struct AngryCatAnimationClip {
  uint8_t firstFrame;
  uint8_t frameCount;
  bool loops;
};

constexpr uint16_t kAngryCatFrameWidth = %d;
constexpr uint16_t kAngryCatFrameHeight = %d;
constexpr uint8_t kAngryCatFrameCount = %d;
constexpr uint8_t kAngryCatAnimationCount =
    static_cast<uint8_t>(AngryCatAnimation::Count);
constexpr uint32_t kAngryCatFramePixelCount =
    static_cast<uint32_t>(kAngryCatFrameWidth) * kAngryCatFrameHeight;
constexpr uint8_t kAngryCatTransparentIndex = 0;

extern const AngryCatAnimationClip
    kAngryCatAnimationClips[kAngryCatAnimationCount];
extern const uint16_t kAngryCatFrameDurationsMs[kAngryCatFrameCount];
extern const uint16_t kAngryCatPalette[256];
extern const uint8_t
    kAngryCatFrames[kAngryCatFrameCount][kAngryCatFramePixelCount];
"""
        % (animation_names, args.width, args.height, len(frames))
    )

    clips = []
    durations: list[int] = []
    first_frame = 0
    for animation in ANIMATIONS:
        clips.append(
            "  {%d, %d, %s}"
            % (first_frame, animation.frame_count, "true" if animation.loops else "false")
        )
        durations.extend(animation.durations_ms)
        first_frame += animation.frame_count

    frame_blocks = [
        "{\n" + format_values(frame, str, 24) + "\n}" for frame in frames
    ]
    source.write_text(
        '#include "angry_cat_frames.h"\n\n'
        + "// Generated from approved standard rows in the installed Codex Angry Cat atlas.\n"
        + "const AngryCatAnimationClip "
        + "kAngryCatAnimationClips[kAngryCatAnimationCount] PROGMEM = {\n"
        + ",\n".join(clips)
        + "\n};\n\n"
        + "const uint16_t kAngryCatFrameDurationsMs[kAngryCatFrameCount] PROGMEM = {\n"
        + format_values(durations, str, 16)
        + "\n};\n\n"
        + "const uint16_t kAngryCatPalette[256] PROGMEM = {\n"
        + format_values(palette, lambda value: f"0x{value:04X}", 12)
        + "\n};\n\n"
        + "const uint8_t kAngryCatFrames[kAngryCatFrameCount]"
        + "[kAngryCatFramePixelCount] PROGMEM = {\n"
        + ",\n".join(frame_blocks)
        + "\n};\n"
    )

    if args.preview_dir:
        write_previews(args.preview_dir, rgba_previews, card_rgb)

    payload_bytes = sum(len(frame) for frame in frames)
    print(
        f"generated {len(ANIMATIONS)} animations / {len(frames)} frames at "
        f"{args.width}x{args.height}; indexed payload={payload_bytes} bytes"
    )


if __name__ == "__main__":
    main()
