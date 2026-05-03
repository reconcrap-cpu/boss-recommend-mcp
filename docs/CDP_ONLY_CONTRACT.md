# CDP-Only Browser Contract

This project must not execute JavaScript inside Boss pages.

## Allowed CDP domains

- `DOM`
- `Input`
- `Accessibility`
- `Browser` for window bounds/state recovery only
- `Network`
- `Page`
- `Target`

All browser automation must go through `src/core/browser/index.js` unless a new helper is added to that layer first.

## Forbidden browser execution

Active runtime code must not use:

- `Runtime.evaluate`
- `Runtime.callFunctionOn`
- `page.evaluate`
- lowercase or wrapper equivalents such as `runtime.evaluate`
- generated page-code strings such as `build*Expression`
- page-context DOM action strings such as executable `document.querySelector(...)` or `.click()`

The only permitted references to forbidden method names are in guard/scanner code that blocks or reports them.

## Required interaction pattern

- Find nodes with `DOM.querySelector` or `DOM.querySelectorAll`.
- Enter iframe documents through `DOM.describeNode(...).node.contentDocument.nodeId`.
- Read node state with `DOM.getAttributes`, `DOM.getOuterHTML`, `DOM.getBoxModel`, and Accessibility tree calls.
- Click with `Input.dispatchMouseEvent` at the center returned from `DOM.getBoxModel`.
- Do not use hard-coded viewport coordinates for product UI interactions. Coordinates are acceptable only when they are derived at runtime from CDP DOM/box-model geometry. Packaged MCP entrypoints must not set or expose fixed fallback points; explicit live-test scripts may record diagnostic fallback points for investigation only.
- Read resume/profile API data through approved `Network` capture or from DOM/AX state, not by page JS.
- Capture visual fallback evidence with `Page.captureScreenshot` only after geometry is derived from CDP DOM/box-model data.
- Perform screenshot stitching, OCR, image segmentation, or vision-model preparation outside the Boss page context.

## Visual inspection rule

Manual/visual screenshots may be used as live-test evidence, but visual inspection is not a product completion or control-flow mechanism. Production run code must decide empty-list, scroll-end, navigation, and action readiness from CDP DOM, Accessibility, Network, and Page state.

## Capture fallback rule

Network-first extraction may remain the production default, but it does not validate fallback behavior. DOM fallback and image fallback require their own live forced-mode tests. A fallback path is not complete until it succeeds live and the method log proves no `Runtime.*` or page-JS execution was used.

## Completion rule

Mock tests support development only. A module is complete only after a live Boss Chrome test passes and the result is recorded in `docs/REWRITE_STATUS.md`.
