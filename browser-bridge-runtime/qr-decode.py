#!/usr/bin/env python3
"""Local QR decoder for Patrol TOTP migration images.

Input: JSON on stdin: {"image":"data:image/...;base64,..."}
Output: compact JSON on stdout. QR payloads may contain TOTP seeds, so callers
must treat `values` as sensitive and never log or return them to the model/UI.
"""

from __future__ import annotations

import base64
import json
import re
import sys
from typing import Any

import cv2
import numpy as np


def decode_image(value: str) -> np.ndarray:
    if not isinstance(value, str):
        raise ValueError("image must be a data URL string")
    match = re.match(r"^data:image/[^;,]+;base64,([A-Za-z0-9+/=]+)$", value)
    if not match:
        raise ValueError("image must be a base64 image data URL")
    raw = base64.b64decode(match.group(1), validate=True)
    if len(raw) > 8 * 1024 * 1024:
        raise ValueError("QR image exceeds the 8 MiB limit")
    image = cv2.imdecode(np.frombuffer(raw, dtype=np.uint8), cv2.IMREAD_COLOR)
    if image is None:
        raise ValueError("QR image could not be decoded")
    height, width = image.shape[:2]
    if height <= 0 or width <= 0 or height * width > 24_000_000:
        raise ValueError("QR image dimensions are unsupported")
    return image


def decode_variant(detector: cv2.QRCodeDetector, image: np.ndarray) -> list[str]:
    values: list[str] = []
    try:
        ok, decoded, _points, _straight = detector.detectAndDecodeMulti(image)
        if ok and decoded:
            values.extend(str(item) for item in decoded if str(item))
    except Exception:
        pass
    if values:
        return values
    try:
        value, _points, _straight = detector.detectAndDecode(image)
        if value:
            values.append(str(value))
    except Exception:
        pass
    return values


def solve(payload: dict[str, Any]) -> dict[str, Any]:
    image = decode_image(payload.get("image", ""))
    detector = cv2.QRCodeDetector()
    variants: list[np.ndarray] = [image]

    gray = cv2.cvtColor(image, cv2.COLOR_BGR2GRAY)
    variants.append(gray)

    height, width = image.shape[:2]
    longest = max(height, width)
    if longest < 1800:
        scale = min(3.0, 1800.0 / max(1, longest))
        variants.append(cv2.resize(image, None, fx=scale, fy=scale, interpolation=cv2.INTER_CUBIC))

    try:
        binary = cv2.adaptiveThreshold(
            gray, 255, cv2.ADAPTIVE_THRESH_GAUSSIAN_C,
            cv2.THRESH_BINARY, 41, 7
        )
        variants.append(binary)
    except Exception:
        pass

    values: list[str] = []
    seen: set[str] = set()
    for variant in variants:
        for value in decode_variant(detector, variant):
            if value not in seen:
                seen.add(value)
                values.append(value)
        if values:
            break

    if not values:
        raise ValueError("no QR code could be decoded from the image")
    return {"ok": True, "count": len(values), "values": values}


def main() -> int:
    try:
        payload = json.load(sys.stdin)
        result = solve(payload if isinstance(payload, dict) else {})
        sys.stdout.write(json.dumps(result, ensure_ascii=False, separators=(",", ":")))
        return 0
    except Exception as error:
        sys.stdout.write(json.dumps(
            {"ok": False, "error": str(error)},
            ensure_ascii=False,
            separators=(",", ":"),
        ))
        return 2


if __name__ == "__main__":
    raise SystemExit(main())
