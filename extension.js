/* =====================================================================
   PICA — VS Code / Cursor extension
   A pixel cat that rides along with the Hermes agent: watches the code it
   writes into your workspace, explains it in designer language, then makes
   you type the key line yourself.

   Explanations are powered by Hermes 4 via OpenRouter
   (OpenAI-compatible). Key comes from openrouter.ai/keys.
   ===================================================================== */
const vscode = require("vscode");

const CONFIG = {
  PROXY_BASE: "https://doting-cuttlefish-341.convex.site", // Pica backend: verifies signup email
  CONVEX_URL: "https://doting-cuttlefish-341.convex.cloud", // usage pings (email+counts only)
  LANDING: "https://coachme-pica.vercel.app",
  // inference endpoint + model are chosen per-provider from the user's key — see providerFor()
  DEBOUNCE_MS: 1400,     // let an agent write-burst settle before teaching
  COOLDOWN_MS: 15000,    // min gap between proactive teach moments
  MAX_FILE_BYTES: 200 * 1024,
  MAX_SNAPSHOT_FILES: 400,
  CODE_EXTS: ["js","jsx","ts","tsx","py","html","css","scss","vue","svelte","go","rb","java","c","cpp","h","swift","kt","php","rs","sql","sh"],
  IGNORE_SEGMENTS: ["node_modules",".git","dist","build","out",".next",".venv","venv","__pycache__",".vercel","coverage",".idea"],
  PORTAL_URL: "https://openrouter.ai/keys",
};

// ---------------------------------------------------------------------
// small utils
// ---------------------------------------------------------------------
const dec = new TextDecoder();
const enc = new TextEncoder();
function extOf(fsPath) {
  const i = fsPath.lastIndexOf(".");
  return i === -1 ? "" : fsPath.slice(i + 1).toLowerCase();
}
function isCodeFile(fsPath) {
  if (!CONFIG.CODE_EXTS.includes(extOf(fsPath))) return false;
  const parts = fsPath.split(/[\\/]/);
  return !parts.some((p) => CONFIG.IGNORE_SEGMENTS.includes(p));
}
function esc(s) {
  return String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}
function normAnswer(s) {
  return String(s).toLowerCase().replace(/\s+/g, "").replace(/[;'"`]/g, "");
}

// ---------------------------------------------------------------------
// Provider routing — Pica works with ANY of these keys.
// ---------------------------------------------------------------------
// We detect the provider from the key's prefix and route to the right endpoint:
//   sk-or-… → OpenRouter     (one key, hundreds of models incl. free ones)
//   AIza…   → Google Gemini  (native, via its OpenAI-compatible endpoint)
//   sk-ant-…→ Anthropic      (native Claude Messages API — NOT OpenAI-shaped)
//   sk-…    → OpenAI
// OpenRouter / Gemini / OpenAI share the /chat/completions shape; Anthropic uses
// its own Messages API, so hermesChat branches on provider.id === "anthropic".
function providerFor(key) {
  const k = (key || "").trim();
  if (k.startsWith("sk-or-")) return {
    id: "openrouter", label: "OpenRouter",
    base: "https://openrouter.ai/api/v1",
    model: "nousresearch/hermes-4-70b",
    vision: "google/gemma-4-31b-it:free", // OpenRouter default text model can't see images
  };
  if (k.startsWith("AIza")) return {
    id: "gemini", label: "Google Gemini",
    base: "https://generativelanguage.googleapis.com/v1beta/openai",
    model: "gemini-2.0-flash",
    vision: "gemini-2.0-flash", // Gemini is multimodal — same model reads images
  };
  // sk-ant- must be checked BEFORE sk- (Anthropic keys also start with "sk-").
  if (k.startsWith("sk-ant-")) return {
    id: "anthropic", label: "Anthropic (Claude)",
    base: "https://api.anthropic.com/v1", // uses the native Messages API, not /chat/completions
    model: "claude-haiku-4-5",  // fast + affordable default, matching the other providers' cheap tier
    vision: "claude-haiku-4-5", // every Claude model is multimodal
  };
  if (k.startsWith("sk-")) return {
    id: "openai", label: "OpenAI",
    base: "https://api.openai.com/v1",
    model: "gpt-4o-mini",
    vision: "gpt-4o-mini", // GPT-4o-mini is multimodal
  };
  // Unknown prefix → assume OpenRouter (most permissive; most likely).
  return {
    id: "openrouter", label: "OpenRouter",
    base: "https://openrouter.ai/api/v1",
    model: "nousresearch/hermes-4-70b",
    vision: "google/gemma-4-31b-it:free",
  };
}

// Does a user-set model id look like it belongs to this provider? If so, honor it;
// otherwise we fall back to the provider's default so a stale setting can't break a key.
function modelMatchesProvider(model, provider) {
  if (!model) return false;
  const m = String(model).toLowerCase();
  if (provider.id === "gemini") return m.startsWith("gemini") || m.startsWith("models/gemini");
  if (provider.id === "anthropic") return m.startsWith("claude");
  if (provider.id === "openai") return m.startsWith("gpt") || m.startsWith("o1") || m.startsWith("o3") || m.startsWith("o4") || m.startsWith("chatgpt");
  return m.includes("/"); // OpenRouter model ids are always "author/model"
}

// BYO-key model: every user brings their OWN key (OpenRouter, Gemini, or OpenAI).
// It lives in VS Code SecretStorage on their machine only — never bundled, synced, or sent to us.
async function hermesChat(context, messages, kind, opts) {
  opts = opts || {};
  const key = await context.secrets.get("pica.nousKey");
  if (!key) throw new Error("NO_KEY");
  const provider = providerFor(key);
  const cfg = vscode.workspace.getConfiguration("pica");
  // Model precedence: explicit per-call override → user setting (only if it fits
  // this provider) → the provider's sensible default. Vision calls prefer a model
  // that can actually see images.
  let model = opts.model;
  if (!model && opts.vision) {
    const uv = cfg.get("visionModel");
    model = modelMatchesProvider(uv, provider) ? uv : provider.vision;
  }
  if (!model) {
    const um = cfg.get("model");
    model = modelMatchesProvider(um, provider) ? um : provider.model;
  }
  // Anthropic speaks its own Messages API — route it through a dedicated path.
  if (provider.id === "anthropic") return anthropicChat(context, key, model, messages, kind);
  const res = await fetch(provider.base + "/chat/completions", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: "Bearer " + key,
      "HTTP-Referer": CONFIG.LANDING,
      "X-Title": "Pica",
    },
    body: JSON.stringify({ model, messages, temperature: 0.6, max_tokens: 900 }),
  });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    if (res.status === 401 || res.status === 403) throw new Error("BAD_KEY");
    if (res.status === 400 && /api[_ ]?key|invalid.*key|API_KEY_INVALID/i.test(body)) throw new Error("BAD_KEY");
    if (res.status === 402) throw new Error("NO_CREDITS");
    if (res.status === 429) throw new Error(/quota|insufficient|billing/i.test(body) ? "NO_CREDITS" : "RATE_LIMIT");
    throw new Error("API_" + res.status + " " + body.slice(0, 200));
  }
  const data = await res.json();
  const text = data && data.choices && data.choices[0] && data.choices[0].message
    ? (data.choices[0].message.content || "") : "";
  if (!text) throw new Error("EMPTY_REPLY");
  logEvent(context, kind || "chat", Number(data && data.usage && data.usage.total_tokens) || 0);
  return text.trim();
}

// Convert an OpenAI-style message content (string, or [{type:text|image_url}])
// into Anthropic content blocks. Data-URI images become base64 image blocks.
function toAnthropicContent(content) {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return String(content || "");
  return content.map((part) => {
    if (!part || typeof part !== "object") return { type: "text", text: String(part || "") };
    if (part.type === "text") return { type: "text", text: part.text || "" };
    if (part.type === "image_url") {
      const url = (part.image_url && part.image_url.url) || "";
      const m = /^data:(.+?);base64,([\s\S]*)$/.exec(url);
      if (m) return { type: "image", source: { type: "base64", media_type: m[1], data: m[2] } };
      return { type: "image", source: { type: "url", url } };
    }
    return { type: "text", text: "" };
  });
}

// Anthropic (Claude) native Messages API. System goes top-level; images become
// base64 blocks; no temperature (removed on current Claude models). BYO x-api-key.
async function anthropicChat(context, key, model, messages, kind) {
  let system = "";
  const conv = [];
  for (const m of messages) {
    if (m.role === "system") {
      if (typeof m.content === "string") system += (system ? "\n\n" : "") + m.content;
      continue;
    }
    conv.push({
      role: m.role === "assistant" ? "assistant" : "user",
      content: toAnthropicContent(m.content),
    });
  }
  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-api-key": key,
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify({ model, max_tokens: 900, system: system || undefined, messages: conv }),
  });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    if (res.status === 401 || res.status === 403) throw new Error("BAD_KEY");
    if (res.status === 400 && /x-api-key|authentication|invalid.*key|api key/i.test(body)) throw new Error("BAD_KEY");
    if (res.status === 429) throw new Error(/credit|quota|billing/i.test(body) ? "NO_CREDITS" : "RATE_LIMIT");
    if (res.status === 529) throw new Error("RATE_LIMIT");
    throw new Error("API_" + res.status + " " + body.slice(0, 200));
  }
  const data = await res.json();
  const text = Array.isArray(data.content)
    ? data.content.filter((b) => b && b.type === "text").map((b) => b.text).join("")
    : "";
  if (!text) throw new Error("EMPTY_REPLY");
  const usage = data && data.usage;
  logEvent(context, kind || "chat", usage ? Number(usage.input_tokens || 0) + Number(usage.output_tokens || 0) : 0);
  return text.trim();
}

// Fire-and-forget usage ping to Convex (email + kind + tokens only — never the key).
function logEvent(context, kind, tokens) {
  const email = context.globalState.get("pica.email");
  if (!email) return;
  fetch(CONFIG.CONVEX_URL + "/api/mutation", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ path: "mutations:logEvent", args: { email, kind, tokens }, format: "json" }),
  }).catch(() => { /* metrics only — never block the user */ });
}

async function verifyEmail(email) {
  const res = await fetch(CONFIG.PROXY_BASE + "/pica/auth", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email }),
  });
  if (!res.ok) return false;
  const data = await res.json().catch(() => ({}));
  return !!data.ok;
}

function parseJSONBlock(text, requiredKey) {
  // tolerate ```json fences and stray prose around the object
  let t = text.replace(/```json/gi, "```").replace(/```/g, "").trim();
  const a = t.indexOf("{"), b = t.lastIndexOf("}");
  if (a !== -1 && b > a) t = t.slice(a, b + 1);
  try {
    const j = JSON.parse(t);
    if (j && (!requiredKey || j[requiredKey] !== undefined)) return j;
  } catch (e) { /* fall through */ }
  return null;
}
const parseLessonJSON = (text) => parseJSONBlock(text, "explanation");

function teachSystemPrompt(tone, agent) {
  agent = agent || "the agent";
  const voice = tone === "professor"
    ? "TONE: professor — precise, calm, structured. Still zero jargon without an instant plain-words translation. No emoji."
    : "TONE: friend — warm, playful, encouraging. A single 🐾 is welcome when it fits.";
  return [
    "You are Pica, a pixel-art cat living in a code editor. You teach DESIGNERS the code their AI coding agent (called \"" + agent + "\") just wrote. Refer to the agent as \"" + agent + "\" when you mention it. The reader is a smart product/UX designer who ships software but cannot read code yet.",
    voice,
    "You will be given a code change (filename + the lines that were added or changed). Pick the ONE most teachable thing in it and respond with ONLY this JSON (no markdown fences, no prose outside it):",
    '{"teaser":"one-line hook question, max 90 chars, about the specific thing (e.g. \'' + agent + ' just added a loop that draws your whole list — want the 20-second version?\')",',
    '"explanation":"2-4 short sentences in designer language. Analogies from design/everyday life. Explain what it DOES for the product, not syntax trivia.",',
    '"concept":"Name the single concept in <=12 words, e.g. \'Mapping a list — one row of data in, one piece of UI out.\'",',
    '"practice":{"prompt":"one-line fill-in-the-blank instruction","display":"1-3 lines of the REAL code from the diff with the key token replaced by ____","answer":"the exact missing token"}}',
    "Keep every string short. The practice answer must be a single short token or expression the user can type.",
  ].join("\n");
}

function chatSystemPrompt(tone, contextBlock, agent) {
  agent = agent || "their coding agent";
  const voice = tone === "professor"
    ? "Tone: professor — precise, calm, jargon-free."
    : "Tone: friend — warm, playful, a 🐾 when it fits.";
  return [
    "You are Pica, a pixel-art cat living inside the user's code editor (VS Code), teaching a designer who cannot read code yet. Answer in designer language: plain words, design-world analogies, 2-5 short sentences max. Never a wall of text. Never condescend.",
    "IMPORTANT: You are inside their real software project. ALWAYS interpret questions in the context of software development and THIS project. Examples: 'OpenRouter key' means the API key for the OpenRouter LLM service (never a Wi-Fi router); 'terminal' means the editor's terminal; 'agent' means their coding agent (\"" + agent + "\"). When they ask what something is, relate it to what they're building right now if you can.",
    voice,
    contextBlock ? "=== LIVE PROJECT CONTEXT (use this!) ===\n" + contextBlock : "",
  ].filter(Boolean).join("\n");
}

// ---------------------------------------------------------------------
// Snapshot store + diff
// ---------------------------------------------------------------------
class Snapshots {
  constructor() { this.map = new Map(); }
  get(key) { return this.map.get(key); }
  set(key, content) {
    if (this.map.size > CONFIG.MAX_SNAPSHOT_FILES && !this.map.has(key)) return;
    this.map.set(key, content);
  }
}

function addedLines(oldText, newText) {
  const oldSet = new Set((oldText || "").split("\n").map((l) => l.trim()));
  const out = [];
  for (const line of newText.split("\n")) {
    const t = line.trim();
    if (!t || t.length < 3) continue;               // skip blanks / lone braces
    if (/^[{}()\[\];,]+$/.test(t)) continue;
    if (!oldSet.has(t)) out.push(line);
    if (out.length >= 60) break;
  }
  return out;
}

// ---------------------------------------------------------------------
// The panel (webview) — all UI lives here
// ---------------------------------------------------------------------
class PicaPanel {
  constructor(context, engine) {
    this.context = context;
    this.engine = engine;
    this.view = null;
  }
  resolveWebviewView(view) {
    this.view = view;
    const wv = view.webview;
    wv.options = { enableScripts: true, localResourceRoots: [vscode.Uri.joinPath(this.context.extensionUri, "media")] };
    wv.html = this.html(wv);
    wv.onDidReceiveMessage((m) => this.engine.onPanelMessage(m));
    view.onDidDispose(() => { this.view = null; });
  }
  post(msg) { if (this.view) this.view.webview.postMessage(msg); }
  html(wv) {
    const uri = (f) => wv.asWebviewUri(vscode.Uri.joinPath(this.context.extensionUri, "media", f));
    const nonce = Math.random().toString(36).slice(2);
    return `<!doctype html><html><head><meta charset="utf-8"/>
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src ${wv.cspSource} data:; style-src ${wv.cspSource} 'unsafe-inline' https://fonts.googleapis.com; font-src https://fonts.gstatic.com; script-src 'nonce-${nonce}';"/>
<link href="https://fonts.googleapis.com/css2?family=Pixelify+Sans:wght@700&family=JetBrains+Mono:wght@400;500&display=swap" rel="stylesheet"/>
<link href="${uri("panel.css")}" rel="stylesheet"/>
</head><body>
<header class="head">
  <img class="sprite headcat" id="headcat" src="${uri("cat-idle.webp")}" width="34" height="34"/>
  <div class="head__t"><strong>Pica</strong><span id="status">waking up…</span></div>
  <div class="tones" id="tones" title="Teaching tone">
    <button data-tone="friend" class="tone">Friend</button>
    <button data-tone="professor" class="tone">Prof</button>
  </div>
</header>
<nav class="toolsrow">
  <button class="tool" id="t-recap" title="Short recap of what's being built">📋 Recap</button>
  <button class="tool" id="t-quiz" title="Quiz me on what I learned">🧠 Quiz</button>
  <button class="tool" id="t-fp" title="Blank out the real file so I can practice">✍️ Blank the file</button>
  <button class="tool" id="t-fpcheck" title="Check my filled blanks">✓ Check</button>
</nav>
<main id="thread"></main>
<div class="attachbar" id="attachbar"></div>
<footer class="composer">
  <button id="attach" title="Attach a screenshot (or just paste one)">🖼</button>
  <input id="ask" type="text" placeholder="Ask Pica, or paste a screenshot…" autocomplete="off"/>
  <button id="send">➤</button>
</footer>
<script nonce="${nonce}">window.PICA_SPRITE="${uri("pica.png")}";window.PICA_CATS={idle:"${uri("cat-idle.webp")}",think:"${uri("cat-think.webp")}",cheer:"${uri("cat-cheer.webp")}",encourage:"${uri("cat-encourage.webp")}"};</script>
<script nonce="${nonce}" src="${uri("panel.js")}"></script>
</body></html>`;
  }
}

// ---------------------------------------------------------------------
// Engine — state machine wiring watcher ⇄ Hermes ⇄ panel
// ---------------------------------------------------------------------
class Engine {
  constructor(context, panel) {
    this.context = context;
    this.panel = panel;
    this.snapshots = new Snapshots();
    this.pending = new Map();          // fsPath -> newContent (batched during debounce)
    this.debounceTimer = null;
    this.lastTeachAt = 0;
    this.lesson = null;                // current {teaser, explanation, concept, practice, file}
    this.lastDiffText = "";
    this.recentDiffs = [];             // rolling [{file, lines, at}] — session context
    this.taughtConcepts = [];          // rolling list of concepts Pica taught
    this.workspaceBrief = "";          // project name + top-level structure
    this.detectedAgent = "your agent"; // auto-detected coding agent name
    this.quiz = null;                  // {questions, i, score}
    this.fp = null;                    // file practice {doc, file, blanks}
    this.chatHistory = [];
    this.watcher = null;
    this.feedbackAsked = false;        // ask for feedback at most once per session
  }

  // What Pica knows about the session right now — fed to every chat/recap/quiz.
  contextBlock() {
    const parts = [];
    if (this.workspaceBrief) parts.push(this.workspaceBrief);
    // chat panels steal focus → activeTextEditor is often undefined; fall back to any visible editor
    const ed = vscode.window.activeTextEditor ||
      (vscode.window.visibleTextEditors || []).find((e) => e.document && !e.document.isUntitled);
    if (ed && ed.document && !ed.document.isUntitled) {
      const rel = vscode.workspace.asRelativePath(ed.document.uri);
      const sel = ed.selection && !ed.selection.isEmpty ? ed.document.getText(ed.selection) : "";
      const slice = sel || ed.document.getText().split("\n").slice(0, 60).join("\n");
      parts.push("Open file right now: " + rel + "\n---\n" + slice.slice(0, 2400) + "\n---");
    }
    if (this.recentDiffs.length) {
      parts.push("Recent changes the agent made this session:\n" + this.recentDiffs
        .map((d) => "• " + d.file + ":\n" + d.lines.join("\n")).join("\n").slice(0, 2400));
    }
    if (this.taughtConcepts.length) parts.push("Concepts Pica already taught this session: " + this.taughtConcepts.join(" · "));
    return parts.join("\n\n").slice(0, 6000);
  }

  // The name Pica calls the coding agent — user setting wins, else auto-detect.
  get agentName() {
    const c = vscode.workspace.getConfiguration("pica").get("agentName");
    return (c && c.trim()) || this.detectedAgent || "your agent";
  }
  async detectAgent() {
    const f = vscode.workspace.workspaceFolders;
    if (!f || !f.length) return;
    const root = f[0].uri;
    const has = async (p) => { try { await vscode.workspace.fs.stat(vscode.Uri.joinPath(root, p)); return true; } catch (e) { return false; } };
    if (await has(".claude") || await has("CLAUDE.md")) this.detectedAgent = "Claude Code";
    else if (await has(".cursor")) this.detectedAgent = "Cursor";
    else if (await has(".aider.conf.yml")) this.detectedAgent = "Aider";
    else this.detectedAgent = "your agent";
  }

  async buildWorkspaceBrief() {
    const folders = vscode.workspace.workspaceFolders;
    if (!folders || !folders.length) return;
    try {
      const root = folders[0];
      const entries = await vscode.workspace.fs.readDirectory(root.uri);
      const listing = entries
        .filter(([name]) => !CONFIG.IGNORE_SEGMENTS.includes(name) && !name.startsWith("."))
        .slice(0, 30)
        .map(([name, type]) => (type === vscode.FileType.Directory ? name + "/" : name))
        .join(", ");
      this.workspaceBrief = "The user's project: \"" + root.name + "\" — top level: " + listing;
    } catch (e) { /* best-effort */ }
  }

  get tone() { return this.context.globalState.get("pica.tone", "friend"); }
  set tone(v) { this.context.globalState.update("pica.tone", v); }
  get allowed() { return this.context.workspaceState.get("pica.allowed", false); }
  set allowed(v) { this.context.workspaceState.update("pica.allowed", v); }
  get email() { return this.context.globalState.get("pica.email", ""); }

  async hasKey() { return !!(await this.context.secrets.get("pica.nousKey")); }
  async authed() { return !!this.email && (await this.hasKey()); }   // step 1: email, step 2: own key

  // ---------- panel protocol ----------
  async onPanelMessage(m) {
    try {
      switch (m.type) {
        case "ready":     return this.sendInit();
        case "saveEmail": {
          const email = String(m.email || "").trim().toLowerCase();
          if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return this.panel.post({ type: "error", text: "That email looks off — mind checking it?" });
          this.panel.post({ type: "busy", on: true });
          const ok = await verifyEmail(email);
          this.panel.post({ type: "busy", on: false });
          if (!ok) return this.panel.post({ type: "error", text: "I don't see that email on the list yet — grab your spot at " + CONFIG.LANDING + " first, then try again 🐾" });
          await this.context.globalState.update("pica.email", email);
          return this.sendInit();
        }
        case "saveKey": {
          const key = String(m.key || "").trim();
          if (key.length < 12) return this.panel.post({ type: "error", text: "That key looks too short — paste the whole thing (starts with sk-or-…)." });
          await this.context.secrets.store("pica.nousKey", key);
          return this.sendInit();
        }
        case "tone":      this.tone = m.tone === "professor" ? "professor" : "friend"; return;
        case "allow":     this.allowed = true; this.startWatching(); return this.sendInit();
        case "explain":   return this.panel.post({ type: "lesson", data: this.lesson || null });
        case "practiceSubmit": return this.checkPractice(m.answer);
        case "feedback":  return this.saveFeedback(m.rating, m.note);
        case "feedbackDismiss": this.context.globalState.update("pica.feedbackGiven", true); return;
        case "ask":       return this.answer(String(m.text || ""), m.image || null);
        case "pickImage": return this.pickImage();
        case "recap":     return this.recap();
        case "quiz":      return this.startQuiz();
        case "quizPick":  return this.quizPick(Number(m.pick));
        case "filePractice": return this.startFilePractice();
        case "fileCheck": return this.checkFilePractice();
        case "game":      return this.arcade ? this.arcade.start(m.mode === "code" ? "code" : "mcq") : null;
        case "simulate":  return vscode.commands.executeCommand("pica.simulateHermes");
      }
    } catch (e) { this.fail(e); }
  }

  async sendInit() {
    this.buildWorkspaceBrief();   // project context available even before watching starts
    await this.detectAgent();     // figure out which coding agent we're riding along with
    this.panel.post({
      type: "init",
      state: {
        hasEmail: !!this.email,
        hasKey: await this.hasKey(),
        email: this.email,
        allowed: this.allowed,
        tone: this.tone,
        agent: this.agentName,
        hasWorkspace: !!(vscode.workspace.workspaceFolders && vscode.workspace.workspaceFolders.length),
        landing: CONFIG.LANDING,
      },
    });
    if (this.allowed && (await this.authed())) this.startWatching();
  }

  fail(e) {
    const msg = String((e && e.message) || e);
    if (msg === "NO_KEY")     return this.panel.post({ type: "needKey" });
    if (msg === "BAD_KEY")    return this.panel.post({ type: "error", text: "That key didn't work — double-check it (OpenRouter, Gemini, Anthropic/Claude, or OpenAI) and re-paste via “Pica: Set My API Key”." });
    if (msg === "NO_CREDITS") return this.panel.post({ type: "error", text: "Out of credits/quota on your provider — top up, or if you're on OpenRouter run “Pica: Choose Model” and pick a free one 🐾" });
    if (msg === "RATE_LIMIT") return this.panel.post({ type: "error", text: "Whoa — your provider says too many requests too fast (429). Give it a few seconds and try again 🐾" });
    this.panel.post({ type: "error", text: "Pica hiccupped: " + msg.slice(0, 140) });
  }

  // ---------- watching ----------
  async startWatching() {
    if (this.watcher || !vscode.workspace.workspaceFolders) return;
    this.buildWorkspaceBrief();
    // snapshot the workspace so the first agent edit diffs cleanly
    const glob = "**/*.{" + CONFIG.CODE_EXTS.join(",") + "}";
    const exclude = "{**/node_modules/**,**/.git/**,**/dist/**,**/build/**,**/out/**,**/.next/**,**/venv/**,**/.venv/**}";
    try {
      const files = await vscode.workspace.findFiles(glob, exclude, CONFIG.MAX_SNAPSHOT_FILES);
      for (const uri of files) {
        try {
          const bytes = await vscode.workspace.fs.readFile(uri);
          if (bytes.byteLength <= CONFIG.MAX_FILE_BYTES) this.snapshots.set(uri.fsPath, dec.decode(bytes));
        } catch (e) { /* unreadable file — skip */ }
      }
    } catch (e) { /* snapshotting is best-effort */ }

    this.watcher = vscode.workspace.createFileSystemWatcher(glob);
    const onEvt = (uri) => this.onFileEvent(uri);
    this.watcher.onDidChange(onEvt);
    this.watcher.onDidCreate(onEvt);
    this.context.subscriptions.push(this.watcher);
    this.panel.post({ type: "status", text: "watching your code", agent: "● " + this.agentName + " · connected" });
  }

  async onFileEvent(uri) {
    if (!isCodeFile(uri.fsPath)) return;
    let text;
    try {
      const bytes = await vscode.workspace.fs.readFile(uri);
      if (bytes.byteLength > CONFIG.MAX_FILE_BYTES) return;
      text = dec.decode(bytes);
    } catch (e) { return; }
    this.pending.set(uri.fsPath, text);
    clearTimeout(this.debounceTimer);
    this.debounceTimer = setTimeout(() => this.processPending().catch((e) => this.fail(e)), CONFIG.DEBOUNCE_MS);
  }

  async processPending() {
    const batch = [...this.pending.entries()];
    this.pending.clear();
    if (!batch.length) return;

    // pick the file with the most new material
    let best = null;
    for (const [fsPath, text] of batch) {
      const old = this.snapshots.get(fsPath);
      const added = addedLines(old, text);
      this.snapshots.set(fsPath, text);
      if (!best || added.length > best.added.length) best = { fsPath, added };
    }
    if (!best || best.added.length === 0) return;
    if (Date.now() - this.lastTeachAt < CONFIG.COOLDOWN_MS) return;   // pace the teaching
    this.lastTeachAt = Date.now();

    const rel = vscode.workspace.asRelativePath(best.fsPath);
    const diffText = "File: " + rel + "\nAdded/changed lines:\n" + best.added.slice(0, 40).join("\n").slice(0, 3000);
    this.lastDiffText = diffText;
    this.recentDiffs.push({ file: rel, lines: best.added.slice(0, 12), at: Date.now() });
    if (this.recentDiffs.length > 4) this.recentDiffs.shift();

    this.panel.post({ type: "spotted", file: rel });
    let lesson = null;
    try {
      const raw = await hermesChat(this.context, [
        { role: "system", content: teachSystemPrompt(this.tone, this.agentName) },
        { role: "user", content: diffText },
      ], "lesson");
      lesson = parseLessonJSON(raw);
      if (!lesson) lesson = { teaser: this.agentName + " just wrote something worth knowing — want the short version?", explanation: raw.slice(0, 600), concept: "", practice: null };
    } catch (e) { this.panel.post({ type: "spotfail" }); return this.fail(e); }
    lesson.file = rel;
    this.lesson = lesson;
    if (lesson.concept) {
      this.taughtConcepts.push(lesson.concept);
      if (this.taughtConcepts.length > 8) this.taughtConcepts.shift();
    }
    this.panel.post({ type: "moment", data: { file: rel, teaser: lesson.teaser, hasPractice: !!(lesson.practice && lesson.practice.display && lesson.practice.answer) } });
  }

  // ---------- practice ----------
  checkPractice(answer) {
    const p = this.lesson && this.lesson.practice;
    if (!p) return;
    const ok = normAnswer(answer) === normAnswer(p.answer) ||
               (normAnswer(answer).length >= 3 && normAnswer(p.answer).includes(normAnswer(answer))) ||
               (normAnswer(answer).length >= 3 && normAnswer(answer).includes(normAnswer(p.answer)));
    this.panel.post({ type: "practiceResult", ok, answer: p.answer, concept: this.lesson.concept || "" });
    this.maybeAskFeedback();
  }

  // ---------- feedback: after the first full teach→practice loop, ask once ----------
  maybeAskFeedback() {
    if (this.feedbackAsked) return;                                  // once per session
    if (this.context.globalState.get("pica.feedbackGiven")) return;  // and never again once answered
    this.feedbackAsked = true;
    // let the practice result land first, then ask
    setTimeout(() => this.panel.post({ type: "feedbackPrompt" }), 1400);
  }

  saveFeedback(rating, note) {
    this.context.globalState.update("pica.feedbackGiven", true);
    const email = this.context.globalState.get("pica.email") || "";
    fetch(CONFIG.CONVEX_URL + "/api/mutation", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        path: "mutations:addFeedback",
        args: { email, rating: rating === "down" ? "down" : "up", note: String(note || "").slice(0, 500) },
        format: "json",
      }),
    }).catch(() => { /* fire-and-forget — never block the user */ });
    this.panel.post({ type: "feedbackThanks" });
  }

  // ---------- recap: short "what's happening" for the panel ----------
  async recap() {
    this.panel.post({ type: "busy", on: true });
    try {
      if (!vscode.workspace.workspaceFolders || !vscode.workspace.workspaceFolders.length) {
        this.panel.post({ type: "chat", text: "I can't see a project yet — **File → Open Folder…** and pick the folder you're building in. Then I can watch what " + this.agentName + " writes there 🐾" });
        return;
      }
      if (!this.workspaceBrief) await this.buildWorkspaceBrief();
      const ctx = this.contextBlock();
      if (!ctx) { this.panel.post({ type: "chat", text: "Nothing to recap yet — build something (or run a simulated agent edit) and ask me again 🐾" }); return; }
      const reply = await hermesChat(this.context, [
        { role: "system", content: chatSystemPrompt(this.tone, ctx, this.agentName) },
        { role: "user", content: "Give me a SHORT session recap: in 3-5 tiny bullets (plain designer language, no jargon), what is being built/changed in this project right now and what each recent change does for the product. Keep the whole thing under 90 words." },
      ], "recap");
      this.panel.post({ type: "chat", text: reply });
    } catch (e) { this.fail(e); }
    finally { this.panel.post({ type: "busy", on: false }); }
  }

  // ---------- quiz: MCQs from what Pica taught + what got built ----------
  async startQuiz() {
    this.panel.post({ type: "busy", on: true });
    try {
      const material = [
        this.taughtConcepts.length ? "Concepts taught: " + this.taughtConcepts.join(" · ") : "",
        this.recentDiffs.length ? "Recent code:\n" + this.recentDiffs.map((d) => d.file + "\n" + d.lines.join("\n")).join("\n") : "",
      ].filter(Boolean).join("\n\n");
      if (!material) { this.panel.post({ type: "chat", text: "Let me teach you something first — then I'll quiz you on it 🐾" }); return; }
      const raw = await hermesChat(this.context, [
        { role: "system", content: [
          "You are Pica, a pixel cat quizzing a designer on code concepts they JUST learned. Make exactly 3 multiple-choice questions from the material — designer-friendly wording, about what the code DOES, not syntax trivia.",
          this.tone === "professor" ? "Tone: professor — precise, no emoji." : "Tone: friend — warm, playful.",
          'Respond with ONLY this JSON: {"questions":[{"q":"...","options":["a","b","c","d"],"answer":0,"why":"one-line reason"}]} — 4 options each, answer is the index 0-3, keep every string short.',
        ].join("\n") },
        { role: "user", content: material.slice(0, 4000) },
      ], "quiz");
      const parsed = parseJSONBlock(raw, "questions");
      const qs = parsed && Array.isArray(parsed.questions)
        ? parsed.questions.filter((q) => q && q.q && Array.isArray(q.options) && q.options.length >= 2 && Number.isInteger(q.answer)).slice(0, 3)
        : [];
      if (!qs.length) { this.panel.post({ type: "chat", text: "My quiz machine jammed — ask me again in a sec 🐾" }); return; }
      this.quiz = { questions: qs, i: 0, score: 0 };
      this.panel.post({ type: "quizQ", i: 0, total: qs.length, q: qs[0].q, options: qs[0].options });
    } catch (e) { this.fail(e); }
    finally { this.panel.post({ type: "busy", on: false }); }
  }

  quizPick(pick) {
    if (!this.quiz) return;
    const q = this.quiz.questions[this.quiz.i];
    const ok = pick === q.answer;
    if (ok) this.quiz.score++;
    this.quiz.i++;
    const done = this.quiz.i >= this.quiz.questions.length;
    this.panel.post({ type: "quizVerdict", ok, why: q.why || "", correct: q.options[q.answer], done, score: this.quiz.score, total: this.quiz.questions.length });
    if (!done) {
      const n = this.quiz.questions[this.quiz.i];
      this.panel.post({ type: "quizQ", i: this.quiz.i, total: this.quiz.questions.length, q: n.q, options: n.options });
    } else {
      this.quiz = null;
    }
  }

  // ---------- file practice: blank the REAL code in an editor tab ----------
  async startFilePractice() {
    this.panel.post({ type: "busy", on: true });
    try {
      // prefer the file Pica last taught about; fall back to the active editor
      let uri = null, rel = "";
      if (this.lesson && this.lesson.file && vscode.workspace.workspaceFolders) {
        uri = vscode.Uri.joinPath(vscode.workspace.workspaceFolders[0].uri, this.lesson.file);
        rel = this.lesson.file;
      }
      const ed = vscode.window.activeTextEditor;
      if (!uri && ed && !ed.document.isUntitled) { uri = ed.document.uri; rel = vscode.workspace.asRelativePath(uri); }
      if (!uri) { this.panel.post({ type: "chat", text: "Open a code file (or let me teach one first) and I'll blank it out for you 🐾" }); return; }
      let text;
      try { text = dec.decode(await vscode.workspace.fs.readFile(uri)); }
      catch (e) { this.panel.post({ type: "chat", text: "I couldn't read " + rel + " — open it and try again." }); return; }
      text = text.split("\n").slice(0, 200).join("\n");

      const raw = await hermesChat(this.context, [
        { role: "system", content: [
          "You pick practice blanks for a designer learning code. From the file below choose up to 3 short, MEANINGFUL tokens to blank out (a method like map, a hook, a key prop, a condition — things worth remembering; never punctuation or variable soup).",
          'Respond ONLY with JSON: {"blanks":[{"original":"<the EXACT full line copied verbatim from the file>","answer":"<the exact token within that line to hide>","hint":"<=8 words"}]}',
        ].join("\n") },
        { role: "user", content: "File: " + rel + "\n" + text.slice(0, 8000) },
      ], "practice");
      const parsed = parseJSONBlock(raw, "blanks");
      const blanks = [];
      if (parsed && Array.isArray(parsed.blanks)) {
        for (const b of parsed.blanks.slice(0, 3)) {
          if (!b || !b.original || !b.answer) continue;
          if (!text.includes(b.original) || !String(b.original).includes(String(b.answer))) continue;
          blanks.push({ original: String(b.original), answer: String(b.answer), hint: String(b.hint || "") });
        }
      }
      if (!blanks.length) { this.panel.post({ type: "chat", text: "Hmm, I couldn't find a good blank in " + rel + " — try after the agent writes a bit more 🐾" }); return; }

      let practiceText = text;
      blanks.forEach((b, i) => {
        const blankedLine = b.original.replace(b.answer, "____/*" + (i + 1) + "*/");
        practiceText = practiceText.replace(b.original, blankedLine);
      });
      const header = "// PICA PRACTICE — fill every ____/*n*/ blank, then hit “Check my answers” in the Pica panel.\n// (this is a copy — your real file is untouched)\n\n";
      const langExt = extOf(rel);
      const langMap = { js: "javascript", jsx: "javascriptreact", ts: "typescript", tsx: "typescriptreact", py: "python", rb: "ruby", go: "go", css: "css", html: "html" };
      const doc = await vscode.workspace.openTextDocument({ content: header + practiceText, language: langMap[langExt] || "plaintext" });
      await vscode.window.showTextDocument(doc, { preview: false, viewColumn: vscode.ViewColumn.One });
      this.fp = { docUri: doc.uri.toString(), file: rel, blanks };
      this.panel.post({ type: "fpReady", file: rel, count: blanks.length, hints: blanks.map((b) => b.hint) });
    } catch (e) { this.fail(e); }
    finally { this.panel.post({ type: "busy", on: false }); }
  }

  checkFilePractice() {
    if (!this.fp) { this.panel.post({ type: "chat", text: "No practice file open right now — hit “Blank the file” first 🐾" }); return; }
    const doc = vscode.workspace.textDocuments.find((d) => d.uri.toString() === this.fp.docUri);
    if (!doc) { this.panel.post({ type: "chat", text: "I lost the practice tab — start a fresh one 🐾" }); this.fp = null; return; }
    const now = normAnswer(doc.getText());
    const items = this.fp.blanks.map((b) => ({ ok: now.includes(normAnswer(b.original)), answer: b.answer, hint: b.hint }));
    const score = items.filter((x) => x.ok).length;
    this.panel.post({ type: "fpResult", items, score, total: items.length, file: this.fp.file });
    if (score === items.length) this.fp = null;   // all done — clean slate
  }

  // ---------- image picker (file dialog → data URL to the panel) ----------
  async pickImage() {
    const picks = await vscode.window.showOpenDialog({
      canSelectMany: false, openLabel: "Attach to Pica",
      filters: { Images: ["png", "jpg", "jpeg", "gif", "webp"] },
    });
    if (!picks || !picks.length) return;
    try {
      const bytes = await vscode.workspace.fs.readFile(picks[0]);
      const ext = extOf(picks[0].fsPath);
      const mime = ext === "jpg" ? "jpeg" : ext;
      const b64 = Buffer.from(bytes).toString("base64");
      this.panel.post({ type: "pickedImage", data: "data:image/" + mime + ";base64," + b64 });
    } catch (e) { this.panel.post({ type: "error", text: "Couldn't read that image." }); }
  }

  // ---------- free chat (with optional attached image) ----------
  async answer(text, image) {
    if (!text.trim() && !image) return;
    this.panel.post({ type: "busy", on: true });
    try {
      let reply;
      if (image) {
        // Route screenshots to a vision-capable model — chosen per provider (OpenRouter's
        // default text model can't see, so hermesChat swaps in a vision model automatically).
        const q = text.trim() || "What's happening in this screenshot? Explain it to me like a designer — in plain words, no jargon. If it's an error or some code, tell me what it means and the one idea to fix it.";
        reply = await hermesChat(this.context, [
          { role: "system", content: chatSystemPrompt(this.tone, this.contextBlock(), this.agentName) },
          { role: "user", content: [
            { type: "text", text: q },
            { type: "image_url", image_url: { url: image } },
          ] },
        ], "vision", { vision: true });
        this.chatHistory.push({ role: "user", content: "[shared a screenshot] " + text });
      } else {
        this.chatHistory.push({ role: "user", content: text });
        this.chatHistory = this.chatHistory.slice(-8);
        reply = await hermesChat(this.context, [
          { role: "system", content: chatSystemPrompt(this.tone, this.contextBlock(), this.agentName) },
          ...this.chatHistory,
        ], "chat");
      }
      this.chatHistory.push({ role: "assistant", content: reply });
      this.chatHistory = this.chatHistory.slice(-8);
      this.panel.post({ type: "chat", text: reply });
    } catch (e) { this.fail(e); }
    finally { this.panel.post({ type: "busy", on: false }); }
  }
}

// ---------------------------------------------------------------------
// ARCADE — Game Mode tab: progress on top, hearts as lives, game scene
// above, question below. Games picked at random from what's built.
// ---------------------------------------------------------------------
const BUILT_GAMES = ["bugzap", "pixelbuilder", "snake"];
const GAME_NAMES = { bugzap: "Bug Zapper", pixelbuilder: "Pixel Builder", snake: "Byte Snake" };

class Arcade {
  constructor(context, engine) { this.context = context; this.engine = engine; this.panel = null; }

  async start(mode) {
    const eng = this.engine;
    if (!eng.lesson) { eng.panel.post({ type: "chat", text: "Let me teach you something first — then we play 🐾 (build something, or run a simulated agent edit)" }); return; }
    eng.panel.post({ type: "busy", on: true });
    let questions = [];
    try {
      questions = await this.generateQuestions(mode);
    } catch (e) { eng.panel.post({ type: "busy", on: false }); return eng.fail(e); }
    eng.panel.post({ type: "busy", on: false });
    if (questions.length < 3) { eng.panel.post({ type: "chat", text: "My question machine jammed — try again in a sec 🐾" }); return; }

    // demo opener: first 2 rounds are always Byte Snake, then shuffle (no-repeat).
    const played = this.context.globalState.get("pica.gamesPlayed", 0);
    let gameId;
    if (played < 2 && BUILT_GAMES.includes("snake")) {
      gameId = "snake";
    } else {
      const last = this.context.globalState.get("pica.lastGame", "");
      const pool = BUILT_GAMES.length > 1 ? BUILT_GAMES.filter((g) => g !== last) : BUILT_GAMES;
      gameId = pool[Math.floor(Math.random() * pool.length)];
    }
    this.context.globalState.update("pica.lastGame", gameId);
    this.context.globalState.update("pica.gamesPlayed", played + 1);
    this.lastMode = mode;
    eng.panel.post({ type: "chat", text: "🎲 " + (played < 2 ? "Starting with" : "Rolled") + ": **" + (GAME_NAMES[gameId] || gameId) + "**! Good luck 🐾" });
    const hiscores = this.context.globalState.get("pica.hiscores", {});
    const payload = {
      game: gameId, mode,
      concept: (eng.lesson && eng.lesson.concept) || "",
      questions: questions.slice(0, 5),
      hiscore: hiscores[gameId] || 0,
    };

    if (this.panel) { try { this.panel.dispose(); } catch (e) { /* already gone */ } }
    this.panel = vscode.window.createWebviewPanel("picaArcade", "Pica — Game Mode", vscode.ViewColumn.One, {
      enableScripts: true, retainContextWhenHidden: true,
      localResourceRoots: [vscode.Uri.joinPath(this.context.extensionUri, "media")],
    });
    this.panel.webview.html = this.html(this.panel.webview, payload);
    this.panel.onDidDispose(() => { this.panel = null; });
    this.panel.webview.onDidReceiveMessage((m) => {
      if (m.type === "done") {
        const hs = this.context.globalState.get("pica.hiscores", {});
        if ((m.score || 0) > (hs[m.game] || 0)) { hs[m.game] = m.score; this.context.globalState.update("pica.hiscores", hs); }
        logEvent(this.context, "game", 0);
        eng.panel.post({ type: "chat", text: "🎮 **" + (GAME_NAMES[m.game] || m.game) + "**: " + m.score + " pts · " + m.correct + "/" + m.total + " right · best combo ×" + Math.max(m.bestCombo, 1) + (m.won ? ". That concept is settling in 🐾" : ". Tough round — rematch anytime 🐾") });
      }
      if (m.type === "again") {
        this.start(this.lastMode || "mcq");   // fresh questions, fresh dice roll
      }
      if (m.type === "back") {
        if (this.panel) this.panel.dispose();
        vscode.commands.executeCommand("workbench.view.extension.pica");
      }
    });
  }

  async generateQuestions(mode) {
    const eng = this.engine;
    const material = [
      "Lesson just taught — concept: " + (eng.lesson.concept || "") + "\nExplanation: " + (eng.lesson.explanation || ""),
      eng.recentDiffs.length ? "Recent code from THEIR project:\n" + eng.recentDiffs.map((d) => d.file + "\n" + d.lines.join("\n")).join("\n") : "",
    ].filter(Boolean).join("\n\n").slice(0, 4000);
    const spec = mode === "code"
      ? 'Each question: {"type":"code","prompt":"one-line instruction","display":"1-2 REAL code lines from the material with ONE key token replaced by ____","answer":"the exact missing token","why":"one-line reason"}. The answer must be short and typeable.'
      : 'Each question: {"type":"mcq","q":"designer-friendly question about what the code DOES","options":["a","b","c","d"],"answer":0,"why":"one-line reason"}. Exactly 4 options, answer is the index 0-3.';
    const raw = await hermesChat(this.context, [
      { role: "system", content: [
        "You are Pica, generating a 5-question game round for a designer who just learned a coding concept. Questions must be about the material below — what the code does for the product, never syntax trivia. Ramp difficulty: Q1 easiest, Q5 hardest. Keep every string short.",
        spec,
        'Respond with ONLY this JSON, no fences: {"questions":[ ...exactly 5... ]}',
      ].join("\n") },
      { role: "user", content: material },
    ], "game");
    const parsed = parseJSONBlock(raw, "questions");
    const out = [];
    if (parsed && Array.isArray(parsed.questions)) {
      for (const q of parsed.questions) {
        if (!q) continue;
        if (q.type === "mcq" && q.q && Array.isArray(q.options) && q.options.length === 4 && Number.isInteger(q.answer) && q.answer >= 0 && q.answer < 4) out.push(q);
        else if (q.type === "code" && q.display && q.answer && String(q.display).includes("____")) out.push(q);
      }
    }
    return out;
  }

  html(wv, payload) {
    const uri = (f) => wv.asWebviewUri(vscode.Uri.joinPath(this.context.extensionUri, "media", f));
    const nonce = Math.random().toString(36).slice(2);
    const data = JSON.stringify(payload).replace(/</g, "\\u003c");
    return `<!doctype html><html><head><meta charset="utf-8"/>
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src ${wv.cspSource} data:; style-src ${wv.cspSource} 'unsafe-inline' https://fonts.googleapis.com; font-src https://fonts.gstatic.com; script-src 'nonce-${nonce}';"/>
<link href="https://fonts.googleapis.com/css2?family=Pixelify+Sans:wght@700&family=JetBrains+Mono:wght@400;500&display=swap" rel="stylesheet"/>
<link href="${uri("arcade.css")}" rel="stylesheet"/>
</head><body>
<div class="stage">
  <div class="hud">
    <span class="hud__title" id="hud-title">GAME MODE</span>
    <div class="progress" id="progress"></div>
    <div class="hearts" id="hearts"></div>
    <span class="score-pill" id="score">0 pts</span>
  </div>
  <div class="scene">
    <canvas id="scene-canvas" width="720" height="235"></canvas>
    <span class="scene__label" id="scene-label"></span>
    <span class="combo-pop" id="combo-pop"></span>
  </div>
  <div class="hud" style="justify-content:flex-start"><span class="scene__label" style="position:static" id="concept"></span></div>
  <div class="qwrap"><div class="qcard" id="qcard"></div></div>
</div>
<div class="overlay" id="overlay"><div class="endcard">
  <img id="endcat" src="${uri("cat-cheer.webp")}" width="88" height="88" style="image-rendering:pixelated"/>
  <div class="endcard__title">GREAT JOB!</div>
  <div class="endcard__score">0</div>
  <div class="endcard__hi"></div>
  <div class="endcard__stats"><span id="st-correct"></span><span id="st-combo"></span></div>
  <div style="display:flex;gap:10px;justify-content:center">
    <button class="btn" id="again">🎲 Play again</button>
    <button class="btn" id="back" style="background:var(--paper)">Back to Pica 🐾</button>
  </div>
</div></div>
<script nonce="${nonce}">window.PICA_ROUND=${data};window.PICA_CATS={idle:"${uri("cat-idle.webp")}",cheer:"${uri("cat-cheer.webp")}",encourage:"${uri("cat-encourage.webp")}"};</script>
<script nonce="${nonce}" src="${uri("arcade.js")}"></script>
</body></html>`;
  }
}

// ---------------------------------------------------------------------
// Simulate a Hermes edit — writes a realistic change into the workspace
// so the full loop can be demoed without the live agent.
// ---------------------------------------------------------------------
const SIM_V1 = `import { useFeed } from "./useFeed";

export function Feed() {
  const posts = useFeed();
  return (
    <ul className="feed">
      {posts.map(p => <li key={p.id}>{p.title}</li>)}
    </ul>
  );
}
`;
const SIM_V2 = `import { useFeed } from "./useFeed";
import { Spinner } from "./Spinner";

export function Feed() {
  const posts = useFeed();
  if (!posts) return <Spinner />;
  return (
    <ul className="feed">
      {posts.map(p => <li key={p.id}>{p.title}</li>)}
    </ul>
  );
}
`;
async function simulateHermes() {
  const folders = vscode.workspace.workspaceFolders;
  if (!folders || !folders.length) {
    vscode.window.showWarningMessage("Pica: open a folder first, then simulate an agent edit.");
    return;
  }
  const target = vscode.Uri.joinPath(folders[0].uri, "Feed.jsx");
  let next = SIM_V1;
  try {
    const existing = dec.decode(await vscode.workspace.fs.readFile(target));
    next = existing.includes("Spinner") ? SIM_V1 : SIM_V2;   // alternate so replays keep working
  } catch (e) { /* file doesn't exist yet -> V1 */ }
  await vscode.workspace.fs.writeFile(target, enc.encode(next));
  const doc = await vscode.workspace.openTextDocument(target);
  await vscode.window.showTextDocument(doc, { preview: false, viewColumn: vscode.ViewColumn.One });
}

// ---------------------------------------------------------------------
// activate
// ---------------------------------------------------------------------
function activate(context) {
  const panel = new PicaPanel(context, null);
  const engine = new Engine(context, panel);
  panel.engine = engine;
  engine.arcade = new Arcade(context, engine);

  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider("pica.panel", panel, { webviewOptions: { retainContextWhenHidden: true } }),
    vscode.commands.registerCommand("pica.open", () => vscode.commands.executeCommand("workbench.view.extension.pica")),
    vscode.commands.registerCommand("pica.simulateHermes", simulateHermes),
    vscode.commands.registerCommand("pica.practiceFile", () => engine.startFilePractice()),
    vscode.commands.registerCommand("pica.resetArcade", () => {
      context.globalState.update("pica.gamesPlayed", 0);
      context.globalState.update("pica.lastGame", "");
      vscode.window.showInformationMessage("Pica: arcade reset — next round starts with Byte Snake 🐍");
    }),
    vscode.commands.registerCommand("pica.setAgent", async () => {
      const items = [
        { label: "$(sparkle) Auto-detect", description: "figure it out from the workspace", agent: "" },
        { label: "Claude Code", agent: "Claude Code" },
        { label: "Cursor", agent: "Cursor" },
        { label: "Hermes", agent: "Hermes" },
        { label: "Codex CLI", agent: "Codex CLI" },
        { label: "Aider", agent: "Aider" },
        { label: "GitHub Copilot", agent: "GitHub Copilot" },
        { label: "$(edit) Other…", description: "type the agent's name", agent: "__custom__" },
      ];
      const pick = await vscode.window.showQuickPick(items, { placeHolder: "Which coding agent should Pica narrate?" });
      if (!pick) return;
      let agent = pick.agent;
      if (agent === "__custom__") {
        agent = await vscode.window.showInputBox({ prompt: "Your coding agent's name (e.g. Claude Code)", ignoreFocusOut: true });
        if (agent === undefined) return;
      }
      await vscode.workspace.getConfiguration("pica").update("agentName", (agent || "").trim(), vscode.ConfigurationTarget.Global);
      vscode.window.showInformationMessage(agent && agent.trim() ? "Pica now rides along with " + agent.trim() + " 🐾" : "Pica will auto-detect your coding agent 🐾");
      engine.sendInit();
    }),
    vscode.commands.registerCommand("pica.chooseModel", async () => {
      const items = [
        { label: "Hermes 4 70B", description: "OpenRouter key · nousresearch/hermes-4-70b · pay-per-use", model: "nousresearch/hermes-4-70b" },
        { label: "Hermes 3 405B (free)", description: "OpenRouter key · nousresearch/hermes-3-llama-3.1-405b:free", model: "nousresearch/hermes-3-llama-3.1-405b:free" },
        { label: "Qwen3 Coder (free)", description: "OpenRouter key · qwen/qwen3-coder:free · great for code", model: "qwen/qwen3-coder:free" },
        { label: "Llama 3.3 70B (free)", description: "OpenRouter key · meta-llama/llama-3.3-70b-instruct:free", model: "meta-llama/llama-3.3-70b-instruct:free" },
        { label: "Gemini 2.0 Flash", description: "Google Gemini key · gemini-2.0-flash · generous free tier", model: "gemini-2.0-flash" },
        { label: "Claude Haiku 4.5", description: "Anthropic key · claude-haiku-4-5 · fast & affordable", model: "claude-haiku-4-5" },
        { label: "Claude Sonnet 5", description: "Anthropic key · claude-sonnet-5 · balanced, near-Opus quality", model: "claude-sonnet-5" },
        { label: "Claude Opus 4.8", description: "Anthropic key · claude-opus-4-8 · most capable", model: "claude-opus-4-8" },
        { label: "GPT-4o mini", description: "OpenAI key · gpt-4o-mini · cheap & fast", model: "gpt-4o-mini" },
        { label: "$(edit) Custom…", description: "type any model id for your provider", model: "__custom__" },
      ];
      const pick = await vscode.window.showQuickPick(items, { placeHolder: "Pick a model (match it to your key: OpenRouter / Gemini / Claude / OpenAI)" });
      if (!pick) return;
      let model = pick.model;
      if (model === "__custom__") {
        model = await vscode.window.showInputBox({ prompt: "Model id — OpenRouter (author/model), Gemini (gemini-…), Claude (claude-…), or OpenAI (gpt-…)", ignoreFocusOut: true });
        if (!model) return;
      }
      await vscode.workspace.getConfiguration("pica").update("model", model.trim(), vscode.ConfigurationTarget.Global);
      vscode.window.showInformationMessage("Pica now runs on " + model.trim() + " 🐾");
    }),
    vscode.commands.registerCommand("pica.setEmail", async () => {
      const email = await vscode.window.showInputBox({ prompt: "The email you signed up with at pica-landing.vercel.app", ignoreFocusOut: true });
      if (email && email.trim()) {
        if (await verifyEmail(email.trim().toLowerCase())) {
          await context.globalState.update("pica.email", email.trim().toLowerCase());
          vscode.window.showInformationMessage("Pica: welcome back 🐾");
        } else {
          vscode.window.showWarningMessage("Pica: that email isn't on the list — sign up at pica-landing.vercel.app first.");
        }
        engine.sendInit();
      }
    }),
    vscode.commands.registerCommand("pica.setApiKey", async () => {
      const key = await vscode.window.showInputBox({ prompt: "Paste your API key — OpenRouter (sk-or-…), Gemini (AIza…), Anthropic/Claude (sk-ant-…), or OpenAI (sk-…)", password: true, ignoreFocusOut: true });
      if (key && key.trim()) {
        await context.secrets.store("pica.nousKey", key.trim());
        vscode.window.showInformationMessage("Pica: key saved 🐾");
        engine.sendInit();
      }
    })
  );
}
function deactivate() {}
module.exports = { activate, deactivate };
