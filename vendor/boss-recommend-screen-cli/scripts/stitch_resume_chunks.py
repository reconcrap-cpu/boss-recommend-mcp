#!/usr/bin/env python
"""
Stitch vertically captured resume chunks into one full-length image.

Usage:
  python stitch_resume_chunks.py <metadata.json> <output.png>
"""

from __future__ import annotations

import json
import math
import os
import sys
from typing import Any, Dict, List, Tuple

from PIL import Image


def _clamp(value: int, low: int, high: int) -> int:
    return max(low, min(high, value))


def _load_chunks(metadata_path: str) -> List[Dict[str, Any]]:
    with open(metadata_path, "r", encoding="utf-8") as f:
        meta = json.load(f)

    chunks = meta.get("chunks", [])
    if not isinstance(chunks, list) or not chunks:
        raise ValueError("No chunks found in metadata.")

    cleaned = []
    for idx, chunk in enumerate(chunks):
        file_path = chunk.get("file")
        if not file_path or not os.path.exists(file_path):
            raise FileNotFoundError(f"Chunk image missing: {file_path}")
        cleaned.append(
            {
                "index": int(chunk.get("index", idx)),
                "file": file_path,
                "scroll_top": float(chunk.get("scrollTop", 0.0)),
                "clip_h_css": float(chunk.get("clipHeightCss", 0.0)),
            }
        )

    cleaned.sort(key=lambda x: (x["scroll_top"], x["index"]))
    return cleaned


def stitch(metadata_path: str, output_path: str) -> Dict[str, Any]:
    chunks = _load_chunks(metadata_path)

    opened: List[Tuple[Dict[str, Any], Image.Image]] = []
    for chunk in chunks:
        img = Image.open(chunk["file"]).convert("RGB")
        opened.append((chunk, img))

    try:
        segments: List[Image.Image] = []
        used: List[Dict[str, Any]] = []
        prev_chunk = None

        for chunk, img in opened:
            if prev_chunk is None:
                segments.append(img.copy())
                used.append(
                    {
                        "file": chunk["file"],
                        "scrollTop": chunk["scroll_top"],
                        "cropTopPx": 0,
                        "keptHeightPx": img.height,
                    }
                )
                prev_chunk = chunk
                continue

            delta_css = chunk["scroll_top"] - prev_chunk["scroll_top"]
            if delta_css <= 0.5:
                prev_chunk = chunk
                continue

            clip_h_css = chunk["clip_h_css"] if chunk["clip_h_css"] > 1 else prev_chunk["clip_h_css"]
            ratio = (img.height / clip_h_css) if clip_h_css > 1 else 1.0
            new_pixels = int(round(delta_css * ratio))
            new_pixels = _clamp(new_pixels, 1, img.height)
            crop_top = img.height - new_pixels
            crop_top = _clamp(crop_top, 0, img.height - 1)

            seg = img.crop((0, crop_top, img.width, img.height))
            segments.append(seg)
            used.append(
                {
                    "file": chunk["file"],
                    "scrollTop": chunk["scroll_top"],
                    "cropTopPx": crop_top,
                    "keptHeightPx": seg.height,
                }
            )
            prev_chunk = chunk

        out_width = max(seg.width for seg in segments)
        out_height = sum(seg.height for seg in segments)
        out = Image.new("RGB", (out_width, out_height), color=(255, 255, 255))

        y = 0
        for seg in segments:
            out.paste(seg, (0, y))
            y += seg.height

        out.save(output_path, format="PNG")

        return {
            "output": os.path.abspath(output_path),
            "segments": len(segments),
            "size": {"width": out_width, "height": out_height},
            "used": used,
        }
    finally:
        for _, img in opened:
            img.close()


def main() -> None:
    if len(sys.argv) != 3:
        print("Usage: python stitch_resume_chunks.py <metadata.json> <output.png>", file=sys.stderr)
        sys.exit(1)

    metadata_path = os.path.abspath(sys.argv[1])
    output_path = os.path.abspath(sys.argv[2])

    try:
        result = stitch(metadata_path, output_path)
        print(json.dumps(result, ensure_ascii=False, indent=2))
    except Exception as exc:
        print(f"[stitch] failed: {exc}", file=sys.stderr)
        sys.exit(1)


if __name__ == "__main__":
    main()

