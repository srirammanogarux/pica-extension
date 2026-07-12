/* PICA ARCADE — shared game engine + games.
   Layout (per design): progress bar top, hearts as lives, game scene above,
   question below. 4-5 questions/round. Right/wrong drives the scene.
   Games register in GAMES; the extension picks one at random per round. */
(function () {
  const vscode = acquireVsCodeApi();
  const R = window.PICA_ROUND; // {game, mode, concept, questions[], hiscore, sprite}

  // ---------------- 8-bit audio (WebAudio, synthesized — no files) ----------------
  let AC = null;
  function ac() { if (!AC) AC = new (window.AudioContext || window.webkitAudioContext)(); return AC; }
  function tone(freq, t0, dur, type, vol) {
    const o = ac().createOscillator(), g = ac().createGain();
    o.type = type || "square"; o.frequency.value = freq;
    g.gain.setValueAtTime(vol || 0.12, ac().currentTime + t0);
    g.gain.exponentialRampToValueAtTime(0.001, ac().currentTime + t0 + dur);
    o.connect(g); g.connect(ac().destination);
    o.start(ac().currentTime + t0); o.stop(ac().currentTime + t0 + dur + 0.02);
  }
  const SFX = {
    correct() { tone(660, 0, .09); tone(880, .09, .12); },
    combo()   { tone(660, 0, .07); tone(880, .07, .07); tone(1174, .14, .16); },
    wrong()   { tone(220, 0, .16, "sawtooth"); tone(160, .14, .22, "sawtooth"); },
    zap()     { tone(1400, 0, .05); tone(900, .04, .05); tone(500, .08, .08, "sawtooth"); },
    bite()    { tone(180, 0, .1, "sawtooth"); tone(120, .1, .18, "sawtooth"); },
    win()     { [523, 659, 784, 1046].forEach((f, i) => tone(f, i * .12, .14)); },
    lose()    { [392, 330, 262, 196].forEach((f, i) => tone(f, i * .14, .18, "sawtooth")); },
  };

  // ---------------- DOM ----------------
  const stage = document.querySelector(".stage");
  const progressEl = document.getElementById("progress");
  const heartsEl = document.getElementById("hearts");
  const scoreEl = document.getElementById("score");
  const comboPop = document.getElementById("combo-pop");
  const canvas = document.getElementById("scene-canvas");
  const ctx = canvas.getContext("2d");
  const qcard = document.getElementById("qcard");
  const esc = (s) => String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  const md = (s) => esc(s).replace(/\*\*(.+?)\*\*/g, "<strong>$1</strong>").replace(/`([^`]+)`/g, "<code>$1</code>");
  const norm = (s) => String(s).toLowerCase().replace(/\s+/g, "").replace(/[;'"`]/g, "");

  // ---------------- round state ----------------
  const S = {
    i: 0, hearts: 3, score: 0, combo: 0, bestCombo: 0, correct: 0,
    qStart: 0, answered: false, over: false,
  };
  const TOTAL = R.questions.length;

  function renderHud() {
    progressEl.innerHTML = R.questions.map((_, i) =>
      '<i class="' + (i < S.i ? "done" : i === S.i ? "now" : "") + '"></i>').join("");
    heartsEl.innerHTML = [0, 1, 2].map((i) =>
      '<span class="' + (i < 3 - S.hearts ? "lost" : "") + '">♥</span>').join("");
    scoreEl.textContent = S.score + " pts";
  }

  // ---------------- questions (bottom card) ----------------
  function showQuestion() {
    const q = R.questions[S.i];
    S.qStart = Date.now(); S.answered = false;
    let html = "";
    if (q.type === "mcq") {
      html = '<div class="qcard__q">' + md(q.q) + '</div><div class="opts">' +
        q.options.map((o, i) => '<button class="opt" data-i="' + i + '">' + md(o) + "</button>").join("") + "</div>";
    } else {
      html = '<div class="qcard__q">' + md(q.prompt || "Fill in the blank:") + "</div>" +
        '<div class="code-display">' + esc(q.display).replace(/____/g, '<span class="blank">____</span>') + "</div>" +
        '<div class="ansrow"><input id="ans" autocomplete="off" spellcheck="false" placeholder="type the missing bit…"/>' +
        '<button class="btn" id="go">Go</button></div>';
    }
    qcard.innerHTML = html;
    if (q.type === "mcq") {
      qcard.querySelectorAll(".opt").forEach((b) => b.addEventListener("click", () => {
        if (S.answered) return;
        const pick = Number(b.dataset.i), ok = pick === q.answer;
        qcard.querySelectorAll(".opt").forEach((x) => { x.disabled = true; });
        b.classList.add(ok ? "right" : "wrong");
        if (!ok) { const r = qcard.querySelector('.opt[data-i="' + q.answer + '"]'); if (r) r.classList.add("right"); }
        settle(ok, q.why);
      }));
    } else {
      const inp = qcard.querySelector("#ans"), go = qcard.querySelector("#go");
      const submit = () => {
        if (S.answered || !inp.value.trim()) return;
        const ok = norm(inp.value) === norm(q.answer) ||
                   (norm(inp.value).length >= 3 && norm(q.answer).includes(norm(inp.value)));
        inp.disabled = true; go.disabled = true;
        inp.style.background = ok ? "#cfe8c0" : "#f3c9c0";
        if (!ok) qcard.insertAdjacentHTML("beforeend", '<div class="why">answer: <code>' + esc(q.answer) + "</code></div>");
        settle(ok, q.why);
      };
      go.addEventListener("click", submit);
      inp.addEventListener("keydown", (e) => { if (e.key === "Enter") submit(); });
      setTimeout(() => inp.focus(), 60);
    }
    game.newQuestion();
    renderHud();
  }

  // right/wrong → juice + game scene + scoring
  function settle(ok, why) {
    if (S.answered || S.over) return;
    S.answered = true;
    const speedy = Date.now() - S.qStart < 8000;
    if (ok) {
      S.correct++; S.combo++; S.bestCombo = Math.max(S.bestCombo, S.combo);
      S.score += 100 + (S.combo - 1) * 25 + (speedy ? 50 : 0);
      (S.combo >= 2 ? SFX.combo : SFX.correct)();
      if (S.combo >= 2) { comboPop.textContent = "×" + S.combo + " COMBO"; comboPop.classList.remove("show"); void comboPop.offsetWidth; comboPop.classList.add("show"); }
      stage.classList.remove("flash-good"); void stage.offsetWidth; stage.classList.add("flash-good");
      game.onCorrect();
    } else {
      S.combo = 0; S.hearts--;
      SFX.wrong();
      stage.classList.remove("shake", "flash-bad"); void stage.offsetWidth; stage.classList.add("shake", "flash-bad");
      game.onWrong();
      if (why) qcard.insertAdjacentHTML("beforeend", '<div class="why">' + md(why) + "</div>");
    }
    renderHud();
    setTimeout(next, ok ? 900 : 1600);
  }

  function next() {
    if (S.over) return;
    if (S.hearts <= 0) return end(false);
    S.i++;
    if (S.i >= TOTAL) return end(true);
    showQuestion();
  }

  function end(won) {
    S.over = true;
    (won ? SFX.win : SFX.lose)();
    const beat = S.score > (R.hiscore || 0);
    vscode.postMessage({ type: "done", game: R.game, score: S.score, correct: S.correct, total: TOTAL, bestCombo: S.bestCombo, won });
    const ov = document.getElementById("overlay");
    ov.querySelector(".endcard__title").textContent = won ? (S.correct === TOTAL ? "FLAWLESS!" : "GREAT JOB!") : "OUT OF LIVES!";
    ov.querySelector(".endcard__hi").textContent = beat ? "★ NEW HIGH SCORE ★" : "high score: " + Math.max(R.hiscore || 0, S.score);
    ov.querySelector(".endcard__hi").classList.toggle("beat", beat);
    document.getElementById("st-correct").innerHTML = "<b>" + S.correct + "</b>/" + TOTAL + " right";
    document.getElementById("st-combo").innerHTML = "best combo <b>×" + Math.max(S.bestCombo, 1) + "</b>";
    ov.classList.add("show");
    // score count-up
    const scoreEl2 = ov.querySelector(".endcard__score");
    const t0 = performance.now(), dur = 900;
    (function tick(t) {
      const p = Math.min(1, (t - t0) / dur);
      scoreEl2.textContent = Math.round(S.score * p);
      if (p < 1) requestAnimationFrame(tick);
    })(t0);
    document.getElementById("back").addEventListener("click", () => vscode.postMessage({ type: "back" }));
  }

  // ---------------- pixel helpers ----------------
  const PX = 5; // pixel size
  function px(x, y, w, h, color) { ctx.fillStyle = color; ctx.fillRect(Math.round(x), Math.round(y), w * PX, h * PX); }

  // ================= GAME: BUG ZAPPER =================
  // A bug crawls toward your file; it IS the timer. Correct = ZAP. Wrong/late = bite.
  const bugzap = {
    label: "BUG ZAPPER — zap it before it reaches your file",
    dur: 22000,
    bug: null, state: "idle", stateT: 0, deadline: 0, sparks: [],
    newQuestion() {
      this.bug = { x: 30, y: canvas.height / 2 - 3 * PX, frame: 0 };
      this.deadline = Date.now() + this.dur;
      this.state = "crawl";
    },
    onCorrect() { this.state = "zap"; this.stateT = Date.now(); SFX.zap(); this.burst(this.bug.x + 4 * PX, this.bug.y + 3 * PX); },
    onWrong() { this.state = "bite"; this.stateT = Date.now(); SFX.bite(); },
    burst(cx, cy) {
      for (let i = 0; i < 14; i++) this.sparks.push({ x: cx, y: cy, vx: (Math.random() - .5) * 4, vy: (Math.random() - .8) * 4, life: 26, c: Math.random() < .5 ? "#E8823C" : "#F7A878" });
    },
    drawBug(x, y, squish) {
      const f = Math.floor(Date.now() / 140) % 2;
      const B = "#7db24a", D = "#4a6b2a", K = "#1A1614";
      px(x + PX, y, 6, 3, B); px(x, y + PX, 1, 1, D); px(x + 7 * PX, y + PX, 1, 1, D);
      px(x + 2 * PX, y - PX, 1, 1, D); px(x + 5 * PX, y - PX, 1, 1, D);           // antennae
      px(x + 2 * PX, y + PX, 1, 1, K); px(x + 5 * PX, y + PX, 1, 1, K);           // eyes
      if (!squish) { // legs (2-frame scuttle)
        const ly = y + 3 * PX;
        [0, 3, 6].forEach((o, i) => px(x + (o + (f === i % 2 ? 0 : 1)) * PX, ly, 1, 1, D));
      }
    },
    drawFile(x, y) {
      px(x, y, 7, 9, "#F4F6F0"); px(x + 5 * PX, y, 2, 2, "#c9c2b8");
      px(x + PX, y + 2 * PX, 5, 1, "#8B4A2B"); px(x + PX, y + 4 * PX, 4, 1, "#8B4A2B"); px(x + PX, y + 6 * PX, 5, 1, "#8B4A2B");
    },
    tick() {
      ctx.fillStyle = "#1A1614"; ctx.fillRect(0, 0, canvas.width, canvas.height);
      // ground line
      ctx.fillStyle = "#2a2320"; ctx.fillRect(0, canvas.height / 2 + 3 * PX, canvas.width, 2);
      const fileX = canvas.width - 70, fileY = canvas.height / 2 - 5 * PX;
      this.drawFile(fileX, fileY);
      if (!this.bug) return;
      if (this.state === "crawl") {
        const total = fileX - 46 - 30;
        const left = Math.max(0, this.deadline - Date.now());
        this.bug.x = 30 + total * (1 - left / this.dur);
        this.drawBug(this.bug.x, this.bug.y);
        if (left <= 0 && !S.answered) {                      // bug reached the file — timeout
          qcard.querySelectorAll("button,input").forEach((x) => { x.disabled = true; });
          settle(false, "Too slow — the bug got there first!");
        }
      } else if (this.state === "zap") {
        const t = Date.now() - this.stateT;
        if (t < 260) {
          ctx.strokeStyle = t % 80 < 40 ? "#F7A878" : "#fff"; ctx.lineWidth = 3;
          ctx.beginPath(); let zx = this.bug.x + 4 * PX, zy = 6;
          ctx.moveTo(zx + 14, zy);
          for (let yy = zy; yy < this.bug.y; yy += 14) ctx.lineTo(zx + (Math.random() * 22 - 11) + 7, yy);
          ctx.lineTo(zx + 3, this.bug.y); ctx.stroke();
          this.drawBug(this.bug.x, this.bug.y, true);
        }
      } else if (this.state === "bite") {
        const t = Date.now() - this.stateT;
        this.bug.x = Math.min(this.bug.x + 9, fileX - 40);
        this.drawBug(this.bug.x, this.bug.y);
        if (t % 300 < 150) { ctx.fillStyle = "#D9503F"; ctx.fillRect(fileX - 4, fileY, 6, 9 * PX); }
      }
      // sparks
      this.sparks = this.sparks.filter((s) => s.life-- > 0);
      this.sparks.forEach((s) => { s.x += s.vx; s.y += s.vy; s.vy += .12; ctx.fillStyle = s.c; ctx.fillRect(s.x, s.y, 3, 3); });
    },
  };

  // ================= GAME: PIXEL BUILDER =================
  // A hidden pixel artwork assembles piece by piece — every correct answer
  // flies a chunk of pixels in. Wrong = the chunk never arrives (gap stays).
  const ARTS = [
    { name: "fish", rows: [
      "M....CCCCC....",
      "MM..CCYYYCC...",
      "MMMCCYYYYYCC..",
      "MMMCCYKYYYYCC.",
      "MMMCCYYYYYCC..",
      "MM..CCYYYCC...",
      "M....CCCCC....",
    ]},
    { name: "rocket", rows: [
      ".....RR.....",
      "....RRRR....",
      "....RWWR....",
      "....RWWR....",
      "....RRRR....",
      "..Y.RRRR.Y..",
      ".YY.RRRR.YY.",
      ".YYRRRRRRYY.",
      "....O..O....",
      "...OO..OO...",
    ]},
    { name: "mug", rows: [
      "..SS..SS....",
      "...SS..SS...",
      ".BBBBBBBB...",
      ".BWWWWWWB.GG",
      ".BWWWWWWB..G",
      ".BWWWWWWB..G",
      ".BWWWWWWB.GG",
      ".BBBBBBBB...",
      "..BBBBBB....",
    ]},
  ];
  const ART_COLORS = { C: "#4EC9F5", Y: "#F5E663", M: "#E24FB4", K: "#1A1614", R: "#E8823C", W: "#BFEFFF", O: "#F5A05A", G: "#8B4A2B", B: "#E24FB4", S: "#c9c2b8" };

  const pixelbuilder = {
    label: "PIXEL BUILDER — every right answer builds the picture",
    cells: [], chunks: [], placed: [], flying: [], shakeT: 0, cell: 12, ox: 0, oy: 0,
    init() {
      const art = ARTS[Math.floor(Math.random() * ARTS.length)];
      const rows = art.rows, H = rows.length, W = rows[0].length;
      this.cell = Math.floor(Math.min((canvas.height - 44) / H, (canvas.width * 0.55) / W));
      this.ox = Math.round((canvas.width - W * this.cell) / 2);
      this.oy = Math.round((canvas.height - H * this.cell) / 2);
      this.cells = [];
      for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
        const ch = rows[y][x];
        if (ch && ch !== ".") this.cells.push({ x, y, c: ART_COLORS[ch] || "#fff" });
      }
      // build bottom-up: split into one chunk per question
      this.cells.sort((a, b) => b.y - a.y || a.x - b.x);
      const per = Math.ceil(this.cells.length / TOTAL);
      this.chunks = [];
      for (let i = 0; i < TOTAL; i++) this.chunks.push(this.cells.slice(i * per, (i + 1) * per));
    },
    newQuestion() { if (!this.cells.length) this.init(); },
    onCorrect() {
      const chunk = this.chunks[S.i] || [];
      const now = performance.now();
      chunk.forEach((cell, i) => {
        const edge = Math.random();
        const sx = edge < .5 ? (Math.random() < .5 ? -30 : canvas.width + 30) : Math.random() * canvas.width;
        const sy = edge < .5 ? Math.random() * canvas.height : (Math.random() < .5 ? -30 : canvas.height + 30);
        this.flying.push({ cell, sx, sy, t0: now + i * 22 });
      });
      tone(980, .25, .07);   // final snap after the pieces land
    },
    onWrong() { this.shakeT = performance.now(); },
    tick() {
      ctx.fillStyle = "#1A1614"; ctx.fillRect(0, 0, canvas.width, canvas.height);
      const now = performance.now();
      let sx = 0, sy = 0;
      if (now - this.shakeT < 300) { sx = (Math.random() - .5) * 8; sy = (Math.random() - .5) * 6; }
      // faint ghost outline of the full artwork
      ctx.globalAlpha = 0.10;
      this.cells.forEach((c) => { ctx.fillStyle = "#F4F6F0"; ctx.fillRect(this.ox + c.x * this.cell + sx, this.oy + c.y * this.cell + sy, this.cell - 1, this.cell - 1); });
      ctx.globalAlpha = 1;
      // placed pixels
      this.placed.forEach((c) => { ctx.fillStyle = c.c; ctx.fillRect(this.ox + c.x * this.cell + sx, this.oy + c.y * this.cell + sy, this.cell - 1, this.cell - 1); });
      // flying pieces (ease-out cubic), land → placed + white flash
      this.flying = this.flying.filter((f) => {
        const p = Math.min(1, Math.max(0, (now - f.t0) / 420));
        if (p <= 0) return true;
        const e = 1 - Math.pow(1 - p, 3);
        const tx = this.ox + f.cell.x * this.cell, ty = this.oy + f.cell.y * this.cell;
        const x = f.sx + (tx - f.sx) * e, y = f.sy + (ty - f.sy) * e;
        ctx.fillStyle = p > .92 ? "#ffffff" : f.cell.c;
        ctx.fillRect(x + sx, y + sy, this.cell - 1, this.cell - 1);
        if (p >= 1) { this.placed.push(f.cell); return false; }
        return true;
      });
    },
  };

  // ---------------- game registry + loop ----------------
  const GAMES = { bugzap, pixelbuilder };
  const game = GAMES[R.game] || bugzap;
  document.getElementById("scene-label").textContent = game.label;
  document.getElementById("hud-title").textContent = "GAME MODE";
  document.getElementById("concept").textContent = R.concept ? "• " + R.concept : "";

  function loop() { game.tick(); if (!S.over) requestAnimationFrame(loop); else game.tick(); }
  renderHud(); showQuestion(); requestAnimationFrame(loop);
})();
