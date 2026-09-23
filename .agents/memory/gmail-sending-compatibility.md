---
name: Gmail sending compatibility
description: The preferred fallback when Gmail's live Compose DOM does not cooperate with isolated ownership.
---

When Gmail's current Compose DOM breaks isolated ownership during a live send, use the proven legacy page-level sending flow rather than forcing the isolation design.

**Why:** The user explicitly preferred the earlier flow after attachment uploads left the newer isolated flow focused in the body and unable to fill recipient, subject, and message fields.

**How to apply:** Treat the legacy flow as the compatibility baseline for future Gmail regressions; only reintroduce Compose isolation after a live-profile test demonstrates that it works end to end.