/* =====================================================================
   PICA — VS Code / Cursor extension
   A pixel cat that rides along with the Hermes agent: watches the code it
   writes into your workspace, explains it in designer language, then makes
   you type the key line yourself.

   Explanations are powered by Hermes too — the Nous inference API
   (OpenAI-compatible). Key comes from portal.nousresearch.com.
   ===================================================================== */
const vscode = require("vscode");

const CONFIG = {
  API_BASE: "https://inference-api.nousresearch.com/v1",
  DEFAULT_MODEL: "nousresearch/hermes-4-70b",
  DEBOUNCE_MS: 1400,     // let an agent write-burst settle before teaching
  COOLDOWN_MS: 15000,    // min gap between proactive teach moments
  MAX_FILE_BYTES: 200 * 1024,
  MAX_SNAPSHOT_FILES: 400,
  CODE_EXTS: ["js","jsx","ts","tsx","py","html","css","scss","vue","svelte","go","rb","java","c","cpp","h","swift","kt","php","rs","sql","sh"],
  IGNORE_SEGMENTS: ["node_modules",".git","dist","build","out",".next",".venv","venv","__pycache__",".vercel","coverage",".idea"],
  PORTAL_URL: "https://portal.nousresearch.com",
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
// Hermes (Nous) API
// ---------------------------------------------------------------------
async function hermesChat(context, messages) {
  const key = await context.secrets.get("pica.nousKey");
  if (!key) throw new Error("NO_KEY");
  const model = vscode.workspace.getConfiguration("pica").get("model") || CONFIG.DEFAULT_MODEL;
  const res = await fetch(CONFIG.API_BASE + "/chat/completions", {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: "Bearer " + key },
    body: JSON.stringify({ model, messages, temperature: 0.6, max_tokens: 900 }),
  });
  if (res.status === 401 || res.status === 403) throw new Error("BAD_KEY");
  if (!res.ok) throw new Error("API_" + res.status + " " + (await res.text()).slice(0, 200));
  const data = await res.json();
  const text = data && data.choices && data.choices[0] && data.choices[0].message
    ? (data.choices[0].message.content || "") : "";
  if (!text) throw new Error("EMPTY_REPLY");
  return text.trim();
}

function parseLessonJSON(text) {
  // tolerate ```json fences and stray prose around the object
  let t = text.replace(/```json/gi, "```").replace(/```/g, "").trim();
  const a = t.indexOf("{"), b = t.lastIndexOf("}");
  if (a !== -1 && b > a) t = t.slice(a, b + 1);
  try {
    const j = JSON.parse(t);
    if (j && j.explanation) return j;
  } catch (e) { /* fall through */ }
  return null;
}

function teachSystemPrompt(tone) {
  const voice = tone === "professor"
    ? "TONE: professor — precise, calm, structured. Still zero jargon without an instant plain-words translation. No emoji."
    : "TONE: friend — warm, playful, encouraging. A single 🐾 is welcome when it fits.";
  return [
    "You are Pica, a pixel-art cat living in a code editor. You teach DESIGNERS the code their AI agent (Hermes) just wrote. The reader is a smart product/UX designer who ships software but cannot read code yet.",
    voice,
    "You will be given a code change (filename + the lines that were added or changed). Pick the ONE most teachable thing in it and respond with ONLY this JSON (no markdown fences, no prose outside it):",
    '{"teaser":"one-line hook question, max 90 chars, about the specific thing (e.g. \'Hermes just added a loop that draws your whole list — want the 20-second version?\')",',
    '"explanation":"2-4 short sentences in designer language. Analogies from design/everyday life. Explain what it DOES for the product, not syntax trivia.",',
    '"concept":"Name the single concept in <=12 words, e.g. \'Mapping a list — one row of data in, one piece of UI out.\'",',
    '"practice":{"prompt":"one-line fill-in-the-blank instruction","display":"1-3 lines of the REAL code from the diff with the key token replaced by ____","answer":"the exact missing token"}}',
    "Keep every string short. The practice answer must be a single short token or expression the user can type.",
  ].join("\n");
}

function chatSystemPrompt(tone, lastDiff) {
  const voice = tone === "professor"
    ? "Tone: professor — precise, calm, jargon-free."
    : "Tone: friend — warm, playful, a 🐾 when it fits.";
  return [
    "You are Pica, a pixel-art cat in a code editor, teaching a designer who cannot read code yet. Answer their question in designer language: plain words, design-world analogies, 2-5 short sentences max. Never a wall of text. Never condescend.",
    voice,
    lastDiff ? "Context — the most recent code change in their project (they may ask about it):\n" + lastDiff : "",
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
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src ${wv.cspSource}; style-src ${wv.cspSource} 'unsafe-inline' https://fonts.googleapis.com; font-src https://fonts.gstatic.com; script-src 'nonce-${nonce}';"/>
<link href="https://fonts.googleapis.com/css2?family=Pixelify+Sans:wght@700&family=JetBrains+Mono:wght@400;500&display=swap" rel="stylesheet"/>
<link href="${uri("panel.css")}" rel="stylesheet"/>
</head><body>
<header class="head">
  <img class="sprite" src="${uri("pica.png")}" width="26" height="26"/>
  <div class="head__t"><strong>Pica</strong><span id="status">waking up…</span></div>
  <div class="tones" id="tones" title="Teaching tone">
    <button data-tone="friend" class="tone">Friend</button>
    <button data-tone="professor" class="tone">Prof</button>
  </div>
</header>
<main id="thread"></main>
<footer class="composer">
  <input id="ask" type="text" placeholder="Ask Pica anything…" autocomplete="off"/>
  <button id="send">➤</button>
</footer>
<script nonce="${nonce}">window.PICA_SPRITE="${uri("pica.png")}";</script>
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
    this.chatHistory = [];
    this.watcher = null;
  }

  get tone() { return this.context.globalState.get("pica.tone", "friend"); }
  set tone(v) { this.context.globalState.update("pica.tone", v); }
  get allowed() { return this.context.workspaceState.get("pica.allowed", false); }
  set allowed(v) { this.context.workspaceState.update("pica.allowed", v); }

  async hasKey() { return !!(await this.context.secrets.get("pica.nousKey")); }

  // ---------- panel protocol ----------
  async onPanelMessage(m) {
    try {
      switch (m.type) {
        case "ready":     return this.sendInit();
        case "saveKey": {
          const key = String(m.key || "").trim();
          if (key.length < 8) return this.panel.post({ type: "error", text: "That key looks too short — paste the whole thing." });
          await this.context.secrets.store("pica.nousKey", key);
          return this.sendInit();
        }
        case "tone":      this.tone = m.tone === "professor" ? "professor" : "friend"; return;
        case "allow":     this.allowed = true; this.startWatching(); return this.sendInit();
        case "explain":   return this.panel.post({ type: "lesson", data: this.lesson || null });
        case "practiceSubmit": return this.checkPractice(m.answer);
        case "ask":       return this.answer(String(m.text || ""));
        case "simulate":  return vscode.commands.executeCommand("pica.simulateHermes");
      }
    } catch (e) { this.fail(e); }
  }

  async sendInit() {
    this.panel.post({
      type: "init",
      state: {
        hasKey: await this.hasKey(),
        allowed: this.allowed,
        tone: this.tone,
        hasWorkspace: !!(vscode.workspace.workspaceFolders && vscode.workspace.workspaceFolders.length),
        portal: CONFIG.PORTAL_URL,
      },
    });
    if (this.allowed && (await this.hasKey())) this.startWatching();
  }

  fail(e) {
    const msg = String((e && e.message) || e);
    if (msg === "NO_KEY")  return this.panel.post({ type: "needKey" });
    if (msg === "BAD_KEY") return this.panel.post({ type: "error", text: "That key didn't work (401). Grab it from portal.nousresearch.com and paste it again via “Pica: Set Hermes (Nous) API Key”." });
    this.panel.post({ type: "error", text: "Hermes hiccupped: " + msg.slice(0, 140) });
  }

  // ---------- watching ----------
  async startWatching() {
    if (this.watcher || !vscode.workspace.workspaceFolders) return;
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
    this.panel.post({ type: "status", text: "watching your code", agent: "● Hermes · connected" });
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

    this.panel.post({ type: "spotted", file: rel });
    let lesson = null;
    try {
      const raw = await hermesChat(this.context, [
        { role: "system", content: teachSystemPrompt(this.tone) },
        { role: "user", content: diffText },
      ]);
      lesson = parseLessonJSON(raw);
      if (!lesson) lesson = { teaser: "Hermes just wrote something worth knowing — want the short version?", explanation: raw.slice(0, 600), concept: "", practice: null };
    } catch (e) { this.panel.post({ type: "spotfail" }); return this.fail(e); }
    lesson.file = rel;
    this.lesson = lesson;
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
  }

  // ---------- free chat ----------
  async answer(text) {
    if (!text.trim()) return;
    this.panel.post({ type: "busy", on: true });
    try {
      this.chatHistory.push({ role: "user", content: text });
      this.chatHistory = this.chatHistory.slice(-8);
      const reply = await hermesChat(this.context, [
        { role: "system", content: chatSystemPrompt(this.tone, this.lastDiffText) },
        ...this.chatHistory,
      ]);
      this.chatHistory.push({ role: "assistant", content: reply });
      this.panel.post({ type: "chat", text: reply });
    } catch (e) { this.fail(e); }
    finally { this.panel.post({ type: "busy", on: false }); }
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
    vscode.window.showWarningMessage("Pica: open a folder first, then simulate a Hermes edit.");
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

  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider("pica.panel", panel, { webviewOptions: { retainContextWhenHidden: true } }),
    vscode.commands.registerCommand("pica.open", () => vscode.commands.executeCommand("workbench.view.extension.pica")),
    vscode.commands.registerCommand("pica.simulateHermes", simulateHermes),
    vscode.commands.registerCommand("pica.setApiKey", async () => {
      const key = await vscode.window.showInputBox({ prompt: "Paste your Nous portal API key (portal.nousresearch.com)", password: true, ignoreFocusOut: true });
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
