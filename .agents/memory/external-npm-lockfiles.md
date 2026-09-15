---
name: External npm lockfiles
description: Why package-lock registry URLs must remain portable for local Mac installs.
---

Package lockfiles shared with developers outside Replit must use public `https://registry.npmjs.org/` tarball URLs, not Replit-internal package firewall hosts.

**Why:** Replit can install from its internal firewall host, but a local Mac cannot resolve that hostname. npm then reports misleading `Exit handler never called` errors after repeated `ENOTFOUND` fetch failures.

**How to apply:** Before delivering a project that will be installed locally, check package-lock.json for `replit.internal` or other private registry URLs and normalize them to the public npm registry when the package metadata and integrity values are unchanged.