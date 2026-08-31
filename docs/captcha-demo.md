# CAPTCHA demo mode

DSH Patrol keeps normal verification handling conservative. Conventional image-text codes can use the existing Windows system OCR path. Ordered-click and slider-puzzle automation has two cooperative test paths: explicit Patrol markup on any page that exposes `data-dsh-patrol-captcha-*` anchors, and zero-configuration weak DOM discovery on loopback test pages (`localhost`, `127.0.0.1`, or IPv6 loopback). Remote pages may still be weakly detected and classified, but weak unmarked detections do not trigger automatic clicks or drags.

## 1. Install the local solver

The normal Windows installer attempts this automatically. You can also run it separately:

```powershell
cd E:\fangzeming\deepseekHarness\DSH-Patrol
.\scripts\install-captcha-demo.ps1
```

This creates `.captcha-demo-venv` locally and installs `ddddocr==1.6.1`. The environment is ignored by Git.

## 2. Ordered text-click demo markup

Mark the challenge root and the image/canvas to analyze. Supply the requested click sequence as page-owned metadata or visible target text.

```html
<div data-dsh-patrol-captcha-kind="click-sequence" data-target-text="春山水">
  <canvas data-dsh-patrol-captcha-image width="360" height="240"></canvas>
</div>
```

Instead of `data-target-text`, the target can be provided by a child:

```html
<div data-dsh-patrol-captcha-kind="click-sequence">
  <div data-dsh-patrol-captcha-target>春 山 水</div>
  <img data-dsh-patrol-captcha-image src="/demo/click-captcha.png">
</div>
```

At verification time Patrol captures only that marked image, uses local ddddocr detection/OCR plus local image processing to derive ordered normalized points, dispatches clicks to the marked element, then re-runs challenge detection. Coordinates and challenge images are not written into the Runbook.

## 3. Slider-puzzle demo markup

For a slider demo, expose the rendered background, puzzle piece, and draggable handle with explicit markers:

```html
<div data-dsh-patrol-captcha-kind="slider-puzzle">
  <img data-dsh-patrol-captcha-background src="/demo/background.png">
  <img data-dsh-patrol-captcha-piece src="/demo/piece.png">
  <button data-dsh-patrol-captcha-slider-handle type="button" aria-label="drag slider"></button>
</div>
```

Patrol crops the marked background and piece from the current rendered page, runs ddddocr `slide_match` locally, converts the result to a normalized horizontal position, dispatches a pointer/mouse drag on the marked handle, and then re-detects verification state.

Your demo site's slider implementation should respond to standard pointer/mouse down, move, and up events. If it uses a custom framework event contract, adapt the demo widget to standard pointer events for the presentation.

## 4. Weak auto-detection fallback

On a loopback test page, Patrol can run without any `data-dsh-patrol-*` markup once the normal challenge classifier has already identified an exact `click-sequence` or `slider-puzzle` challenge.

- Ordered-click fallback:
  Patrol looks for click-order wording near a large visible image or canvas and uses the strongest matching image as the solve target.
- Slider-puzzle fallback:
  Patrol looks for slider/puzzle wording near a likely background image, puzzle piece, and draggable handle.
- Markup still wins:
  if Patrol markup exists, those explicit anchors are preferred over weak detection.
- Remote weak detections are observation-only:
  on non-loopback pages Patrol can use the same heuristics as evidence for detection, but it does not automatically execute weakly discovered click or drag actions.
- Third-party widgets stay out:
  reCAPTCHA, hCaptcha, Turnstile, Arkose/FunCaptcha, OTP, passkeys, approvals, rotate challenges, and other unsupported flows remain human handoffs.

Weak auto-detection is intended for quick local testing and is less precise than explicit markup. If Patrol cannot confidently isolate the right DOM, it falls back to the normal handoff path rather than guessing.

## 5. Runbook memory

Successful observations continue to be stored only as non-secret metadata, for example:

```json
{
  "kind": "captcha",
  "subtype": "click-sequence",
  "strategy": "ddddocr-click-sequence-demo",
  "occurrences": 2,
  "autoCompletedOccurrences": 2
}
```

A later patrol still runs the detector once because the verification type may change, but it does not need exploratory rediscovery of the site's previous challenge family.

## Scope

The local ddddocr demo solver supports `click-sequence` and `slider-puzzle` through explicit cooperative markup, plus weak unmarked execution on loopback test pages after an exact challenge classification. It does not automate weakly discovered remote challenges, reCAPTCHA, hCaptcha, Cloudflare Turnstile, Arkose/FunCaptcha, OTP, passkeys, device approvals, rotate challenges, or other unsupported third-party verification. Those continue through Patrol's existing human handoff flow.
