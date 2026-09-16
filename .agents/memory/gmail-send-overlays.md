---
name: Gmail send overlays
description: Gmail UI notifications that can cover or intercept the compose Send control.
---

Gmail can show an “Enable desktop notifications for Gmail” snackbar over the compose toolbar. It must be dismissed before sending, especially when the Chrome window is small.

**Why:** The overlay can hide or intercept the Send control; enlarging the browser makes the problem appear to disappear, which can lead to unreliable automation.

**How to apply:** Before locating or clicking Send, detect the notification scope and activate its “No, thanks” or close control. Then target the compose toolbar’s Send element rather than broad Send-labelled controls.