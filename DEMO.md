# Pica — Demo Script 🐾

A ~5-minute live demo: sign up → install → build something real with your AI → Pica teaches you what it wrote → you play a game to lock it in → you paste a screenshot and Pica reads it.

---

## 0. One-time setup (do this BEFORE the room)

- [ ] Extension installed in VS Code (v0.9.0+). Cat icon shows in the activity bar.
- [ ] You're signed in: cat panel → your **signup email** → your **OpenRouter key** (or a free model, see below).
- [ ] A **scratch folder** open — make an empty one so your agent can write freely:
      `mkdir ~/Desktop/pica-demo && code ~/Desktop/pica-demo`
- [ ] Claude Code (or your Hermes agent) working in that same window.
- [ ] Tone set to **Friend** (top-right of the panel) — warmer for an audience.

**No OpenRouter credits?** Run **`Pica: Choose Model`** → pick a **free** one (Hermes 3 405B, Qwen3 Coder, or Llama 3.3 70B). Everything works with zero credits.

## 0.5. Reset right before you present (30 seconds)

- [ ] Command palette → **`Pica: Reset Arcade (demo)`** → guarantees your **first game is Byte Snake** 🐍 (it shuffles from round 3).
- [ ] Delete `Feed.jsx` / any leftover files from a previous run in the scratch folder.
- [ ] Panel open on the left, editor + Claude on the right. Widen the panel a touch.

---

## THE PRESENTATION (what to say + what to click)

### Beat 1 — The problem (15s, no clicks)
> "I'm a designer. I ship features with AI now — but I can't read a line of what it writes. I approve code I don't understand. Pica fixes that: it's a pixel cat that rides along in my editor and teaches me the code my agent writes, in *my* language."

Point at the **panel cat idling** on the left.

### Beat 2 — Build something real (the complex thing) (45s)
In Claude Code / your agent, paste this prompt **(copy from section below)** — it deliberately touches 5 concepts so there's plenty to teach:

> Build a single-file `github-card.html` — a little "GitHub profile card." An input where I type a GitHub username and a button. On click, fetch that user from `https://api.github.com/users/{username}`, show a "Loading…" state while it waits, then render a card with their avatar, name, and follower count. Below it, fetch and list their 5 most recent public repos. If the username doesn't exist, show a friendly "User not found" message. Plain HTML/CSS/JS, no libraries.

Let the agent write it. **As files land, the panel cat starts *thinking* 🐾** — narrate that: "Watch — it noticed."

### Beat 3 — Pica teaches (60s)
Pica pipes up: *"👀 Hermes touched github-card.html — want the 20-second version?"*
- Click **Yes — explain it.**
- Read Pica's explanation aloud. It'll pick one concept (likely **fetching from an API**, **loading state**, or **mapping the repo list**).
- Say: "This is the thing I'd normally just nod at. Now I actually get it."

### Beat 4 — You write the line (30s)
- Click **🎮 Practice — MCQ** (or **Code**).
- Panel: *"🎲 Starting with Byte Snake!"* → the **Game Mode tab** opens.
- Play 2–3 questions. **Narrate the game**: "Every right answer, the snake eats a byte and grows. It's brain-training for code — think Elevate, but the questions come from the code *I* just shipped."
- Land a combo → the ×2 pops, sounds fire. Finish → the **cheering cat** on the end card.

### Beat 5 — Ask anything, with a screenshot (45s) ⭐ the new bit
- Back to the panel. Say: "Say something breaks and I can't tell what — I just screenshot it."
- Take a screenshot (Cmd+Shift+4), **paste it into Pica's chat box** (Cmd+V). A thumbnail chip appears.
- Type: *"what's going on here?"* → send.
- Pica reads the image and explains it in plain words. "It can *see* my screen. Error, a diagram, a design — anything."

### Beat 6 — The close (15s)
> "Sign up, install, point it at your project. In a week you stop nodding along — and start shipping code you actually understand. That's Pica."

Show the **QR code** (`~/Desktop/pica-qr.png`) → "Scan to try it."

---

## The build prompt (copy-paste for your agent)

```
Build a single-file github-card.html — a little "GitHub profile card."
An input where I type a GitHub username and a button. On click, fetch that
user from https://api.github.com/users/{username}, show a "Loading…" state
while it waits, then render a card with their avatar, name, and follower
count. Below it, fetch and list their 5 most recent public repos. If the
username doesn't exist, show a friendly "User not found" message.
Plain HTML/CSS/JS, no libraries.
```

**Why this one:** it uses a real public API (no key, works live), and packs 5 teachable concepts — talking to a server (`fetch`/async), a loading state, rendering a list (`.map`), handling the not-found case (error state), and an event handler (the button). Pica gets rich material; the games get good questions.

**Backup if the live agent misbehaves:** run **`Pica: Simulate a Hermes Edit`** — it writes a realistic `Feed.jsx` and triggers the exact same teach → practice → game loop, no agent needed.

---

## If something goes sideways
- **Panel silent after the agent writes** → make sure a *folder* is open and you clicked **Allow Pica to watch**. Or just run `Pica: Simulate a Hermes Edit`.
- **"Out of credits" (402)** → `Pica: Choose Model` → a free one. Keep going.
- **Image not analyzing** → the vision model is free/rate-limited; retry once, or paste a smaller screenshot.
- **Wrong first game** → `Pica: Reset Arcade (demo)` and start the round again.

## The one-liner if you only get 30 seconds
> "Elevate for code — played against the code your AI just wrote for you."
