# CAPTCHA demo mode

DSH Patrol keeps verification behavior split into centralized runtime modes. Conventional image-text codes continue to use the existing Windows system OCR path. Ordered-click and slider-puzzle automation always supports explicit Patrol markup; weak unmarked DOM automation is controlled by `DSH_PATROL_CAPTCHA_MODE`.

## 1. Install the local solver

The normal Windows installer attempts this automatically. You can also run it separately:

```powershell
cd E:\fangzeming\deepseekHarness\DSH-Patrol
.\scripts\install-captcha-demo.ps1
```

This creates `.captcha-demo-venv` locally and installs `ddddocr==1.6.1`. The environment is ignored by Git.

## 2. Runtime modes

Mode behavior is centralized in `browser-bridge-runtime/captcha-mode.js` so additional modes can be added in one place later.

### Test mode

Test mode is the default:

```powershell
pnpm dsh web
```

You can also force it explicitly:

```powershell
$env:DSH_PATROL_CAPTCHA_MODE="test"
pnpm dsh web
```

Behavior:

- exact `click-sequence` / `slider-puzzle` classification + weak DOM candidate: run ddddocr automatically on any origin;
- weak/none visible-text classification + exactly one weak DOM candidate: the candidate may refine the classification and run ddddocr;
- multiple competing weak candidates: fail closed and use the handoff path rather than guessing;
- explicit markup still wins over weak DOM discovery when both are available;
- third-party reCAPTCHA/hCaptcha/Turnstile/Arkose-style challenges remain human handoffs.

A compatibility toggle is also accepted:

```powershell
$env:DSH_PATROL_CAPTCHA_TEST_MODE="1"
pnpm dsh web
```

If `DSH_PATROL_CAPTCHA_MODE` is explicitly set, it takes precedence over the compatibility toggle.

### Normal mode

Enable normal mode before starting DSH/Harness:

```powershell
$env:DSH_PATROL_CAPTCHA_MODE="normal"
pnpm dsh web
```

Behavior:

- image-text CAPTCHA: Windows OCR may recognize and fill it;
- explicit Patrol `click-sequence` / `slider-puzzle` markup: ddddocr automation is allowed;
- weak unmarked click/slider discovery: detection/classification is allowed, but automatic click/drag is not;
- reCAPTCHA, hCaptcha, Turnstile, Arkose/FunCaptcha and other protected challenge families: human handoff.

## 3. Ordered text-click markup

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

## 4. Slider-puzzle markup

For a slider demo, expose the rendered background, puzzle piece, and draggable handle with explicit markers:

```html
<div data-dsh-patrol-captcha-kind="slider-puzzle">
  <img data-dsh-patrol-captcha-background src="/demo/background.png">
  <img data-dsh-patrol-captcha-piece src="/demo/piece.png">
  <button data-dsh-patrol-captcha-slider-handle type="button" aria-label="drag slider"></button>
</div>
```

Patrol crops the marked background and piece from the current rendered page, runs ddddocr `slide_match` locally, converts the result to a normalized horizontal position, dispatches a pointer/mouse drag on the marked handle, and then re-detects verification state.

## 5. Weak auto-detection

When markup is absent, Patrol can still discover ordinary click/slider components heuristically:

- ordered-click: find click-order wording around a large visible image/canvas and extract the requested target sequence;
- slider-puzzle: find slider/puzzle wording around a likely background image, puzzle piece, and draggable handle;
- explicit markup has priority over weak detection;
- ambiguous or incomplete DOM falls back to the normal handoff path.

Whether a weak candidate is allowed to execute is decided only by the centralized runtime mode.

## 6. Runbook memory

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

The local ddddocr solver supports Patrol's `click-sequence` and `slider-puzzle` families. In the default `test` mode weak unmarked candidates can execute without localhost/IP restrictions; in explicit `normal` mode weak unmarked candidates remain non-executing. reCAPTCHA, hCaptcha, Cloudflare Turnstile, Arkose/FunCaptcha, OTP, passkeys, device approvals, rotate challenges, and other protected/unsupported verification remain human handoffs in every supported mode.
