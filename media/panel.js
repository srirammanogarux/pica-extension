/* PICA panel logic — talks to extension host via postMessage */
(function () {
  const vscode = acquireVsCodeApi();
  const thread = document.getElementById("thread");
  const status = document.getElementById("status");
  const askInp = document.getElementById("ask");
  const sendBt = document.getElementById("send");
  const AV = '<img class="av" src="' + window.PICA_SPRITE + '"/>';

  let state = { hasEmail: false, hasKey: false, email: "", allowed: false, tone: "friend", hasWorkspace: true, landing: "#", agent: "your agent" };
  let typingEl = null;
  function agentName() { return (state && state.agent) || "your agent"; }

  // animated header cat — idle by default, thinks while busy, cheers on a win
  const CATS = window.PICA_CATS || {};
  const headcat = document.getElementById("headcat");
  let cheerTimer = null;
  function setCat(kind) { if (headcat && CATS[kind]) headcat.src = CATS[kind]; }
  function cheer(ms) {
    if (!headcat) return;
    clearTimeout(cheerTimer); setCat("cheer");
    cheerTimer = setTimeout(function () { setCat("idle"); cheerTimer = null; }, ms || 2600);
  }

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
    setStatus("step 2 of 2 — your key");
    pica("Almost in 🐾 Last step: paste <strong>your own API key</strong> — <strong>OpenRouter</strong>, <strong>Google Gemini</strong>, <strong>Anthropic (Claude)</strong>, or <strong>OpenAI</strong>. It powers my brain, gets stored <strong>only on this machine</strong>, and your usage bills to you — never to anyone else.");
    const wrap = el('<div class="msg" style="display:block"><input class="inp" id="keyin" type="password" placeholder="sk-or-…  ·  AIza…  ·  sk-ant-…  ·  sk-…"/><div style="height:6px"></div><a class="k-link" href="https://openrouter.ai/keys">OpenRouter →</a> &nbsp;·&nbsp; <a class="k-link" href="https://aistudio.google.com/apikey">Gemini →</a> &nbsp;·&nbsp; <a class="k-link" href="https://console.anthropic.com/settings/keys">Claude →</a> &nbsp;·&nbsp; <a class="k-link" href="https://platform.openai.com/api-keys">OpenAI →</a><div class="k-link" style="margin-top:5px">Free option: a <strong>Google Gemini</strong> key has a generous free tier, and <strong>OpenRouter</strong> has free models (run “Pica: Choose Model”) 🐾</div></div>');
    thread.appendChild(wrap);
    const saveB = action("Save my key");
    const inp = wrap.querySelector("#keyin");
    function save() { if (inp.value.trim()) vscode.postMessage({ type: "saveKey", key: inp.value }); }
    saveB.addEventListener("click", save);
    inp.addEventListener("keydown", function (e) { if (e.key === "Enter") save(); });
    inp.focus();
    scroll();
  }

  function showNeedEmail() {
    setStatus("step 1 of 2 — who are you?");
    pica("Hey — I'm <strong>Pica</strong> 🐾 I explain the code <strong>" + escapeHtml(agentName()) + "</strong> writes, in your words. First: what's the <strong>email you signed up with</strong>?");
    const wrap = el('<div class="msg" style="display:block"><input class="inp" id="emin" type="email" placeholder="you@studio.com"/><div style="height:6px"></div><a class="k-link" href="' + state.landing + '">not signed up yet? → pica-landing.vercel.app</a></div>');
    thread.appendChild(wrap);
    const saveB = action("That's me");
    const inp = wrap.querySelector("#emin");
    function save() { if (inp.value.trim()) vscode.postMessage({ type: "saveEmail", email: inp.value }); }
    saveB.addEventListener("click", save);
    inp.addEventListener("keydown", function (e) { if (e.key === "Enter") save(); });
    inp.focus();
    scroll();
  }

  function showZero() {
    setStatus("ready");
    pica("Purrfect. I'll ride along while <strong>" + escapeHtml(agentName()) + "</strong> writes your code — when it does something worth knowing, I'll pipe up and teach it in plain designer. Mind if I watch?");
    if (!state.hasWorkspace) sys("open a folder first so I have something to watch");
    const allow = action("Allow Pica to watch");
    allow.addEventListener("click", function () {
      allow.remove();
      vscode.postMessage({ type: "allow" });
      pica("On it. I'll stay quiet until something's worth your time. Go build 👀");
      sys("tip: run “Pica: Simulate an Agent Edit” to see me in action");
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
        if (!state.hasEmail) return showNeedEmail();
        if (!state.hasKey) return showNeedKey();
        if (!state.allowed) return showZero();
        setStatus("watching your code");
        pica("Back on duty 🐾 I'm watching what <strong>" + escapeHtml(agentName()) + "</strong> writes. Ask me anything, anytime.");
        sys("run “Pica: Simulate an Agent Edit” to demo the loop");
        return;
      }
      case "needEmail": thread.innerHTML = ""; return showNeedEmail();
      case "needKey": thread.innerHTML = ""; return showNeedKey();
      case "pickedImage": if (m.data) setImage(m.data); return;
      case "status": setStatus(m.text); return;
      case "busy": typing(!!m.on); if (headcat && !cheerTimer) setCat(m.on ? "think" : "idle"); return;
      case "error": {
        typing(false);
        err(m.text);
        if (m.action === "changeKey") {
          const kb = action("🔑 Change key");
          kb.addEventListener("click", function () { kb.remove(); vscode.postMessage({ type: "changeKey" }); });
        }
        return;
      }
      case "spotted": {
        sys("👀 " + agentName() + " changed " + m.file + (m.loc ? " · " + m.loc : ""));
        if (m.changes && m.changes.length > 1) {
          const wrap = el('<div class="msg msg--sys" style="display:block"></div>');
          wrap.appendChild(el('<div style="margin-bottom:5px">' + m.changes.length + ' files changed — starting with <strong>' + escapeHtml(m.teaching) + '</strong>. Tap another to switch:</div>'));
          const row = el('<div class="row" style="flex-wrap:wrap"></div>');
          m.changes.forEach(function (ch) {
            const chip = el('<button class="act act--ghost" style="font-size:11px"></button>');
            chip.textContent = ch.file + " (+" + ch.count + ")";
            if (ch.file === m.teaching) chip.disabled = true;
            else chip.addEventListener("click", function () { typing(true); vscode.postMessage({ type: "teachFile", file: ch.file }); });
            row.appendChild(chip);
          });
          wrap.appendChild(row);
          thread.appendChild(wrap); scroll();
        }
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
        if (m.data.snippet) {
          sys("📄 " + m.data.file + (m.data.loc ? " · " + m.data.loc : "") + " — the exact lines I'm explaining:");
          codeBlock(m.data.snippet);
          const rb = action("👁 Show me in the file", true);
          rb.addEventListener("click", function () { vscode.postMessage({ type: "revealCode" }); });
        }
        pica(md(m.data.explanation));
        if (m.data.concept) pica("<strong>Concept:</strong> " + md(m.data.concept));
        pica("Want to own it? Pick your game 🎮");
        const row = el('<div class="row"></div>');
        const bMcq = el('<button class="act" style="font-family:var(--mono);font-size:12px">🎮 Practice — MCQ</button>');
        const bCode = el('<button class="act act--ghost" style="font-family:var(--mono);font-size:12px">🎮 Practice — Code</button>');
        bMcq.addEventListener("click", function () { typing(true); vscode.postMessage({ type: "game", mode: "mcq" }); });
        bCode.addEventListener("click", function () { typing(true); vscode.postMessage({ type: "game", mode: "code" }); });
        row.appendChild(bMcq); row.appendChild(bCode);
        thread.appendChild(row); scroll();
        return;
      }
      case "practiceResult": {
        if (m.ok) cheer();
        pica(m.ok
          ? "✓ <strong>" + escapeHtml(m.answer) + "</strong> — nailed it. You just wrote the line " + escapeHtml(agentName()) + " would've. " + (m.concept ? "<strong>Unlocked:</strong> " + md(m.concept) : "")
          : "Close! It's <strong>" + escapeHtml(m.answer) + "</strong>. You'll get the next one 🐾 " + (m.concept ? "<strong>Concept:</strong> " + md(m.concept) : ""));
        // offer a quiz on what was just taught
        const qb = action("Quiz me on this 🧠", true);
        qb.addEventListener("click", function () { qb.remove(); vscode.postMessage({ type: "quiz" }); });
        return;
      }
      case "feedbackPrompt": {
        pica("Quick one 🐾 — is Pica actually helping you understand the code?");
        const wrap = el('<div class="msg" style="display:block"></div>');
        const inp = el('<input class="inp" id="fbnote" type="text" placeholder="anything you\'d change? (optional)"/>');
        const spacer = el('<div style="height:8px"></div>');
        const row = el('<div class="row"></div>');
        const up = el('<button class="act">👍 Yep</button>');
        const down = el('<button class="act act--ghost">👎 Not yet</button>');
        function send(rating) {
          const note = (inp.value || "").trim();
          up.disabled = down.disabled = true;
          vscode.postMessage({ type: "feedback", rating: rating, note: note });
        }
        up.addEventListener("click", function () { send("up"); });
        down.addEventListener("click", function () { send("down"); });
        row.appendChild(up); row.appendChild(down);
        wrap.appendChild(inp); wrap.appendChild(spacer); wrap.appendChild(row);
        thread.appendChild(wrap); scroll();
        inp.addEventListener("keydown", function (e) { if (e.key === "Enter") send("up"); });
        return;
      }
      case "feedbackThanks": { sys("thanks — that shapes what Pica learns next 🐾"); return; }
      case "quizQ": {
        typing(false);
        pica("<strong>Q" + (m.i + 1) + "/" + m.total + ":</strong> " + md(m.q));
        const wrap = el('<div class="msg" style="display:block"></div>');
        m.options.forEach(function (opt, idx) {
          const b = document.createElement("button");
          b.className = "qopt"; b.textContent = String.fromCharCode(65 + idx) + ". " + opt;
          b.addEventListener("click", function () {
            wrap.querySelectorAll(".qopt").forEach(function (x) { x.disabled = true; });
            b.classList.add("picked");
            vscode.postMessage({ type: "quizPick", pick: idx });
          });
          wrap.appendChild(b);
        });
        thread.appendChild(wrap); scroll();
        return;
      }
      case "quizVerdict": {
        typing(false);
        pica((m.ok ? "✓ Correct! " : "Not quite — it's <strong>" + escapeHtml(m.correct) + "</strong>. ") + md(m.why || ""));
        if (m.done) {
          pica("<strong>Score: " + m.score + "/" + m.total + "</strong>" + (m.score === m.total ? " — flawless 🐾 You're becoming the developer." : " — every miss is a future win. Want another round later? Hit 🧠 Quiz."));
        }
        return;
      }
      case "fpReady": {
        typing(false);
        pica("I blanked <strong>" + m.count + "</strong> spot" + (m.count > 1 ? "s" : "") + " in a practice copy of <code>" + escapeHtml(m.file) + "</code> — it's open in your editor. Fill every <code>____</code>, then hit <strong>✓ Check</strong> up top.");
        if (m.hints && m.hints.filter(Boolean).length) pica("<strong>Hints:</strong> " + m.hints.filter(Boolean).map(function (h, i) { return (i + 1) + ") " + escapeHtml(h); }).join(" · "));
        return;
      }
      case "fpResult": {
        typing(false);
        const lines = m.items.map(function (it, i) {
          return (it.ok ? "✓" : "✗") + " blank " + (i + 1) + (it.ok ? "" : " — answer: <code>" + escapeHtml(it.answer) + "</code>");
        }).join("<br/>");
        pica(lines + "<br/><strong>" + m.score + "/" + m.total + "</strong>" +
          (m.score === m.total ? " — you just rewrote real lines of <code>" + escapeHtml(m.file) + "</code> yourself 🐾" : " — fix the ✗ ones and hit ✓ Check again."));
        return;
      }
      case "chat": { typing(false); pica(md(m.text)); return; }
    }
  });

  // ---------- image attach (paste a screenshot or pick a file) ----------
  const attachbar = document.getElementById("attachbar");
  const attachBtn = document.getElementById("attach");
  let pendingImage = null;   // resized data URL, sent with the next message

  function shrink(dataUrl, cb) {          // downscale big screenshots before sending
    const img = new Image();
    img.onload = function () {
      const max = 1200, s = Math.min(1, max / Math.max(img.width, img.height));
      const c = document.createElement("canvas");
      c.width = Math.round(img.width * s); c.height = Math.round(img.height * s);
      c.getContext("2d").drawImage(img, 0, 0, c.width, c.height);
      cb(c.toDataURL("image/jpeg", 0.82));
    };
    img.onerror = function () { cb(dataUrl); };
    img.src = dataUrl;
  }
  function setImage(dataUrl) {
    shrink(dataUrl, function (small) {
      pendingImage = small;
      attachbar.innerHTML = "";
      const chip = el('<div class="imgchip"><img src="' + small + '"/><span>screenshot ready — ask about it</span><button title="remove">✕</button></div>');
      chip.querySelector("button").addEventListener("click", clearImage);
      attachbar.appendChild(chip); scroll();
    });
  }
  function clearImage() { pendingImage = null; attachbar.innerHTML = ""; }

  attachBtn.addEventListener("click", function () { vscode.postMessage({ type: "pickImage" }); });
  document.addEventListener("paste", function (e) {
    const items = (e.clipboardData && e.clipboardData.items) || [];
    for (let i = 0; i < items.length; i++) {
      if (items[i].type && items[i].type.indexOf("image") === 0) {
        const f = items[i].getAsFile();
        if (f) { const r = new FileReader(); r.onload = function () { setImage(r.result); }; r.readAsDataURL(f); e.preventDefault(); return; }
      }
    }
  });

  // ---------- composer + tone ----------
  function ask() {
    const t = askInp.value.trim();
    if (!t && !pendingImage) return;
    const me = el('<div class="msg" style="align-self:flex-end;background:var(--orange-lt);flex-direction:column;gap:5px"></div>');
    if (pendingImage) { const im = el('<img class="thumb" src="' + pendingImage + '"/>'); me.appendChild(im); }
    if (t) { const tx = el('<div class="tx"></div>'); tx.textContent = t; me.appendChild(tx); }
    thread.appendChild(me); scroll();
    typing(true);
    vscode.postMessage({ type: "ask", text: t, image: pendingImage });
    askInp.value = ""; clearImage();
  }
  sendBt.addEventListener("click", ask);
  askInp.addEventListener("keydown", function (e) { if (e.key === "Enter") ask(); });
  function tool(id, type) { const b = document.getElementById(id); if (b) b.addEventListener("click", function () { typing(true); vscode.postMessage({ type: type }); }); }
  tool("t-recap", "recap"); tool("t-quiz", "quiz"); tool("t-fp", "filePractice"); tool("t-fpcheck", "fileCheck");
  var gearBtn = document.getElementById("gear");
  if (gearBtn) gearBtn.addEventListener("click", function () { vscode.postMessage({ type: "openSettings" }); });
  document.querySelectorAll(".tone").forEach(function (b) {
    b.addEventListener("click", function () {
      state.tone = b.dataset.tone; markTone();
      vscode.postMessage({ type: "tone", tone: state.tone });
      sys("tone set: " + (state.tone === "professor" ? "professor 🎓" : "friend 🐾"));
    });
  });

  vscode.postMessage({ type: "ready" });
})();
