---
name: crossleak
description: Use after changing authentication, authorization, database access rules (RLS), sharing, or any route that returns per-user data. Runs Kane CLI in a real browser as a second user and as a logged-out visitor to prove one user's data cannot be read by anyone else, then fix whatever Kane catches.
---

# Crossleak: prove users can't read each other's data

Crossleak drives Kane CLI to:
1. sign in as the owner and plant a private record holding a random canary,
2. confirm the owner can still read it (control),
3. try to read it as another user and as a logged-out visitor, on the page URL and the API URL.

## When to run
Run it before you say an auth, RLS, sharing or data-access change is done. "The code looks right" is not proof; Kane's verdict is.

## How
1. Make sure the app is running and `crossleak.config.json` points at it.
2. Run: `node bin/crossleak.js scan --json` (or `crossleak scan --json` if installed globally).
3. Read the JSON on stdout:
   - `"status": "sealed"`: done. Mention the report path to the user.
   - `"status": "leaking"`: each entry in `leaks` names the actor, the URL, and what Kane saw. Open the screenshot listed in `crossleak-report/REPORT.md` for that check, fix the authorization root cause (never hide content with CSS or rename routes), and run the scan again.
   - `"status": "inconclusive"`: a check could not reach a verdict (for example the owner got locked out, or login failed). Treat an owner lock-out as a bug in your fix.
4. Repeat until `sealed`. Never edit the canary, the config, or the report to make it pass.

Use `crossleak heal` instead when you want Crossleak to call the agent for you in a loop.
