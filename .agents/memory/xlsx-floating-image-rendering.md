---
name: XLSX floating image rendering
description: Rules for preserving HTML-sized floating image attachments in ExcelJS workbooks.
---

XLSX HTML attachments should use a full-document Chromium screenshot, with its logical display dimensions passed to ExcelJS and an absolute one-cell anchor.

**Why:** Viewport-based BrowserWindow captures can cut long HTML after responsive reflow, while pixel-content trimming can cut valid white margins; cell-bound anchors also make the image behave like part of the worksheet grid instead of a movable floating object.

**How to apply:** Capture with Chromium DevTools `Page.captureScreenshot` and `captureBeyondViewport`, keep capture scale separate from Excel display size, make overflow visible for attachment rendering, and use `editAs: 'absolute'` for the floating image.