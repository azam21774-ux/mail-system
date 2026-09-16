---
name: Mail System licensing architecture
description: The desktop app uses a remote activation API while the Replit-only admin server manages PostgreSQL license records.
---

The admin UI and license API live under `server/` and are intentionally excluded from the Electron builder's `files` list. The packaged app should contain only the activation gate and Electron IPC client; the published server URL belongs in the Electron license configuration before distributing installers.

**Why:** Admin credentials and license state must stay server-side, and users installing the desktop app should never receive the admin panel or database access.

**How to apply:** Keep admin changes in `server/`, keep activation transport in Electron IPC, and set the published server URL before creating a production installer.