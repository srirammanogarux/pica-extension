/* PICA panel logic — talks to extension host via postMessage */
(function () {
  const vscode = acquireVsCodeApi();
  const thread = document.getElementById("thread");
  const status = document.getElementById("status");
  const askInp = document.getElementById("ask");
  const sendBt = document.getElementById("send");
  const AV = '<img class="av" src="' + window.PICA_SPRITE + '"/>';

  let state = { hasKey: false, allowed: false, tone: "friend", hasWorkspace: true, portal: "#" };
  let typingEl = null;

  // ---------- helpers ----------
  function scroll() { thread.scrollTop = thread.scrollHeight; }
  function el(html) { const d = document.createElement("div"); d.innerHTML = html; return d.firstElementChild; }
  function pica(html) { const n = el('<div class="msg">' + AV + '<div class="tx">' + html + "</div></div>"); thread.appendChild(n); scroll(); return n; }
  function sys(text) { const n = el('<div class="msg msg--sys"></div>'); n.textContent = text; thread.appendChild(n); scroll(); return n; }
  function err(text) { const n = el('<div class="msg msg--err"><div class="tx"></div></div>'); n.querySelector(".tx").textContent = text; thread.appendChild(n); scroll(); return n; }
  function codeBlock(text) { const n = el('<div class="msg msg--code"></div>'); n.innerHTML = escapeHtml(text).replace(/____/g, '<span class="blank">____</span>'); thread.appendChild(n); scroll(); return n; }
  function action(label, ghost) { const b = el('<button class="act' + (ghost ? " act--ghost" : "") + '"></button>'); b.textContent = label; thread.appendChild(b); scroll(); return b; }
  function typing(on) {
    if (on && !typingEl) { typingEl = el('<div class="typing"><i></i><i></i><i></i></div>'); thread.appendChild(typingEl); scroll(); }
    if (!on && typingEl) { typingEl.remove(); typingEl = null; }
  }
  function escapeHtml(s) { return String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;"); }
  function md(s) { // tiny formatter: **bold**, `code`
    return escapeHtml(s).replace(/\*\*(.+?)\*\*/g, "<strong>$1</strong>").replace(/`([^`]+)`/g, "<code>$1</code>");
  }
  function setStatus(t) { status.textContent = t; }
  function markTone() {
    document.querySelectorAll(".tone").forEach(function (b) { b.classList.toggle("on", b.dataset.tone === state.tone); });
  }

  // ---------- states ----------
  function showNeedKey() {
    setStatus("needs a key");
    pica("Hey — I'm <strong>Pica</strong> 🐾 I explain the code Hermes writes, in your words. First I need your <strong>Hermes key</strong> so I can think.");
    const wrap = el('<div class="msg" style="display:block"><input class="inp" id="keyin" type="password" placeholder="paste your Nous portal key…"/><div style="height:6px"></div><a class="k-link" href="' + state.portal + '">get it free → portal.nousresearch.com</a></div>');
    thread.appendChild(wrap);
    const saveB = action("Save key");
    const inp = wrap.querySelector("#keyin");
    function save() { if (inp.value.trim()) vscode.postMessage({ type: "saveKey", key: inp.value }); }
    saveB.addEventListener("click", save);
    inp.addEventListener("keydown", function (e) { if (e.key === "Enter") save(); });
    scroll();
  }

  function showZero() {
    setStatus("ready");
    pica("Purrfect. I'll ride along while <strong>Hermes</strong> writes your code — when it does something worth knowing, I'll pipe up and teach it in plain designer. Mind if I watch?");
    if (!state.hasWorkspace) sys("open a folder first so I have something to watch");
    const allow = action("Allow Pica to watch");
    allow.addEventListener("click", function () {
      allow.remove();
      vscode.postMessage({ type: "allow" });
      pica("On it. I'll stay quiet until something's worth your time. Go build 👀");
      sys("tip: run “Pica: Simulate a Hermes Edit” to see me in action");
      setStatus("watching your code");
    });
  }

  // ---------- message handling ----------
  window.addEventListener("message", function (ev) {
    const m = ev.data;
    switch (m.type) {
      case "init": {
        state = m.state; markTone();
        thread.innerHTML = "";
        if (!state.hasKey) return showNeedKey();
        if (!state.allowed) return showZero();
        setStatus("watching your code");
        pica("Back on duty 🐾 I'm watching what Hermes writes. Ask me anything, anytime.");
        sys("run “Pica: Simulate a Hermes Edit” to demo the loop");
        return;
      }
      case "needKey": thread.innerHTML = ""; return showNeedKey();
      case "status": setStatus(m.text); return;
      case "busy": typing(!!m.on); return;
      case "error": typing(false); err(m.text); return;
      case "spotted": {
        sys("👀 Hermes touched " + m.file);
        typing(true);
        return;
      }
      case "spotfail": typing(false); return;
      case "moment": {
        typing(false);
        pica(md(m.data.teaser));
        const b = action("Yes — explain it");
        b.addEventListener("click", function () { b.remove(); vscode.postMessage({ type: "explain" }); });
        return;
      }
      case "lesson": {
        if (!m.data) return;
        pica(md(m.data.explanation));
        if (m.data.concept) pica("<strong>Concept:</strong> " + md(m.data.concept));
        if (m.data.practice && m.data.practice.display && m.data.practice.answer) {
          const p = action("Let me try it ✍️");
          p.addEventListener("click", function () {
            p.remove();
            pica(md(m.data.practice.prompt || "Fill in the blank:"));
            codeBlock(m.data.practice.display);
            const wrap = el('<div class="msg" style="display:block"><input class="inp" id="prin" placeholder="type the missing bit…" autocomplete="off"/></div>');
            thread.appendChild(wrap);
            const inp = wrap.querySelector("#prin");
            const go = action("Check");
            function submit() { if (inp.value.trim()) { go.remove(); vscode.postMessage({ type: "practiceSubmit", answer: inp.value }); } }
            go.addEventListener("click", submit);
            inp.addEventListener("keydown", function (e) { if (e.key === "Enter") submit(); });
            inp.focus(); scroll();
          });
        }
        return;
      }
      case "practiceResult": {
        pica(m.ok
          ? "✓ <strong>" + escapeHtml(m.answer) + "</strong> — nailed it. You just wrote the line Hermes would've. " + (m.concept ? "<strong>Unlocked:</strong> " + md(m.concept) : "")
          : "Close! It's <strong>" + escapeHtml(m.answer) + "</strong>. You'll get the next one 🐾 " + (m.concept ? "<strong>Concept:</strong> " + md(m.concept) : ""));
        return;
      }
      case "chat": { typing(false); pica(md(m.text)); return; }
    }
  });

  // ---------- composer + tone ----------
  function ask() {
    const t = askInp.value.trim();
    if (!t) return;
    const me = el('<div class="msg" style="align-self:flex-end;background:var(--orange-lt)"><div class="tx"></div></div>');
    me.querySelector(".tx").textContent = t;
    thread.appendChild(me); scroll();
    askInp.value = "";
    typing(true);
    vscode.postMessage({ type: "ask", text: t });
  }
  sendBt.addEventListener("click", ask);
  askInp.addEventListener("keydown", function (e) { if (e.key === "Enter") ask(); });
  document.querySelectorAll(".tone").forEach(function (b) {
    b.addEventListener("click", function () {
      state.tone = b.dataset.tone; markTone();
      vscode.postMessage({ type: "tone", tone: state.tone });
      sys("tone set: " + (state.tone === "professor" ? "professor 🎓" : "friend 🐾"));
    });
  });

  vscode.postMessage({ type: "ready" });
})();
