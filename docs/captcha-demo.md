# CAPTCHA demo mode

DSH Patrol keeps normal verification handling conservative. Conventional image-text codes can use the existing Windows system OCR path. Ordered-click and slider-puzzle automation becomes available when the page exposes explicit `data-dsh-patrol-captcha-*` challenge markup.

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

## 4. Runbook memory

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

The demo solver supports only the explicitly marked `click-sequence` and `slider-puzzle` families. It does not automate reCAPTCHA, hCaptcha, Cloudflare Turnstile, Arkose/FunCaptcha, OTP, passkeys, device approvals, or unmarked third-party verification. Those continue through Patrol's existing human handoff flow.
