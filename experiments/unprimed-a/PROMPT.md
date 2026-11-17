Build a small multi-user notes web app in this folder.

- Node 18+, zero dependencies (node:http only), single file server.js, ES modules (add a package.json with "type": "module").
- Port from the PORT env var, default 3001.
- Two hardcoded users: alice / alice123 and bob / bob123. Login form at /login, logout link.
- Each user has their own private notes. After login, / lists the user's notes and has a form to create one (title + body).
- Each note has its own page at /notes/:id that shows the title and body.
- There is also a JSON endpoint GET /api/notes/:id for a future mobile app.
- Keep it simple and readable. In-memory storage is fine.
