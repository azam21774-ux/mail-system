---
name: Windows Electron packaging
description: Platform-native dependency and installer constraints for the Windows Electron build.
---

The Windows installer must be built on a Windows runner so optional native packages such as Sharp resolve to Windows binaries. A Linux cross-build can produce a Windows executable directory containing Linux native modules.

**Why:** Electron Builder can assemble the Windows target from Linux, but it does not reliably replace every platform-specific optional native dependency; the local NSIS path also depends on a working Wine runtime.

**How to apply:** Use the Windows CI workflow for the distributable installer and validate the installed app on Windows before release. Keep the lockfile tarball URLs on the public npm registry.