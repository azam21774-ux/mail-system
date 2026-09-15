---
name: XLSX floating image rendering
description: Rules for preserving HTML-sized floating image attachments in ExcelJS workbooks.
---

XLSX HTML attachments should use a PNG cropped to the rendered HTML layout bounds, with its logical display dimensions passed to ExcelJS and an absolute one-cell anchor.

**Why:** Pixel-content trimming can cut into valid white HTML margins or clip content, while cell-bound anchors make the image behave like part of the worksheet grid instead of a movable floating object.

**How to apply:** Keep the capture scale separate from the Excel display size, crop using DOM/layout bounds rather than non-background pixels, and use `editAs: 'absolute'` for the floating image.