# CAPTCHA demo mode

DSH Patrol keeps normal verification handling conservative. Conventional image-text codes can use the existing Windows system OCR path. Ordered-click and slider-puzzle automation can now run in two modes: explicit Patrol markup when the page exposes `data-dsh-patrol-captcha-*` anchors, or weak auto-detection when Patrol sees an ordinary visible click-sequence or slider-puzzle challenge shape without markup.

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

If the page does not expose Patrol markup, DSH Patrol can still try the local ddddocr solver for ordinary visible `click-sequence` and `slider-puzzle` challenges that it already classified from page text and DOM evidence.

- Ordered-click fallback:
  Patrol looks for click-order wording near a large visible image or canvas and uses that image as the solve target.
- Slider-puzzle fallback:
  Patrol looks for slider/puzzle wording near a likely background image, puzzle piece, and draggable handle.
- Markup still wins:
  if Patrol markup exists, those explicit anchors are preferred over weak detection.
- Third-party widgets stay out:
  reCAPTCHA, hCaptcha, Turnstile, Arkose/FunCaptcha, OTP, passkeys, approvals, rotate challenges, and other unsupported flows still remain human handoffs.

Weak auto-detection is intended for quick testing and ordinary self-hosted challenge widgets. It is less precise than explicit markup and may fall back to human handoff when Patrol cannot confidently isolate the right DOM.

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

The demo solver supports only `click-sequence` and `slider-puzzle` families, whether they are explicitly marked or weakly auto-detected from an ordinary page. It does not automate reCAPTCHA, hCaptcha, Cloudflare Turnstile, Arkose/FunCaptcha, OTP, passkeys, device approvals, rotate challenges, or other unsupported third-party verification. Those continue through Patrol's existing human handoff flow.
