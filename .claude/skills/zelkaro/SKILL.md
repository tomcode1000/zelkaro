---
name: zelkaro
description: Use after changing authentication, authorization, database access rules (RLS), sharing, or any route that returns per-user data. Runs Kane CLI in a real browser as a second user and as a logged-out visitor to prove one user's data cannot be read by anyone else, then fix whatever Kane catches.
---

# Zelkaro: prove users can't read each other's data

Zelkaro drives Kane CLI to:
1. sign in as the owner and plant a private record holding a random canary,
2. read Kane's network log to discover every route that touched that record (pages and background APIs),
3. try to read each route as another user and as a logged-out visitor,
4. try to overwrite the record as the other user (if `tamper` is configured),
5. confirm the owner still sees the record, untouched (control).

## When to run
Run it before you say an auth, RLS, sharing or data-access change is done. "The code looks right" is not proof; Kane's verdict is.

## How
1. Make sure `zelkaro.config.json` points at the app (with `app.start` set, Zelkaro starts it itself).
2. Run: `node bin/zelkaro.js scan --json` (or `zelkaro scan --json` if installed globally).
3. Read the JSON on stdout:
   - `"status": "sealed"`: done. Mention the report path to the user.
   - `"status": "leaking"`: each entry in `leaks` names the actor, the URL, and what Kane saw. Open the screenshot listed in `zelkaro-report/REPORT.md` for that check, fix the authorization root cause (never hide content with CSS or rename routes), and run the scan again.
   - `"status": "inconclusive"`: a check could not reach a verdict (for example the owner got locked out, or login failed). Treat an owner lock-out as a bug in your fix.
   - Exit codes: `0` sealed, `1` leaking, `2` inconclusive, `4` Kane login expired (ask the user to run `kane-cli login`).
   - A `tampered` leak means another user could change the record: fix the write check, not just reads.
4. If your fix changes server code, restart the app before scanning again. Repeat until `sealed`. Never edit the canary, the config, or the report to make it pass.

Use `zelkaro heal` instead when you want Zelkaro to call the agent for you in a loop.
