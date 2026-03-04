# OpenClaw Token Usage Dashboard (static)

This generates a static dashboard (suitable for GitHub Pages) showing:
- last 5 days token usage broken down by model and agent
- cron job token usage
- workspace context file explorer with file sizes + estimated tokens

## Safety / redaction
- No file contents are included.
- Absolute paths are redacted (publish-ish).
- Token estimate for files uses heuristic: `~ chars/4`.

## Generate data locally
From this directory:

```bash
node ./src/generate-data.js
```

This writes JSON files into `./data/`.

## View locally
Open `index.html` in your browser.

## Deploy to GitHub Pages
- Create a public repo (e.g. `token-dashboard`)
- Commit everything in this folder
- Enable GitHub Pages (Settings → Pages → deploy from branch)

Re-run `node ./src/generate-data.js` before each publish to refresh the data.

## Configuration
You can override locations via env vars:

```bash
OPENCLAW_DIR=/Users/<you>/.openclaw WORKSPACES_DIR=/Users/<you>/.openclaw/workspaces node ./src/generate-data.js
```
