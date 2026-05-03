# Capture Fallback Audit

Last updated: 2026-05-02 10:52 Asia/Shanghai.

## Verdict

Network extraction returning detail data is good, but it does not prove the fallback stack is healthy. It only proves the primary path worked.

DOM capture is compatible with the CDP-only restriction when it uses the `DOM` and `Accessibility` domains. It is forbidden when it is implemented by page-context scripts such as `document.querySelector(...)`, `innerText`, `.click()`, or generated expressions executed through `Runtime.evaluate`.

Image fallback is also compatible with the CDP-only restriction when the image is captured through `Page.captureScreenshot`, with nodes discovered and clipped through `DOM.getBoxModel`, and scrolling/clicking performed through `Input` or other approved CDP methods. It is forbidden when the capture depends on page JS to locate canvases, set scroll positions, call DOM APIs, dispatch DOM events, or read canvas data.

Basic single-clip CDP screenshots are no longer accepted as full-CV fallback validation for recommend, search/recruit, or chat. A full-CV fallback gate must use a scroll sequence that captures beyond the initial viewport and records multiple unique screenshots.

Production CV evaluation now starts with Network as the primary source. Image fallback is only used when Network does not produce a parser-usable Boss profile. The shared policy remembers the observed source mode within a run: unknown/network mode uses the legacy full Network wait plus retry; image mode still gives Network a short grace window before switching back to the cheaper full-CV image sequence.

## Current CDP-Only Rewrite State

| Area | Current state | Impact |
| --- | --- | --- |
| Recommend card DOM capture | Built in through `src/domains/recommend/cards.js`, using `DOM.getAttributes` and `DOM.getOuterHTML`. | Compatible and already live-tested for first-card screening. |
| Recommend detail DOM capture | Built in through `src/domains/recommend/detail.js`, using `DOM.getOuterHTML` on the detail popup and resume iframe document when available. | Compatible and already live-tested together with Network detail extraction. |
| Recommend Network detail extraction | Built in through `Network.responseReceived` plus `Network.getResponseBody`. | Compatible and currently the strongest path. It can mask untested fallback paths unless forced fallback gates are added. |
| Shared image fallback | Rebuilt in `src/core/capture/index.js` for node screenshots and scroll screenshot sequences through `DOM.getBoxModel`, CDP `Input` wheel events, and `Page.captureScreenshot`; recommend, recruit/search, and chat full-CV forced image fallback gates passed live. | Full-CV scroll capture is live-verified across the three active surfaces. Model-ready OCR or multimodal LLM handoff is still a separate downstream integration gate. |
| Shared adaptive CV acquisition | Built in `src/core/cv-acquisition/index.js` with Network-primary waits, image-mode grace timing, per-run source state, parsed-profile counting, and evidence summaries. Recommend, recruit/search, and chat cascade gates passed live. | The production source decision is now centralized: parsed Network profile wins; otherwise the domain should capture full-CV scroll images. DOM capture remains evidence/debug support and forced fallback coverage, but it is not a substitute for full-CV image fallback when Network misses. |
| Shared DOM fallback | Rebuilt in `src/core/capture/index.js` for `DOM.getAttributes`, `DOM.getOuterHTML`, and out-of-page text conversion; recommend and recruit forced DOM fallback passed live. | Chat DOM fallback still needs domain integration and a live gate. |

## Legacy Behavior Found

| Source | Legacy capability | CDP-only compatibility |
| --- | --- | --- |
| `legacy/research/vendor/boss-recommend-screen-cli/boss-recommend-screen-cli.cjs` | Cascades from Network resume data to image fallback and then DOM fallback. | Behavior is preserved for research only; the legacy implementation is not compatible because it calls `this.evaluate(...)` / `Runtime.evaluate`. |
| `legacy/research/vendor/boss-recommend-screen-cli/scripts/capture-full-resume-canvas.cjs` | Captures resume screenshots with `Page.captureScreenshot`, chunks/stitches them, and feeds vision model input. | The screenshot call is allowed, but canvas discovery, clipping, scroll state, and scroll mutation are driven by `Runtime.evaluate`; this remains research-only legacy code. |
| `legacy/research/vendor/boss-chat-cli/src/services/resume-capture.js` | Captures resume screenshots with `Page.captureScreenshot`. | The screenshot call is allowed, but the surrounding browser object discovery/probing is page-JS based through `chrome-client.evaluate`; this remains research-only legacy code. |
| `legacy/research/vendor/boss-chat-cli/src/services/resume-network.js` | Supports Network-first resume data and an image-mode grace window. | Network capture is compatible; page interactions feeding it are research-only legacy code. |
| External recruit `vendor/boss-screen-cli/boss-screen-cli.cjs` | Captures resume data from Network, then falls back to DOM extraction; favorite action has DOM/canvas/calibration fallbacks. | Network capture is compatible; DOM extraction, favorite DOM state, canvas position detection, and JS click fallbacks are implemented with `Runtime.evaluate` and must be rewritten. |
| External recruit `src/adapters.js` | Preflight checks `PIL.Image`. | This indicates image-processing dependency support, but the audited latest recruit source did not expose a CDP `Page.captureScreenshot` resume fallback equivalent to recommend/chat. Treat recruit image fallback parity as not yet proven. |

## Restriction Analysis

The new restriction does not remove DOM capture or image fallback. It changes the implementation boundary:

- DOM capture must become `DOM.querySelector` / `DOM.querySelectorAll` / `DOM.describeNode` / `DOM.getAttributes` / `DOM.getOuterHTML` / `Accessibility.getFullAXTree`.
- Image fallback must become `DOM` for discovery, `DOM.getBoxModel` for geometry, `Input` for scroll/click movement, and `Page.captureScreenshot` for pixels.
- Local image processing with `sharp`, Python/Pillow, or model image segmentation is still allowed because it happens outside the Boss page context.
- `Network.getResponseBody` is allowed and should remain the primary extraction path when available.

## Required Shared Layer

Add a shared `core/capture` layer or extend `core/browser` with capture primitives before domain completion:

- `captureNodeHtml(client, nodeId)` returns attributes, outer HTML, text parsed outside the browser, and evidence metadata.
- `captureNodeScreenshot(client, nodeId, options)` uses `DOM.getBoxModel` and `Page.captureScreenshot` with a clip. This is visible-viewport evidence only and must not be used as the full-CV fallback pass gate.
- `captureScrolledNodeScreenshots(client, nodeId, options)` uses CDP-only scroll input plus repeated clipped screenshots; stitching happens locally.
- `captureCandidateEvidence(domain, options)` returns a cascade result with `source: "network" | "dom" | "image"` and records every CDP method used. When screenshot evidence is requested, the default mode is the full-CV scroll sequence; single visible-clip capture is available only through an explicit debug mode and must not be counted as fallback completion.

## Live Gate Implication

Network-first recommend/search live tests can pass through Network detail extraction. That is not enough to mark fallback parity complete.

On 2026-04-30 17:45 Asia/Shanghai, one live recommend candidate produced a Network CV/detail response from `/wapi/zpitem/web/boss/search/geek/info`. The response was available through CDP `Network.getResponseBody`, returned HTTP 200, and contained `zpData.geekDetail`. The existing parser did not recognize that shape because it looked for a different detail key, so Network capture is feasible but the parser needs to support this endpoint.

On 2026-04-30 17:47 Asia/Shanghai, a CDP-only image fallback feasibility trial captured the live detail popup with `Page.captureScreenshot` and saved `.live-artifacts\one-candidate-image-fallback.png`. This proved basic feasibility.

On 2026-04-30 19:23 Asia/Shanghai, the reusable `core/capture` layer passed forced recommend fallback gates:

- DOM forced mode: `npm run live:detail -- --detail-source dom --save-payload .live-artifacts\recommend-forced-dom-fallback-live.json --criteria "候选人具备算法、数据、机器学习或软件开发相关经历"` produced 1,093 chars of detail text and 18,445 chars of outer HTML while ignoring Network bodies for candidate construction.
- Image forced mode: `npm run live:detail -- --detail-source image --save-payload .live-artifacts\recommend-forced-image-fallback-live.json --save-image .live-artifacts\recommend-forced-image-fallback-live.png --criteria "候选人具备算法、数据、机器学习或软件开发相关经历"` saved a 415,920-byte PNG through `Page.captureScreenshot`; pixel sanity check confirmed it was nonblank.
- Both forced modes logged no `Runtime.*` methods.

On 2026-05-01 16:52 Asia/Shanghai, the recommend full-CV image fallback passed live and superseded the earlier single-clip screenshot as the pass gate:

- Command: `npm run live:detail -- --detail-source image --max-image-pages 8 --save-image .live-artifacts\recommend-full-cv-image-fallback.png --save-payload .live-artifacts\recommend-full-cv-image-fallback-live.json --criteria "候选人具备算法、数据、机器学习或软件开发相关经历"`
- The script opened one live recommend detail and captured 6 scroll pages with 4 unique screenshot hashes.
- Image files: `.live-artifacts\recommend-full-cv-image-fallback-page-01.png` through page 06, each 2552x1474 and nonblank.
- CDP methods included `Input.dispatchMouseEvent` wheel events and `Page.captureScreenshot`; no `Runtime.*` methods were logged.

On 2026-05-01 16:59 Asia/Shanghai, the recruit/search full-CV image fallback passed live and superseded the earlier single-clip screenshot as the pass gate:

- Command: `npm run live:recruit-domain -- --detail-source image --slow-live --no-reset-search --no-navigate --max-image-pages 8 --save-image .live-artifacts\recruit-full-cv-image-fallback.png --save-payload .live-artifacts\recruit-full-cv-image-fallback-live.json --criteria "候选人具备算法、数据、机器学习或软件开发相关经历"`
- The first diagnostic run showed a live search edge: 15 cards were present, but a center click did not mount detail. `src/domains/recruit/detail.js` now retries a CDP-only left/title double-click when Boss ignores the center click.
- The passing run opened one live search detail and captured 7 scroll pages with 5 unique screenshot hashes.
- Image files: `.live-artifacts\recruit-full-cv-image-fallback-page-01.png` through page 07, each 2896x1562 and nonblank.
- CDP methods included `Input.dispatchMouseEvent` wheel events and `Page.captureScreenshot`; no `Runtime.*` methods were logged.

On 2026-05-01 16:42 Asia/Shanghai, the chat full-CV image fallback passed live:

- Command: `npm run live:chat-domain -- --slow-live --detail-source image --candidate-index 1 --max-image-pages 8 --resume-dom-timeout-ms 15000 --save-image .live-artifacts\chat-full-cv-image-fallback.png --save-payload .live-artifacts\chat-full-cv-image-fallback-live.json --criteria "候选人具备算法、数据、机器学习或软件开发相关经历"`
- The script selected a live chat candidate, opened the online resume button, captured 8 scroll pages with 6 unique screenshot hashes, and closed the modal.
- Image files: `.live-artifacts\chat-full-cv-image-fallback-page-01.png` through page 08, each 1546x1344 and nonblank.
- CDP methods included `Input.dispatchMouseEvent` wheel events and `Page.captureScreenshot`; no `Runtime.*` methods were logged.

On 2026-05-01 17:33-17:36 Asia/Shanghai, adaptive Network-primary CV acquisition passed live:

- Chat cascade command: `npm run live:chat-domain -- --slow-live --detail-source cascade --candidate-index 1 --network-wait-ms 12000 --network-retry-wait-ms 5000 --max-image-pages 8 --llm-image-limit 8 --resume-dom-timeout-ms 15000 --save-image .live-artifacts\chat-adaptive-cv-cascade-live.png --save-payload .live-artifacts\chat-adaptive-cv-cascade-live.json --criteria "候选人具备算法、数据、机器学习或软件开发相关经历"`. Result: 2 parsed Network profiles, `source=network`, no image fallback needed.
- Recommend cascade command: `npm run live:detail -- --detail-source cascade --network-wait-ms 12000 --network-retry-wait-ms 5000 --max-image-pages 8 --save-image .live-artifacts\recommend-adaptive-cv-cascade-live.png --save-payload .live-artifacts\recommend-adaptive-cv-cascade-live.json --criteria "候选人具备算法、数据、机器学习或软件开发相关经历"`. Result: 1 parsed `geekDetailInfo` profile, `source=network`, no image fallback needed.
- Recruit/search cascade command: `npm run live:recruit-domain -- --detail-source cascade --slow-live --no-reset-search --network-wait-ms 12000 --network-retry-wait-ms 5000 --max-image-pages 8 --save-image .live-artifacts\recruit-adaptive-cv-cascade-live.png --save-payload .live-artifacts\recruit-adaptive-cv-cascade-live.json --criteria "候选人具备算法、数据、机器学习或软件开发相关经历"`. Result: 1 parsed `geekDetail` profile, `source=network`, no image fallback needed.
- Forced search image regression command: `npm run live:recruit-domain -- --detail-source image --slow-live --no-reset-search --no-navigate --max-image-pages 8 --save-image .live-artifacts\recruit-adaptive-cv-forced-image-live.png --save-payload .live-artifacts\recruit-adaptive-cv-forced-image-live.json --criteria "候选人具备算法、数据、机器学习或软件开发相关经历"`. Result: 6 scroll pages, 4 unique screenshot hashes, `mode=image`, no `Network.getResponseBody` use for candidate construction.
- All live runs logged no `Runtime.*` methods. The live commands used longer Network waits due to VPN slowness; the shared defaults remain the legacy 4200 ms primary wait, 2000 ms retry wait, and 1000 ms image-mode grace wait.

Future live scripts need force modes so each fallback is proven against the real Boss page:

- `network`: normal primary path.
- `dom`: skip or ignore Network bodies and prove the DOM capture path produces candidate evidence.
- `image`: skip or ignore Network and DOM text extraction, capture the resume/detail node as a full-CV scroll image sequence, and save model-ready evidence.
- `cascade`: normal production order: Network first; if no parser-usable profile is found, capture full-CV scroll images, with source and fallback reason recorded. DOM capture remains available as evidence/debug support and as a forced compatibility gate, but not as the production full-CV substitute.

Each forced mode must log CDP methods and fail if any `Runtime.*` method is called.
