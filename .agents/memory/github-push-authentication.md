---
name: GitHub push authentication
description: Environment-specific recovery when GitHub CLI is authenticated but Git HTTPS pushes reject credentials.
---

When `gh auth status` shows an authenticated account but `git push` reports invalid credentials, configure Git to use the GitHub CLI credential helper with `gh auth setup-git`, then retry the push.

**Why:** The workspace can have a valid GitHub CLI session while Git's HTTPS credential helper still uses stale or missing credentials.

**How to apply:** Check `gh auth status` first, avoid requesting or exposing tokens, run `gh auth setup-git`, and verify that the branch is no longer ahead of its remote after pushing.