#!/usr/bin/env python3
"""Owned-site CAPTCHA demo helper for DSH Patrol.

This process is intentionally not a general browser automation service. The Node
runtime invokes it only for pages that expose explicit DSH Patrol CAPTCHA demo
markup. It performs local image analysis only and writes one compact JSON
result to stdout.
"""

from __future__ import annotations

import base64
import io
import json
import re
import sys
from typing import Any

import cv2
import ddddocr
import numpy as np
from PIL import Image


def decode_image(value: str) -> bytes:
    if not isinstance(value, str):
        raise ValueError("image must be a data URL string")
    match = re.match(r"^data:[^;,]+;base64,([A-Za-z0-9+/=]+)$", value)
    if not match:
        raise ValueError("image must be a base64 data URL")
    return base64.b64decode(match.group(1), validate=True)


def normalize_text(value: str) -> str:
    return re.sub(r"[\s,，.。:：;；|/\\\-_'\"`~!！?？()（）\[\]{}<>《》]+", "", str(value or ""))


def image_size(image_bytes: bytes) -> tuple[int, int]:
    with Image.open(io.BytesIO(image_bytes)) as image:
        return int(image.width), int(image.height)


def crop_png(image: Image.Image, box: list[int], padding: int = 3) -> bytes:
    left, top, right, bottom = [int(v) for v in box]
    left = max(0, left - padding)
    top = max(0, top - padding)
    right = min(image.width, right + padding)
    bottom = min(image.height, bottom + padding)
    if right <= left or bottom <= top:
        raise ValueError("empty candidate crop")
    output = io.BytesIO()
    image.crop((left, top, right, bottom)).save(output, format="PNG")
    return output.getvalue()


def contour_boxes(image_bytes: bytes) -> list[list[int]]:
    array = np.frombuffer(image_bytes, dtype=np.uint8)
    image = cv2.imdecode(array, cv2.IMREAD_GRAYSCALE)
    if image is None:
        return []
    blurred = cv2.GaussianBlur(image, (3, 3), 0)
    _, binary = cv2.threshold(blurred, 0, 255, cv2.THRESH_BINARY_INV + cv2.THRESH_OTSU)
    contours, _ = cv2.findContours(binary, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE)
    height, width = image.shape[:2]
    min_area = max(18, int(width * height * 0.00035))
    boxes: list[list[int]] = []
    for contour in contours:
        x, y, w, h = cv2.boundingRect(contour)
        area = w * h
        if area < min_area:
            continue
        if w < 5 or h < 8:
            continue
        if w > width * 0.8 or h > height * 0.8:
            continue
        boxes.append([x, y, x + w, y + h])
    boxes.sort(key=lambda box: (box[1], box[0]))
    return boxes[:80]


def dedupe_boxes(boxes: list[list[int]]) -> list[list[int]]:
    result: list[list[int]] = []
    for box in boxes:
        x1, y1, x2, y2 = [int(v) for v in box]
        if x2 <= x1 or y2 <= y1:
            continue
        keep = True
        for existing in result:
            ex1, ey1, ex2, ey2 = existing
            ix1, iy1 = max(x1, ex1), max(y1, ey1)
            ix2, iy2 = min(x2, ex2), min(y2, ey2)
            intersection = max(0, ix2 - ix1) * max(0, iy2 - iy1)
            smaller = min((x2 - x1) * (y2 - y1), (ex2 - ex1) * (ey2 - ey1))
            if smaller > 0 and intersection / smaller >= 0.82:
                keep = False
                break
        if keep:
            result.append([x1, y1, x2, y2])
    return result


def solve_click_sequence(payload: dict[str, Any]) -> dict[str, Any]:
    image_bytes = decode_image(payload.get("image", ""))
    target = normalize_text(payload.get("targetText", ""))
    if not target or len(target) > 12:
        raise ValueError("targetText must contain 1-12 visible characters")

    detector = ddddocr.DdddOcr(ocr=False, det=True, show_ad=False)
    recognizer = ddddocr.DdddOcr(ocr=True, det=False, show_ad=False)

    detected = detector.detection(image_bytes) or []
    boxes = dedupe_boxes([[int(v) for v in box[:4]] for box in detected if isinstance(box, (list, tuple)) and len(box) >= 4])
    if len(boxes) < len(target):
        boxes = dedupe_boxes(boxes + contour_boxes(image_bytes))

    with Image.open(io.BytesIO(image_bytes)).convert("RGB") as image:
        width, height = image.width, image.height
        candidates: list[dict[str, Any]] = []
        for box in boxes[:80]:
            try:
                text = normalize_text(recognizer.classification(crop_png(image, box)))
            except Exception:
                continue
            if not text:
                continue
            x1, y1, x2, y2 = box
            candidates.append({
                "box": box,
                "text": text,
                "x": (x1 + x2) / 2.0,
                "y": (y1 + y2) / 2.0,
            })

    points: list[dict[str, float]] = []
    used: set[int] = set()
    for char in target:
        best_index: int | None = None
        best_score = -1
        for index, candidate in enumerate(candidates):
            if index in used:
                continue
            text = candidate["text"]
            score = 0
            if text == char:
                score = 100
            elif len(text) == 1 and char in text:
                score = 90
            elif char in text:
                score = 65
            elif text and text[0] == char:
                score = 55
            if score > best_score:
                best_score = score
                best_index = index
        if best_index is None or best_score < 55:
            raise ValueError(f"could not locate requested character {char!r}")
        used.add(best_index)
        candidate = candidates[best_index]
        points.append({
            "x": max(0.0, min(1.0, float(candidate["x"]) / float(width))),
            "y": max(0.0, min(1.0, float(candidate["y"]) / float(height))),
        })

    return {"ok": True, "operation": "click-sequence", "points": points}


def solve_slider(payload: dict[str, Any]) -> dict[str, Any]:
    piece = decode_image(payload.get("pieceImage", ""))
    background = decode_image(payload.get("backgroundImage", ""))
    width, _ = image_size(background)
    if width <= 0:
        raise ValueError("background image has zero width")

    solver = ddddocr.DdddOcr(ocr=False, det=False, show_ad=False)
    last_error: Exception | None = None
    result: dict[str, Any] | None = None
    for simple_target in (True, False):
        try:
            candidate = solver.slide_match(piece, background, simple_target=simple_target)
            if isinstance(candidate, dict) and candidate.get("target"):
                result = candidate
                break
        except Exception as error:
            last_error = error
    if result is None:
        if last_error is not None:
            raise last_error
        raise ValueError("ddddocr did not return a slider target")

    target = result.get("target")
    if not isinstance(target, (list, tuple)) or len(target) < 1:
        raise ValueError("slider target geometry is invalid")
    x = float(target[0])
    normalized_x = max(0.0, min(1.0, x / float(width)))
    return {"ok": True, "operation": "slider-puzzle", "normalizedX": normalized_x}


def main() -> int:
    try:
        payload = json.load(sys.stdin)
        operation = str(payload.get("operation", ""))
        if operation == "click-sequence":
            result = solve_click_sequence(payload)
        elif operation == "slider-puzzle":
            result = solve_slider(payload)
        else:
            raise ValueError(f"unsupported operation: {operation}")
        sys.stdout.write(json.dumps(result, ensure_ascii=False, separators=(",", ":")))
        return 0
    except Exception as error:
        sys.stdout.write(json.dumps({"ok": False, "error": str(error)}, ensure_ascii=False, separators=(",", ":")))
        return 2


if __name__ == "__main__":
    raise SystemExit(main())
