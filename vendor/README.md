# vendor/

Third-party code, kept to the minimum. Everything here is one file you can read and replace.

| File | What | Version | License | sha256 |
|---|---|---|---|---|
| `jsQR.js` | QR decoder, used only on the pairing scan screen | jsQR 1.4.0 (cozmo/jsQR) | Apache-2.0 (`jsQR.LICENSE`) | `bc40c8a15196236b2314db0856f72ca0b49980cd5413b8c852a7349f5fee0859` |

Why it is here: Safari has no `BarcodeDetector`, so without this an iPhone cannot read the pairing QR.
The app uses the native `BarcodeDetector` when the browser has one and loads this file only on the scan screen.
Fetched from `https://cdn.jsdelivr.net/npm/jsqr@1.4.0/dist/jsQR.js`. No build step, no npm in the project.
