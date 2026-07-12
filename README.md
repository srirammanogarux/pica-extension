# Pica 🐾 — learn the code your AI writes

A pixel cat that rides along with your **Hermes agent** in VS Code / Cursor. It watches the code Hermes writes into your workspace, explains it in **designer language**, then makes you type the key line yourself.

Explanations run on **Hermes 4** via the Nous inference API — one free key powers everything.

## Setup (2 minutes)

1. Install the extension: `code --install-extension pica-tutor-0.1.0.vsix` (or Cursor → Extensions → ⋯ → *Install from VSIX*).
2. Open your project folder, click the **cat icon** in the activity bar.
3. Paste your key from **portal.nousresearch.com** (free plan works).
4. Click **Allow Pica to watch**, pick your tone (Friend / Professor).
5. Build with Hermes as normal — when it writes something teachable, Pica pipes up.

## Demo script

- Run **`Pica: Simulate a Hermes Edit`** from the command palette — it writes `Feed.jsx` into your workspace exactly the way the agent would.
- Pica spots it → *"want the 20-second version?"* → **Explain** → **Let me try it** → type the missing token → unlocked.
- Run the command again for a second, different edit (adds a loading state) — the loop repeats with new material.
- Ask anything in the box at the bottom, anytime.

## Notes

- Watches file changes on disk, so it works with Hermes agent, Claude Code, Cursor agent — anything that writes files.
- Teaching is paced: one moment per ~15s max, so it never spams mid-burst.
- Key is stored in VS Code SecretStorage, never in the webview.
