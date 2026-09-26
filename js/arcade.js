// Arcade: cabinets you click into, playable solo or against someone else on the
// page. Online matches ride the same MQTT connection as the live cursors.
(() => {
  "use strict";

  const hub = window.visitme;
  const cabinetsEl = document.getElementById("cabinets");
  if (!hub || !cabinetsEl) return;

  const ID_RE = /^[a-z0-9]{8,16}$/;
  const randomId = () => Array.from(crypto.getRandomValues(new Uint8Array(12)), (b) => (b % 36).toString(36)).join("");
  const rand = (a, b) => a + Math.random() * (b - a);
  const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
  const num = (v, a, b) => (typeof v === "number" && Number.isFinite(v) ? clamp(v, a, b) : null);
  const DPR = Math.min(2, window.devicePixelRatio || 1);
  const FONT = "'Space Grotesk', system-ui, sans-serif";

  function setupCanvas(canvas, w, h) {
    canvas.width = w * DPR;
    canvas.height = h * DPR;
    const g = canvas.getContext("2d");
    g.setTransform(DPR, 0, 0, DPR, 0, 0);
    return g;
  }

  const GAMES = {
    pacman: {
      name: "Pac-Man", hue: 48, create: pacmanGame, cpuName: "",
      solo: ["Play solo", "Classic Pac-Man"], online: ["Race someone", "Two Pac-Men, one maze"],
      hint: "Arrow keys or WASD. On a phone, swipe.",
    },
    pong: {
      name: "Pong", hue: 150, create: pongGame, cpuName: "Computer",
      solo: ["vs Computer", "Play by yourself"], online: ["vs Someone online", "Real-time match"],
      hint: "Move your mouse, drag, or use ↑ ↓. First to 7.",
    },
    ttt: {
      name: "Tic-Tac-Toe", hue: 285, create: tttGame, cpuName: "Computer",
      solo: ["vs Computer", "Play by yourself"], online: ["vs Someone online", "Take turns"],
      hint: "Three in a row wins.",
    },
    c4: {
      name: "Connect Four", hue: 8, create: c4Game, cpuName: "Computer",
      solo: ["vs Computer", "Play by yourself"], online: ["vs Someone online", "Take turns"],
      hint: "Line up four in a row.",
    },
  };

  const ART = {
    pacman: '<span class="art-pac"><i class="pac"></i><i class="dot"></i><i class="dot"></i><i class="dot"></i><i class="ghost"></i></span>',
    pong: '<span class="art-pong"><i></i><i></i><i></i></span>',
    ttt: '<span class="art-ttt"><b>✕</b><b>◯</b><b></b><b></b><b>✕</b><b></b><b>◯</b><b></b><b>✕</b></span>',
    c4: '<span class="art-c4">' + "....,.r..,.yr.,yryy".split("").filter((c) => c !== ",")
      .map((c) => `<b class="${c === "r" ? "r" : c === "y" ? "y" : ""}"></b>`).join("") + "</span>",
  };

  // ---------------------------------------------------------------------------
  // Cabinets
  // ---------------------------------------------------------------------------
  for (const [key, game] of Object.entries(GAMES)) {
    const cab = document.createElement("button");
    cab.type = "button";
    cab.className = "cabinet";
    cab.dataset.game = key;
    cab.style.setProperty("--g", game.hue);
    cab.innerHTML = `
      <span class="cab-marquee">${game.name}</span>
      <span class="cab-screen">${ART[key]}</span>
      <span class="cab-deck"><span class="cab-stick"></span><span class="cab-btn"></span><span class="cab-btn"></span></span>
      <span class="cab-status"></span>`;
    cab.addEventListener("click", () => openGame(key));
    cabinetsEl.append(cab);
  }

  function activity(key) {
    let playing = 0;
    let waiting = 0;
    for (const p of [hub.me, ...hub.peers.values()]) {
      if (p.g !== key) continue;
      if (p.gs === "w") waiting++;
      else if (p.gs) playing++;
    }
    return { playing, waiting };
  }

  function renderCabinets() {
    for (const cab of cabinetsEl.children) {
      const { playing, waiting } = activity(cab.dataset.game);
      const parts = [];
      if (playing) parts.push(`${playing} playing`);
      if (waiting) parts.push(`${waiting} waiting`);
      cab.querySelector(".cab-status").textContent = parts.join(" · ") || "Click to play";
      cab.classList.toggle("busy", playing + waiting > 0);
    }
    updateMenuWaiting();
    checkOpponent();
  }

  // ---------------------------------------------------------------------------
  // Game window
  // ---------------------------------------------------------------------------
  const modal = document.createElement("div");
  modal.className = "arcade-modal";
  modal.hidden = true;
  modal.innerHTML = `
    <div class="arcade-window" role="dialog" aria-modal="true" aria-labelledby="arcade-title">
      <header class="arcade-head">
        <h3 id="arcade-title"></h3>
        <span class="arcade-vs"></span>
        <button type="button" class="arcade-close" aria-label="Close">✕</button>
      </header>
      <div class="arcade-stage"></div>
      <div class="arcade-bar">
        <p class="arcade-msg"></p>
        <div class="arcade-actions"></div>
      </div>
    </div>`;
  document.body.append(modal);

  const titleEl = modal.querySelector("#arcade-title");
  const vsEl = modal.querySelector(".arcade-vs");
  const stage = modal.querySelector(".arcade-stage");
  const msgEl = modal.querySelector(".arcade-msg");
  const actionsEl = modal.querySelector(".arcade-actions");

  modal.querySelector(".arcade-close").addEventListener("click", closeGame);
  modal.addEventListener("click", (e) => { if (e.target === modal) closeGame(); });
  addEventListener("keydown", (e) => { if (e.key === "Escape" && session) closeGame(); });
  addEventListener("pagehide", () => roomSend({ t: "bye" }));

  const setMsg = (text) => { msgEl.textContent = text; };

  function setActions(list) {
    actionsEl.textContent = "";
    for (const a of list) {
      const b = document.createElement("button");
      b.type = "button";
      b.textContent = a.label;
      if (a.primary) b.className = "primary";
      b.addEventListener("click", a.fn);
      actionsEl.append(b);
    }
  }

  function waitScreen(text, sub) {
    stage.innerHTML = '<div class="arcade-wait"><div class="arcade-spinner"></div><p></p><small></small></div>';
    stage.querySelector("p").textContent = text;
    stage.querySelector("small").textContent = sub || "";
  }

  // ---------------------------------------------------------------------------
  // Sessions: menu → solo round, or menu → matchmaking → online rounds
  // ---------------------------------------------------------------------------
  let session = null;

  function openGame(key) {
    if (session) closeGame();
    session = { key, game: GAMES[key], phase: "menu", wins: [0, 0] };
    titleEl.textContent = session.game.name;
    modal.hidden = false;
    document.body.classList.add("arcade-open");
    showMenu();
  }

  function closeGame() {
    if (!session) return;
    leaveOnline(true);
    stopEngine();
    session = null;
    hub.setActivity("", "");
    modal.hidden = true;
    document.body.classList.remove("arcade-open");
  }

  function showMenu() {
    const s = session;
    leaveOnline(true);
    stopEngine();
    Object.assign(s, { phase: "menu", mode: null, wins: [0, 0], round: 0 });
    hub.setActivity("", "");
    updateVs();
    stage.innerHTML = `
      <div class="arcade-menu">
        <button type="button"><span class="big">🕹️</span><b></b><small></small></button>
        <button type="button"><span class="big">🌐</span><b></b><small class="menu-waiting"></small></button>
      </div>`;
    const [soloBtn, onlineBtn] = stage.querySelectorAll("button");
    soloBtn.querySelector("b").textContent = s.game.solo[0];
    soloBtn.querySelector("small").textContent = s.game.solo[1];
    onlineBtn.querySelector("b").textContent = s.game.online[0];
    soloBtn.addEventListener("click", startSolo);
    onlineBtn.addEventListener("click", goOnline);
    setMsg(s.game.hint);
    setActions([]);
    updateMenuWaiting();
  }

  function updateMenuWaiting() {
    const el = session && stage.querySelector(".menu-waiting");
    if (!el) return;
    const { waiting } = activity(session.key);
    el.textContent = waiting ? `${waiting} waiting. Jump in!` : session.game.online[1];
  }

  function updateVs() {
    const s = session;
    if (!s || !s.mode) { vsEl.textContent = ""; return; }
    const opp = s.mode === "cpu" ? s.game.cpuName : s.oppName;
    const tally = s.wins[0] + s.wins[1] ? ` · ${s.wins[0]}–${s.wins[1]}` : "";
    vsEl.textContent = opp ? `vs ${opp}${tally}` : "";
  }

  function startSolo() {
    const s = session;
    leaveOnline(true);
    Object.assign(s, { mode: "cpu", phase: "playing", round: 0, wins: [0, 0], oppName: s.game.cpuName || "Computer" });
    hub.setActivity(s.key, "s");
    beginRound(0);
  }

  function beginRound(first) {
    const s = session;
    stopEngine();
    s.myRematch = s.oppRematch = false;
    s.round++;
    const mySide = s.mode === "online" && !s.host ? 1 : 0;
    const names = [];
    names[mySide] = "You";
    names[1 - mySide] = s.oppName;
    updateVs();
    setMsg("");
    setActions([{ label: s.mode === "online" ? "Leave" : "Menu", fn: showMenu }]);
    const ctx = {
      mode: s.mode, mySide, first, names,
      host: s.mode === "cpu" || s.host,
      send: (msg) => { if (s.mode === "online") roomSend(msg); },
      status: (text) => { if (session === s && s.ctx === ctx) setMsg(text); },
      end: (result, text) => { if (session === s && s.ctx === ctx) roundOver(result, text); },
    };
    s.ctx = ctx;
    s.engine = s.game.create(stage, ctx);
  }

  // result: winning side, -1 for a draw, -2 for a solo score run.
  function roundOver(result, text) {
    const s = session;
    const { mySide } = s.ctx;
    if (result === mySide) s.wins[0]++;
    else if (result === 1 - mySide) s.wins[1]++;
    updateVs();
    setMsg(text || (result === -1 ? "It's a draw!" : result === mySide ? "You win! 🎉" : `${s.oppName} wins!`));
    if (s.mode === "online") {
      setActions([{ label: "Rematch", primary: true, fn: askRematch }, { label: "Leave", fn: showMenu }]);
    } else {
      setActions([{ label: "Play again", primary: true, fn: () => beginRound(s.round % 2) }, { label: "Menu", fn: showMenu }]);
    }
  }

  function stopEngine() {
    if (!session) return;
    session.engine?.destroy?.();
    session.engine = null;
    session.ctx = null;
  }

  // --- matchmaking -----------------------------------------------------------
  // Everyone looking for a game announces "seek" in the game's lobby. The
  // seeker with the lower id asks the other to join; that one accepts, hosts,
  // and picks a private room. Any two seekers always end up paired.
  function goOnline() {
    const s = session;
    stopEngine();
    Object.assign(s, { mode: "online", phase: "seeking", wins: [0, 0] });
    s.lobby = hub.topic(`g/${s.key}/lobby`);
    hub.subscribe(s.lobby, onLobby);
    hub.setActivity(s.key, "w");
    updateVs();
    waitScreen("Looking for someone to play…", "Share the link so a friend can join.");
    setMsg("");
    setActions([
      { label: `${s.game.solo[0]} instead`, fn: startSolo },
      { label: "Cancel", fn: showMenu },
    ]);
    const seek = () => { if (session === s && s.phase === "seeking") hub.send(s.lobby, { t: "seek", id: hub.me.id }); };
    seek();
    s.seekTimer = setInterval(seek, 1500);
  }

  function onLobby(msg) {
    const s = session;
    if (!s || s.mode !== "online" || !ID_RE.test(msg.id) || msg.id === hub.me.id) return;
    if (msg.t === "seek" && s.phase === "seeking" && hub.me.id < msg.id) {
      s.phase = "joining";
      s.joinTarget = msg.id;
      hub.send(s.lobby, { t: "join", id: hub.me.id, to: msg.id });
      s.joinTimer = setTimeout(() => { if (s.phase === "joining") s.phase = "seeking"; }, 3000);
    } else if (msg.t === "join" && msg.to === hub.me.id && s.phase === "seeking") {
      const room = randomId();
      hub.send(s.lobby, { t: "accept", id: hub.me.id, to: msg.id, room });
      startMatch(room, msg.id, true);
    } else if (msg.t === "accept" && msg.to === hub.me.id && s.phase === "joining" &&
               msg.id === s.joinTarget && ID_RE.test(msg.room)) {
      startMatch(msg.room, msg.id, false);
    }
  }

  function startMatch(room, opp, host) {
    const s = session;
    clearInterval(s.seekTimer);
    clearTimeout(s.joinTimer);
    hub.unsubscribe(s.lobby);
    s.lobby = null;
    const p = hub.peers.get(opp);
    Object.assign(s, {
      phase: "playing", opp, host, round: 0, wins: [0, 0], started: false, lastFirst: undefined,
      room: hub.topic(`g/r/${room}`), oppSeen: !!p, oppName: p ? hub.labelFor(p) : "Opponent",
    });
    hub.subscribe(s.room, onRoom);
    hub.setActivity(s.key, "p");
    updateVs();
    waitScreen(`Matched with ${s.oppName}!`, "Starting…");
    setActions([{ label: "Leave", fn: showMenu }]);
    if (!host) {
      // Tell the host we're subscribed and ready (repeat until the round starts).
      const ready = () => { if (session === s && !s.started && s.room) roomSend({ t: "ready" }); };
      setTimeout(ready, 400);
      s.readyTimer = setInterval(ready, 1200);
    }
  }

  function roomSend(msg) {
    if (session?.room) hub.send(session.room, { ...msg, from: hub.me.id });
  }

  function onRoom(msg) {
    const s = session;
    if (!s || s.phase !== "playing" || msg.from !== s.opp) return;
    if (msg.t === "ready") {
      if (s.host && !s.started) hostStartRound();
    } else if (msg.t === "start") {
      if (!s.host && (msg.first === 0 || msg.first === 1)) {
        s.started = true;
        clearInterval(s.readyTimer);
        beginRound(msg.first);
      }
    } else if (msg.t === "rematch") {
      s.oppRematch = true;
      if (s.host && s.myRematch) hostStartRound();
    } else if (msg.t === "bye") {
      opponentLeft();
    } else {
      s.engine?.onNet?.(msg);
    }
  }

  function hostStartRound() {
    const s = session;
    s.started = true;
    const first = s.lastFirst === undefined ? (Math.random() < 0.5 ? 0 : 1) : 1 - s.lastFirst;
    s.lastFirst = first;
    roomSend({ t: "start", first });
    beginRound(first);
  }

  function askRematch() {
    const s = session;
    s.myRematch = true;
    roomSend({ t: "rematch" });
    if (s.host && s.oppRematch) {
      hostStartRound();
    } else {
      setMsg(`Waiting for ${s.oppName}…`);
      setActions([{ label: "Leave", fn: showMenu }]);
    }
  }

  function checkOpponent() {
    const s = session;
    if (!s || !s.opp || s.phase !== "playing") return;
    if (hub.peers.has(s.opp)) s.oppSeen = true;
    else if (s.oppSeen) opponentLeft();
  }

  function opponentLeft() {
    const s = session;
    if (!s || s.mode !== "online" || s.phase !== "playing") return;
    leaveOnline(false);
    s.engine?.destroy?.();
    s.phase = "left";
    hub.setActivity("", "");
    setMsg(`${s.oppName} left the game.`);
    setActions([
      { label: "Find someone new", primary: true, fn: goOnline },
      { label: s.game.solo[0], fn: startSolo },
    ]);
  }

  function leaveOnline(sayBye) {
    const s = session;
    if (!s) return;
    clearInterval(s.seekTimer);
    clearTimeout(s.joinTimer);
    clearInterval(s.readyTimer);
    if (s.lobby) { hub.unsubscribe(s.lobby); s.lobby = null; }
    if (s.room) {
      if (sayBye) roomSend({ t: "bye" });
      hub.unsubscribe(s.room);
      s.room = null;
    }
    s.opp = null;
  }

  // ---------------------------------------------------------------------------
  // Tic-Tac-Toe
  // ---------------------------------------------------------------------------
  function tttGame(stage, ctx) {
    const LINES = [[0, 1, 2], [3, 4, 5], [6, 7, 8], [0, 3, 6], [1, 4, 7], [2, 5, 8], [0, 4, 8], [2, 4, 6]];
    const MARKS = ["✕", "◯"];
    const board = Array(9).fill(-1);
    let turn = ctx.first;
    let over = false;
    let timer = 0;

    stage.innerHTML = '<div class="ttt"></div>';
    const cells = board.map((_, i) => {
      const b = document.createElement("button");
      b.type = "button";
      b.className = "ttt-cell";
      b.addEventListener("click", () => {
        if (over || turn !== ctx.mySide || board[i] >= 0) return;
        play(i);
        ctx.send({ t: "move", m: i });
      });
      stage.firstChild.append(b);
      return b;
    });

    function result(bd) {
      for (const l of LINES) if (bd[l[0]] >= 0 && bd[l[0]] === bd[l[1]] && bd[l[1]] === bd[l[2]]) return { side: bd[l[0]], line: l };
      return bd.includes(-1) ? null : { side: -1, line: [] };
    }

    function play(i) {
      board[i] = turn;
      const r = result(board);
      if (r) {
        over = true;
        r.line.forEach((j) => cells[j].classList.add("win"));
        render();
        ctx.end(r.side);
        return;
      }
      turn = 1 - turn;
      render();
      if (ctx.mode === "cpu" && turn !== ctx.mySide) timer = setTimeout(() => play(cpuMove()), 450);
    }

    function render() {
      cells.forEach((c, i) => {
        c.textContent = board[i] < 0 ? "" : MARKS[board[i]];
        c.dataset.side = board[i];
        c.disabled = over || board[i] >= 0 || turn !== ctx.mySide;
      });
      if (!over) ctx.status(turn === ctx.mySide ? `Your turn (${MARKS[ctx.mySide]})` : `${ctx.names[turn]}'s turn…`);
    }

    function minimax(bd, side, cpu, depth) {
      const r = result(bd);
      if (r) return r.side === -1 ? 0 : r.side === cpu ? 10 - depth : depth - 10;
      let best = side === cpu ? -Infinity : Infinity;
      for (let i = 0; i < 9; i++) {
        if (bd[i] >= 0) continue;
        bd[i] = side;
        const score = minimax(bd, 1 - side, cpu, depth + 1);
        bd[i] = -1;
        best = side === cpu ? Math.max(best, score) : Math.min(best, score);
      }
      return best;
    }

    // Mostly perfect, with the odd slip so it can be beaten.
    function cpuMove() {
      const free = board.flatMap((v, i) => (v < 0 ? [i] : []));
      if (Math.random() < 0.2) return free[Math.floor(Math.random() * free.length)];
      let best = free[0];
      let bestScore = -Infinity;
      for (const i of free) {
        board[i] = turn;
        const score = minimax(board, 1 - turn, turn, 0);
        board[i] = -1;
        if (score > bestScore) { bestScore = score; best = i; }
      }
      return best;
    }

    render();
    if (ctx.mode === "cpu" && turn !== ctx.mySide) timer = setTimeout(() => play(cpuMove()), 600);

    return {
      onNet(msg) {
        if (msg.t === "move" && !over && turn !== ctx.mySide && Number.isInteger(msg.m) && board[msg.m] === -1) play(msg.m);
      },
      destroy() { clearTimeout(timer); over = true; },
    };
  }

  // ---------------------------------------------------------------------------
  // Connect Four
  // ---------------------------------------------------------------------------
  function c4Game(stage, ctx) {
    const COLS = 7;
    const ROWS = 6;
    const board = Array(COLS * ROWS).fill(-1); // row 0 is the top
    let turn = ctx.first;
    let over = false;
    let timer = 0;

    stage.innerHTML = '<div class="c4"></div>';
    const grid = stage.firstChild;
    const cells = board.map((_, i) => {
      const b = document.createElement("button");
      b.type = "button";
      b.className = "c4-cell";
      b.addEventListener("click", () => {
        const c = i % COLS;
        if (over || turn !== ctx.mySide || dropRow(c) < 0) return;
        play(c);
        ctx.send({ t: "move", m: c });
      });
      b.addEventListener("pointerenter", () => hover(i % COLS));
      grid.append(b);
      return b;
    });
    grid.addEventListener("pointerleave", () => hover(-1));

    function hover(col) {
      cells.forEach((cell, i) => cell.classList.toggle("col-hover", i % COLS === col && !over && turn === ctx.mySide));
    }

    function dropRow(c) {
      for (let r = ROWS - 1; r >= 0; r--) if (board[r * COLS + c] < 0) return r;
      return -1;
    }

    function winLine(r, c) {
      const side = board[r * COLS + c];
      for (const [dr, dc] of [[0, 1], [1, 0], [1, 1], [1, -1]]) {
        const line = [r * COLS + c];
        for (const s of [1, -1]) {
          let rr = r + dr * s;
          let cc = c + dc * s;
          while (rr >= 0 && rr < ROWS && cc >= 0 && cc < COLS && board[rr * COLS + cc] === side) {
            line.push(rr * COLS + cc);
            rr += dr * s;
            cc += dc * s;
          }
        }
        if (line.length >= 4) return line;
      }
      return null;
    }

    function play(c) {
      const r = dropRow(c);
      board[r * COLS + c] = turn;
      cells[r * COLS + c].classList.add("drop");
      const line = winLine(r, c);
      if (line || !board.includes(-1)) {
        over = true;
        line?.forEach((i) => cells[i].classList.add("win"));
        render();
        ctx.end(line ? turn : -1);
        return;
      }
      turn = 1 - turn;
      render();
      if (ctx.mode === "cpu" && turn !== ctx.mySide) timer = setTimeout(() => play(cpuMove()), 500);
    }

    function render() {
      cells.forEach((cell, i) => {
        cell.dataset.side = board[i];
        cell.disabled = over || turn !== ctx.mySide || dropRow(i % COLS) < 0;
      });
      hover(-1);
      if (!over) ctx.status(turn === ctx.mySide ? `Your turn (${ctx.mySide === 0 ? "red" : "yellow"})` : `${ctx.names[turn]}'s turn…`);
    }

    // Win if possible, block if needed, don't set up the opponent, favor the middle.
    function cpuMove() {
      const cpu = turn;
      const opp = 1 - turn;
      const valid = [...Array(COLS).keys()].filter((c) => dropRow(c) >= 0);
      const wins = (side, c) => {
        const r = dropRow(c);
        board[r * COLS + c] = side;
        const w = !!winLine(r, c);
        board[r * COLS + c] = -1;
        return w;
      };
      for (const c of valid) if (wins(cpu, c)) return c;
      for (const c of valid) if (wins(opp, c)) return c;
      const safe = valid.filter((c) => {
        const r = dropRow(c);
        if (r === 0) return true;
        board[r * COLS + c] = cpu;
        const bad = wins(opp, c);
        board[r * COLS + c] = -1;
        return !bad;
      });
      const pool = safe.length ? safe : valid;
      let best = pool[0];
      let bestScore = -Infinity;
      for (const c of pool) {
        const score = -Math.abs(3 - c) + rand(0, 1.6);
        if (score > bestScore) { bestScore = score; best = c; }
      }
      return best;
    }

    render();
    if (ctx.mode === "cpu" && turn !== ctx.mySide) timer = setTimeout(() => play(cpuMove()), 600);

    return {
      onNet(msg) {
        const c = msg.m;
        if (msg.t === "move" && !over && turn !== ctx.mySide && Number.isInteger(c) && c >= 0 && c < COLS && dropRow(c) >= 0) play(c);
      },
      destroy() { clearTimeout(timer); over = true; },
    };
  }

  // ---------------------------------------------------------------------------
  // Pong. The host (or solo player) runs the physics; the guest sends its
  // paddle and draws the ball from the host's updates.
  // ---------------------------------------------------------------------------
  function pongGame(stage, ctx) {
    const W = 640, H = 400, PH = 72, PW = 10, R = 7, WIN = 7;
    const X0 = 24, X1 = W - 24 - PW;
    const SPEED0 = 330, MAX_SPEED = 820;

    stage.innerHTML = '<canvas class="pong"></canvas>';
    const cv = stage.firstChild;
    const g = setupCanvas(cv, W, H);
    const me = ctx.mySide;
    const other = 1 - me;
    const sim = ctx.host;
    const pad = [H / 2, H / 2];
    const score = [0, 0];
    const keys = { up: false, down: false };
    let target = H / 2;
    let netPad = H / 2;
    let ball = { x: W / 2, y: H / 2, vx: 0, vy: 0 };
    let netBall = null;
    let serveAt = performance.now() + 1200;
    let serveDir = ctx.first === 0 ? 1 : -1;
    let over = false;
    let winner = -1;
    let raf = 0;
    let last = performance.now();
    let lastSend = 0;
    let cpuErr = 0;

    const onPointer = (e) => {
      const r = cv.getBoundingClientRect();
      target = ((e.clientY - r.top) / r.height) * H;
    };
    const onKey = (e) => {
      const down = e.type === "keydown";
      if (e.key === "ArrowUp" || e.key === "w" || e.key === "W") keys.up = down;
      else if (e.key === "ArrowDown" || e.key === "s" || e.key === "S") keys.down = down;
      else return;
      e.preventDefault();
    };
    cv.addEventListener("pointermove", onPointer);
    cv.addEventListener("pointerdown", onPointer);
    addEventListener("keydown", onKey);
    addEventListener("keyup", onKey);
    ctx.status(`You're on the ${me === 0 ? "left" : "right"}. First to ${WIN}.`);

    function physics(dt, now) {
      if (over) return;
      if (now < serveAt) { ball = { x: W / 2, y: H / 2, vx: 0, vy: 0 }; return; }
      if (!ball.vx) {
        const a = rand(-0.45, 0.45);
        ball.vx = Math.cos(a) * SPEED0 * serveDir;
        ball.vy = Math.sin(a) * SPEED0;
        cpuErr = rand(-28, 28);
      }
      ball.x += ball.vx * dt;
      ball.y += ball.vy * dt;
      if (ball.y < R) { ball.y = R; ball.vy = Math.abs(ball.vy); }
      if (ball.y > H - R) { ball.y = H - R; ball.vy = -Math.abs(ball.vy); }
      hit(0);
      hit(1);
      if (ball.x < -R * 2) point(1, now);
      else if (ball.x > W + R * 2) point(0, now);
    }

    function hit(side) {
      const face = side === 0 ? X0 + PW : X1;
      const toward = side === 0 ? ball.vx < 0 : ball.vx > 0;
      if (!toward) return;
      const reach = side === 0
        ? ball.x - R <= face && ball.x + R >= X0 - 8
        : ball.x + R >= face && ball.x - R <= X1 + PW + 8;
      if (!reach || Math.abs(ball.y - pad[side]) > PH / 2 + R) return;
      const off = clamp((ball.y - pad[side]) / (PH / 2), -1, 1);
      const speed = Math.min(MAX_SPEED, Math.hypot(ball.vx, ball.vy) * 1.06);
      ball.vx = Math.cos(off * 0.95) * speed * (side === 0 ? 1 : -1);
      ball.vy = Math.sin(off * 0.95) * speed;
      ball.x = side === 0 ? face + R : face - R;
      cpuErr = rand(-30, 30);
    }

    function point(side, now) {
      score[side]++;
      serveDir = side === 0 ? 1 : -1; // serve toward whoever lost the point
      ball = { x: W / 2, y: H / 2, vx: 0, vy: 0 };
      serveAt = now + 900;
      if (score[side] >= WIN) {
        over = true;
        winner = side;
        ctx.end(side);
      }
    }

    function step(now) {
      const dt = Math.min(0.033, (now - last) / 1000);
      last = now;

      if (keys.up || keys.down) {
        pad[me] += (keys.down - keys.up) * 460 * dt;
        target = pad[me];
      } else {
        pad[me] += clamp(target - pad[me], -1100 * dt, 1100 * dt);
      }
      pad[me] = clamp(pad[me], PH / 2, H - PH / 2);

      if (ctx.mode === "cpu") {
        const toward = other === 1 ? ball.vx > 0 : ball.vx < 0;
        pad[other] += clamp((toward ? ball.y + cpuErr : H / 2) - pad[other], -300 * dt, 300 * dt);
      } else {
        pad[other] += (netPad - pad[other]) * (1 - Math.exp(-dt / 0.05));
      }
      pad[other] = clamp(pad[other], PH / 2, H - PH / 2);

      if (sim) {
        physics(dt, now);
      } else if (netBall) {
        const age = Math.min(0.15, (now - netBall.t) / 1000);
        ball.x = netBall.x + netBall.vx * age;
        ball.y = clamp(netBall.y + netBall.vy * age, R, H - R);
      }

      if (ctx.mode === "online" && now - lastSend > 50) {
        lastSend = now;
        const r1 = (v) => Math.round(v * 10) / 10;
        ctx.send(sim
          ? { t: "s", b: [r1(ball.x), r1(ball.y), r1(ball.vx), r1(ball.vy)], p: r1(pad[me]), sc: score, o: over ? winner : undefined }
          : { t: "p", p: r1(pad[me]) });
      }

      draw();
      raf = requestAnimationFrame(step);
    }

    function draw() {
      g.fillStyle = "#05060a";
      g.fillRect(0, 0, W, H);
      g.strokeStyle = "rgba(255,255,255,0.16)";
      g.lineWidth = 3;
      g.setLineDash([8, 12]);
      g.beginPath();
      g.moveTo(W / 2, 12);
      g.lineTo(W / 2, H - 12);
      g.stroke();
      g.setLineDash([]);

      g.textAlign = "center";
      g.fillStyle = "rgba(255,255,255,0.85)";
      g.font = `700 44px ${FONT}`;
      g.fillText(score[0], W / 2 - 70, 58);
      g.fillText(score[1], W / 2 + 70, 58);
      g.font = `700 12px ${FONT}`;
      g.fillStyle = "rgba(255,255,255,0.5)";
      g.fillText("YOU", me === 0 ? W / 2 - 70 : W / 2 + 70, 78);

      for (const side of [0, 1]) {
        g.fillStyle = side === me ? `hsl(${hub.me.hue} 90% 62%)` : "#e8e8f0";
        g.shadowColor = g.fillStyle;
        g.shadowBlur = side === me ? 16 : 0;
        g.beginPath();
        if (g.roundRect) g.roundRect(side === 0 ? X0 : X1, pad[side] - PH / 2, PW, PH, 4);
        else g.rect(side === 0 ? X0 : X1, pad[side] - PH / 2, PW, PH);
        g.fill();
      }
      g.shadowBlur = 0;
      g.fillStyle = "#fff";
      g.beginPath();
      g.arc(ball.x, ball.y, R, 0, Math.PI * 2);
      g.fill();
    }

    raf = requestAnimationFrame(step);

    return {
      onNet(msg) {
        if (sim) {
          const p = msg.t === "p" ? num(msg.p, 0, H) : null;
          if (p !== null) netPad = p;
          return;
        }
        if (msg.t !== "s" || !Array.isArray(msg.b)) return;
        const [x, y, vx, vy] = msg.b.map((v) => num(v, -2000, 2000));
        if ([x, y, vx, vy].includes(null)) return;
        netBall = { x, y, vx, vy, t: performance.now() };
        const p = num(msg.p, 0, H);
        if (p !== null) netPad = p;
        if (Array.isArray(msg.sc)) {
          score[0] = num(msg.sc[0], 0, 99) ?? score[0];
          score[1] = num(msg.sc[1], 0, 99) ?? score[1];
        }
        if (!over && (msg.o === 0 || msg.o === 1)) {
          over = true;
          ctx.end(msg.o);
        }
      },
      destroy() {
        cancelAnimationFrame(raf);
        removeEventListener("keydown", onKey);
        removeEventListener("keyup", onKey);
      },
    };
  }

  // ---------------------------------------------------------------------------
  // Pac-Man. Solo is classic (levels, 3 lives). Online, two Pac-Men share one
  // maze and race for points; the host runs the game and streams it.
  // ---------------------------------------------------------------------------
  function pacmanGame(stage, ctx) {
    const MAP = [
      "###################",
      "#........#........#",
      "#o##.###.#.###.##o#",
      "#.................#",
      "#.##.#.#####.#.##.#",
      "#....#...#...#....#",
      "####.###.#.###.####",
      "   #.#.......#.#   ",
      "####.#.##-##.#.####",
      ".......#GGG#.......",
      "####.#.#####.#.####",
      "   #.#.......#.#   ",
      "####.#.#####.#.####",
      "#........#........#",
      "#.##.###.#.###.##.#",
      "#o.#.....P.....#.o#",
      "##.#.#.#####.#.#.##",
      "#....#...#...#....#",
      "#.######.#.######.#",
      "#.................#",
      "###################",
    ];
    const COLS = 19, ROWS = 21, T = 20, W = COLS * T, H = ROWS * T;
    const DIRS = [[1, 0], [0, 1], [-1, 0], [0, -1]]; // right, down, left, up
    const KEYS = { ArrowRight: 0, d: 0, D: 0, ArrowDown: 1, s: 1, S: 1, ArrowLeft: 2, a: 2, A: 2, ArrowUp: 3, w: 3, W: 3 };
    const STARTS = [[9, 15], [9, 19]];
    const EXIT = [9, 7];
    const HOUSE = [[9, 9], [8, 9], [10, 9], [9, 9]];
    const CORNERS = [[18, -2], [0, -2], [18, 22], [0, 22]];
    const GHOST_COLORS = ["#ff4d4d", "#ffb8ff", "#3ff0ff", "#ffb852"];
    const PAC_COLORS = ["#ffd23f", "#5ee7ff"];
    const online = ctx.mode === "online";
    const sim = ctx.host;

    const wrapX = (x) => (x + COLS) % COLS;
    const tileAt = (x, y) => (y < 0 || y >= ROWS || x < 0 || x >= COLS ? " " : MAP[y][x]);
    const open = (x, y) => ".oP".includes(tileAt(wrapX(x), y));

    const pellets = [];
    const pelletIndex = new Map();
    MAP.forEach((row, y) => [...row].forEach((c, x) => {
      if (c === "." || c === "o") {
        pelletIndex.set(y * COLS + x, pellets.length);
        pellets.push({ x, y, power: c === "o" });
      }
    }));

    stage.innerHTML = '<div class="pac-wrap"><div class="pac-hud"></div><canvas class="pacman"></canvas></div>';
    const hudEl = stage.querySelector(".pac-hud");
    const cv = stage.querySelector("canvas");
    const g = setupCanvas(cv, W, H);

    const wallPath = new Path2D();
    const doorPath = new Path2D();
    MAP.forEach((row, y) => [...row].forEach((c, x) => {
      if (c === "-") {
        doorPath.moveTo(x * T, y * T + T / 2);
        doorPath.lineTo((x + 1) * T, y * T + T / 2);
      }
      if (c !== "#") return;
      if (tileAt(x + 1, y) !== "#") { wallPath.moveTo((x + 1) * T, y * T); wallPath.lineTo((x + 1) * T, (y + 1) * T); }
      if (tileAt(x - 1, y) !== "#") { wallPath.moveTo(x * T, y * T); wallPath.lineTo(x * T, (y + 1) * T); }
      if (tileAt(x, y + 1) !== "#") { wallPath.moveTo(x * T, (y + 1) * T); wallPath.lineTo((x + 1) * T, (y + 1) * T); }
      if (tileAt(x, y - 1) !== "#") { wallPath.moveTo(x * T, y * T); wallPath.lineTo((x + 1) * T, y * T); }
    }));

    // --- simulation state (host / solo) ---
    let present = [];
    let left = 0;
    let level = 1;
    let frightUntil = 0;
    let combo = 0;
    let modeClock = 0;
    let startAt = 0;
    let pauseUntil = 0;
    let over = false;
    let clock = performance.now();
    const pacs = [...Array(online ? 2 : 1)].map((_, i) => ({ i, lives: 3, score: 0, out: false }));
    const ghosts = GHOST_COLORS.map((color, i) => ({ i, color }));

    // --- what gets drawn (built from the sim, or from the host's updates) ---
    let view = null;
    let netView = null;

    function resetPellets() {
      present = pellets.map(() => true);
      left = pellets.length;
    }
    function placePac(pc, now) {
      Object.assign(pc, { x: STARTS[pc.i][0], y: STARTS[pc.i][1], d: -1, nd: -1, p: 0, alive: true, inv: online ? now + 1500 : 0 });
    }
    function homeGhost(gh, now, delay) {
      Object.assign(gh, { x: EXIT[0], y: EXIT[1], d: -1, p: 0, fright: false, releaseAt: now + delay });
    }
    function resetRound(now) {
      pacs.forEach((pc) => { if (!pc.out) placePac(pc, now); });
      ghosts.forEach((gh, i) => homeGhost(gh, now, 1500 + i * 2500));
      frightUntil = 0;
      startAt = now + 1500;
    }

    const posOf = (e) => (e.d >= 0 ? [e.x + DIRS[e.d][0] * e.p, e.y + DIRS[e.d][1] * e.p] : [e.x, e.y]);

    // Move along the grid; turns happen at tile centers.
    function stepEntity(e, dist, choose, arrive) {
      while (dist > 0) {
        if (e.p === 0) {
          choose(e);
          if (e.d < 0) return;
        }
        const need = 1 - e.p;
        if (dist < need) { e.p += dist; return; }
        dist -= need;
        e.x = wrapX(e.x + DIRS[e.d][0]);
        e.y += DIRS[e.d][1];
        e.p = 0;
        arrive?.(e);
      }
    }

    function reverse(e) {
      if (e.d < 0) return;
      if (e.p > 0) {
        e.x = wrapX(e.x + DIRS[e.d][0]);
        e.y += DIRS[e.d][1];
        e.p = 1 - e.p;
      }
      e.d = (e.d + 2) % 4;
    }

    function choosePac(pc) {
      if (pc.nd >= 0 && open(pc.x + DIRS[pc.nd][0], pc.y + DIRS[pc.nd][1])) pc.d = pc.nd;
      if (pc.d >= 0 && !open(pc.x + DIRS[pc.d][0], pc.y + DIRS[pc.d][1])) pc.d = -1;
    }

    function arrivePac(pc) {
      const idx = pelletIndex.get(pc.y * COLS + pc.x);
      if (idx === undefined || !present[idx]) return;
      present[idx] = false;
      left--;
      if (!pellets[idx].power) { pc.score += 10; return; }
      pc.score += 50;
      frightUntil = clock + Math.max(2000, 7000 - (level - 1) * 1000);
      combo = 0;
      ghosts.forEach((gh) => {
        if (clock < gh.releaseAt) return;
        gh.fright = true;
        reverse(gh);
      });
    }

    function nearestPac(gh) {
      let best = null;
      let bestD = Infinity;
      for (const pc of pacs) {
        if (pc.out || !pc.alive) continue;
        const d = (pc.x - gh.x) ** 2 + (pc.y - gh.y) ** 2;
        if (d < bestD) { bestD = d; best = pc; }
      }
      return best;
    }

    // Classic personalities: chase, ambush ahead, flank, and shy.
    function ghostTarget(gh, scatter) {
      const pac = nearestPac(gh);
      if (scatter || !pac) return CORNERS[gh.i];
      const [dx, dy] = pac.d >= 0 ? DIRS[pac.d] : [0, 0];
      if (gh.i === 0) return [pac.x, pac.y];
      if (gh.i === 1) return [pac.x + dx * 4, pac.y + dy * 4];
      if (gh.i === 2) return [pac.x * 2 - ghosts[0].x, pac.y * 2 - ghosts[0].y];
      return (pac.x - gh.x) ** 2 + (pac.y - gh.y) ** 2 > 64 ? [pac.x, pac.y] : CORNERS[gh.i];
    }

    function chooseGhost(gh, scatter) {
      const back = gh.d >= 0 ? (gh.d + 2) % 4 : -1;
      let opts = [3, 2, 1, 0].filter((d) => d !== back && open(gh.x + DIRS[d][0], gh.y + DIRS[d][1]));
      if (!opts.length && back >= 0) opts = [back];
      if (!opts.length) { gh.d = -1; return; }
      if (gh.fright) { gh.d = opts[Math.floor(Math.random() * opts.length)]; return; }
      const [tx, ty] = ghostTarget(gh, scatter);
      let best = opts[0];
      let bestD = Infinity;
      for (const d of opts) {
        const dd = (gh.x + DIRS[d][0] - tx) ** 2 + (gh.y + DIRS[d][1] - ty) ** 2;
        if (dd < bestD) { bestD = dd; best = d; }
      }
      gh.d = best;
    }

    function killPac(pc, now) {
      pc.alive = false;
      pc.lives--;
      pc.respawnAt = now + 1500;
      if (!online) pauseUntil = now + 1500;
    }

    function finish() {
      over = true;
      if (!online) {
        ctx.end(-2, `Game over · ${pacs[0].score.toLocaleString()} points`);
        return;
      }
      const [a, b] = pacs.map((pc) => pc.score);
      ctx.end(a > b ? 0 : b > a ? 1 : -1);
    }

    function update(now, dt) {
      clock = now;
      if (over || now < startAt || now < pauseUntil) return;
      modeClock += dt;
      const scatter = modeClock % 27 < 7;
      if (now >= frightUntil) ghosts.forEach((gh) => { gh.fright = false; });

      for (const pc of pacs) {
        if (pc.out) continue;
        if (!pc.alive) {
          if (now < pc.respawnAt) continue;
          if (pc.lives <= 0) pc.out = true;
          else if (online) placePac(pc, now);
          else { resetRound(now); return; }
          continue;
        }
        stepEntity(pc, 7.2 * dt, choosePac, arrivePac);
      }

      const speed = Math.min(8, 6 + 0.35 * (level - 1));
      for (const gh of ghosts) {
        if (now < gh.releaseAt) continue;
        const tunnel = gh.y === 9 && (gh.x < 3 || gh.x > 15);
        stepEntity(gh, (gh.fright ? 3.8 : speed) * (tunnel ? 0.6 : 1) * dt, (e) => chooseGhost(e, scatter));
      }

      for (const pc of pacs) {
        if (!pc.alive || pc.out || now < pc.inv) continue;
        const [px, py] = posOf(pc);
        for (const gh of ghosts) {
          if (now < gh.releaseAt) continue;
          const [gx, gy] = posOf(gh);
          if (Math.hypot(px - gx, py - gy) > 0.7) continue;
          if (gh.fright) {
            combo++;
            pc.score += 100 * 2 ** combo;
            homeGhost(gh, now, 3000);
          } else {
            killPac(pc, now);
            break;
          }
        }
      }

      if (left === 0) {
        if (online) finish();
        else { level++; resetPellets(); resetRound(now); }
      } else if (pacs.every((pc) => pc.out)) {
        finish();
      }
    }

    function ghostMode(gh, now) {
      if (now < gh.releaseAt) return 3;
      if (!gh.fright) return 0;
      return frightUntil - now < 2000 ? 2 : 1;
    }

    function simView(now) {
      return {
        pacs: pacs.map((pc) => {
          const [x, y] = posOf(pc);
          return { x, y, d: pc.d, alive: pc.alive && !pc.out, lives: pc.lives, score: pc.score, blink: now < pc.inv };
        }),
        ghosts: ghosts.map((gh) => {
          const mode = ghostMode(gh, now);
          const [x, y] = mode === 3 ? HOUSE[gh.i] : posOf(gh);
          return { x, y, d: gh.d, mode };
        }),
        present,
        level,
        ready: now < startAt,
      };
    }

    function maskHex() {
      let s = "";
      for (let i = 0; i < present.length; i += 4) {
        let n = 0;
        for (let j = 0; j < 4; j++) if (present[i + j]) n |= 1 << j;
        s += n.toString(16);
      }
      return s;
    }

    function unmask(hex) {
      const out = [];
      for (let i = 0; i < pellets.length; i++) out.push(!!(parseInt(hex[i >> 2] || "0", 16) & (1 << (i & 3))));
      return out;
    }

    // --- input ---
    function setDir(d) {
      if (sim) pacs[ctx.mySide].nd = d;
      else ctx.send({ t: "d", d });
    }
    const onKey = (e) => {
      const d = KEYS[e.key];
      if (d === undefined) return;
      e.preventDefault();
      setDir(d);
    };
    let swipe = null;
    cv.addEventListener("pointerdown", (e) => { swipe = [e.clientX, e.clientY]; });
    cv.addEventListener("pointermove", (e) => {
      if (!swipe) return;
      const dx = e.clientX - swipe[0];
      const dy = e.clientY - swipe[1];
      if (Math.max(Math.abs(dx), Math.abs(dy)) < 22) return;
      setDir(Math.abs(dx) > Math.abs(dy) ? (dx > 0 ? 0 : 2) : (dy > 0 ? 1 : 3));
      swipe = [e.clientX, e.clientY];
    });
    const onUp = () => { swipe = null; };
    addEventListener("pointerup", onUp);
    addEventListener("keydown", onKey);

    // --- drawing ---
    function drawPac(x, y, d, color, now, moving) {
      const cx = (x + 0.5) * T;
      const cy = (y + 0.5) * T;
      const mouth = moving ? (0.06 + 0.22 * Math.abs(Math.sin(now / 70))) * Math.PI : 0.16 * Math.PI;
      const rot = [0, Math.PI / 2, Math.PI, -Math.PI / 2][d < 0 ? 0 : d];
      g.fillStyle = color;
      g.beginPath();
      g.moveTo(cx, cy);
      g.arc(cx, cy, T * 0.45, rot + mouth, rot + Math.PI * 2 - mouth);
      g.closePath();
      g.fill();
    }

    function drawGhost(gh, now) {
      const cx = (gh.x + 0.5) * T;
      const top = gh.y * T + 2;
      const r = T * 0.45;
      const bottom = (gh.y + 1) * T - 1;
      const flash = gh.mode === 2 && Math.floor(now / 200) % 2;
      g.fillStyle = gh.mode === 1 || (gh.mode === 2 && !flash) ? "#2448ff" : flash ? "#fff" : gh.color;
      g.beginPath();
      g.arc(cx, top + r, r, Math.PI, 0);
      g.lineTo(cx + r, bottom);
      const w = (2 * r) / 3;
      for (let k = 0; k < 3; k++) {
        const x1 = cx + r - k * w;
        g.quadraticCurveTo(x1 - w / 2, bottom - 5, x1 - w, bottom);
      }
      g.closePath();
      g.fill();
      const scared = gh.mode === 1 || gh.mode === 2;
      const [ex, ey] = !scared && gh.d >= 0 ? DIRS[gh.d] : [0, 0];
      for (const s of [-1, 1]) {
        g.fillStyle = scared ? "#ffd1dc" : "#fff";
        g.beginPath();
        g.arc(cx + s * r * 0.4, top + r * 0.9, r * (scared ? 0.14 : 0.28), 0, Math.PI * 2);
        g.fill();
        if (scared) continue;
        g.fillStyle = "#1a2cff";
        g.beginPath();
        g.arc(cx + s * r * 0.4 + ex * 2, top + r * 0.9 + ey * 2, r * 0.14, 0, Math.PI * 2);
        g.fill();
      }
    }

    function draw(now) {
      g.fillStyle = "#000";
      g.fillRect(0, 0, W, H);
      g.strokeStyle = "#3056ff";
      g.lineWidth = 2;
      g.stroke(wallPath);
      g.strokeStyle = "#ffb8ff";
      g.stroke(doorPath);
      if (!view) return;

      const blinkOn = Math.floor(now / 250) % 2;
      g.fillStyle = "#ffd9b3";
      pellets.forEach((pl, i) => {
        if (!view.present[i] || (pl.power && !blinkOn)) return;
        g.beginPath();
        g.arc((pl.x + 0.5) * T, (pl.y + 0.5) * T, pl.power ? 6 : 2.5, 0, Math.PI * 2);
        g.fill();
      });

      view.ghosts.forEach((gh, i) => drawGhost({ ...gh, color: GHOST_COLORS[i] }, now));
      view.pacs.forEach((pc, i) => {
        if (!pc.alive || (pc.blink && Math.floor(now / 120) % 2)) return;
        drawPac(pc.x, pc.y, pc.d, PAC_COLORS[i], now, pc.d >= 0 && !view.ready);
      });

      if (view.ready) {
        g.fillStyle = "#ffd23f";
        g.font = `700 16px ${FONT}`;
        g.textAlign = "center";
        g.fillText("READY!", W / 2, 11 * T + 15);
      }
    }

    let lastHud = "";
    function updateHud() {
      const hearts = (n) => "♥".repeat(Math.max(0, n));
      const text = online
        ? view.pacs.map((pc, i) => `${i === ctx.mySide ? "You" : ctx.names[i]} ${pc.score.toLocaleString()} ${hearts(pc.lives)}`).join("   ·   ")
        : `Score ${view.pacs[0].score.toLocaleString()}   ·   ${hearts(view.pacs[0].lives)}   ·   Level ${view.level}`;
      if (text !== lastHud) { hudEl.textContent = text; lastHud = text; }
    }

    // --- loop ---
    let raf = 0;
    let last = performance.now();
    let lastSend = 0;
    let ended = false;

    function step(now) {
      const dt = Math.min(0.05, (now - last) / 1000);
      last = now;
      if (sim) {
        update(now, dt);
        view = simView(now);
        if (online && now - lastSend > 66) {
          lastSend = now;
          const r2 = (v) => Math.round(v * 100) / 100;
          ctx.send({
            t: "s",
            p: view.pacs.map((pc) => [r2(pc.x), r2(pc.y), pc.d, pc.alive ? 1 : 0, pc.lives, pc.score, pc.blink ? 1 : 0]),
            g: view.ghosts.map((gh) => [r2(gh.x), r2(gh.y), gh.d, gh.mode]),
            m: maskHex(),
            rd: view.ready ? 1 : 0,
            o: over ? 1 : undefined,
          });
        }
      } else if (netView) {
        // Glide toward the host's latest positions (snap on tunnel wraps).
        const k = 1 - Math.exp(-dt / 0.06);
        if (!view) view = structuredClone(netView);
        for (const key of ["pacs", "ghosts"]) {
          netView[key].forEach((t, i) => {
            const v = view[key][i];
            Object.assign(v, { ...t, x: v.x, y: v.y });
            if (Math.abs(t.x - v.x) > 2 || Math.abs(t.y - v.y) > 2) { v.x = t.x; v.y = t.y; }
            else { v.x += (t.x - v.x) * k; v.y += (t.y - v.y) * k; }
          });
        }
        view.present = netView.present;
        view.ready = netView.ready;
      }
      draw(now);
      if (view) updateHud();
      raf = requestAnimationFrame(step);
    }

    if (sim) {
      resetPellets();
      resetRound(performance.now());
    }
    ctx.status(online ? `You're the ${ctx.mySide === 0 ? "yellow" : "blue"} Pac-Man. Most points wins.` : "Eat every dot. Power pellets let you eat ghosts.");
    raf = requestAnimationFrame(step);

    return {
      onNet(msg) {
        if (sim) {
          if (msg.t === "d" && [0, 1, 2, 3].includes(msg.d) && pacs[1]) pacs[1].nd = msg.d;
          return;
        }
        if (msg.t !== "s" || !Array.isArray(msg.p) || !Array.isArray(msg.g) || typeof msg.m !== "string") return;
        const dir = (d) => ([0, 1, 2, 3].includes(d) ? d : -1);
        netView = {
          pacs: msg.p.slice(0, 2).map((a) => ({
            x: num(a[0], -1, COLS) ?? 0, y: num(a[1], 0, ROWS) ?? 0, d: dir(a[2]), alive: a[3] === 1,
            lives: num(a[4], 0, 9) ?? 0, score: num(a[5], 0, 1e7) ?? 0, blink: a[6] === 1,
          })),
          ghosts: msg.g.slice(0, 4).map((a) => ({
            x: num(a[0], -1, COLS) ?? 0, y: num(a[1], 0, ROWS) ?? 0, d: dir(a[2]), mode: num(a[3], 0, 3) ?? 0,
          })),
          present: unmask(msg.m.slice(0, 80)),
          ready: msg.rd === 1,
        };
        if (netView.pacs.length !== 2 || netView.ghosts.length !== 4) { netView = null; return; }
        if (msg.o === 1 && !ended) {
          ended = true;
          const [a, b] = netView.pacs.map((pc) => pc.score);
          ctx.end(a > b ? 0 : b > a ? 1 : -1);
        }
      },
      destroy() {
        cancelAnimationFrame(raf);
        removeEventListener("keydown", onKey);
        removeEventListener("pointerup", onUp);
      },
    };
  }

  renderCabinets();
  hub.onPeers(renderCabinets);
})();
