---
name: Gmail profile readiness
description: How the desktop sender determines whether a newly opened Chrome profile is logged into Gmail.
---

The desktop sender must not treat a launched Chrome process or an open remote-debugging port as proof that a Gmail account is ready. A profile is ready only after the browser can reach Gmail and the authenticated Compose UI is visible.

**Why:** A newly opened profile can remain on Google's sign-in flow after Chrome starts, and a successful login can land on a generic Google page. Without checking Gmail itself, the UI can remain stuck in a misleading ready or waiting state.

**How to apply:** When adding or changing profile onboarding, navigate non-sign-in Google pages to Gmail and poll for a Compose selector through the profile's remote-debugging connection. Keep sign-in states waiting until that selector is visible.