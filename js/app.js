(() => {
  "use strict";

  const cfg = window.SITE_CONFIG;
  // Local testing uses its own space so it never inflates the real counts.
  const isLocal = /^(localhost|127\.0\.0\.1|\[::1\])$/.test(location.hostname) || location.protocol === "file:";
  const SITE_ID = isLocal ? `${cfg.SITE_ID}-dev` : cfg.SITE_ID;
  const TOPIC = `visitme/${SITE_ID}/p`;

  const SEND_EVERY_MS = 60;       // max cursor update rate (~16/s)
  const HEARTBEAT_MS = 4000;      // "still here" ping when idle
  const PEER_TIMEOUT_MS = 12000;  // drop peers we haven't heard from
  const DISCOVERY_MS = 2000;      // quiet period after joining (no "joined" toasts)
  const MAX_PEERS = 100;
  const ID_RE = /^[a-z0-9]{8,16}$/;

  const $ = (id) => document.getElementById(id);
  const layer = $("cursor-layer");
  const reduceMotion = matchMedia("(prefers-reduced-motion: reduce)").matches;

  const storage = (store, key, value) => {
    try {
      if (value === undefined) return store.getItem(key);
      if (value === null) store.removeItem(key);
      else store.setItem(key, value);
    } catch { return null; }
  };

  const randomId = () => Array.from(crypto.getRandomValues(new Uint8Array(6)), (b) => (b % 36).toString(36)).join("") +
    Date.now().toString(36).slice(-4);

  // ---------------------------------------------------------------------------
  // Names and badges. Everyone is "Visitor #N", where N is the order they first
  // arrived in. The number is saved in their browser, so it stays theirs.
  // ---------------------------------------------------------------------------
  function badgeFor(v) {
    if (!v) return null;
    if (v === 1) return { icon: "🏆", label: "First visitor" };
    if (v <= 10) return { icon: "💎", label: "Top 10" };
    if (v <= 100) return { icon: "🥇", label: "Top 100" };
    if (v <= 1000) return { icon: "🥈", label: "Top 1,000" };
    if (v <= 10000) return { icon: "🥉", label: "Top 10,000" };
    return { icon: "⭐", label: "Visitor" };
  }

  // The site owner (admin unlocked) wears the crown.
  const OWNER_BADGE = { icon: "👑", label: "Owner" };
  const badgeOf = (p) => (p.owner ? OWNER_BADGE : badgeFor(p.v));
  const nameFor = (p) => (p.owner ? "Owner" : p.v ? `Visitor #${p.v.toLocaleString()}` : "Visitor");
  const iconFor = (p) => badgeOf(p)?.icon || "";
  const labelFor = (p) => [iconFor(p), nameFor(p)].filter(Boolean).join(" ");

  const numberKey = `visitme:${SITE_ID}:number`;
  const storedNumber = Number(storage(localStorage, numberKey));

  const me = {
    id: randomId(),
    v: Number.isInteger(storedNumber) && storedNumber > 0 ? storedNumber : 0,
    owner: false,
    g: "",   // arcade game key, if playing
    gs: "",  // "w" waiting for opponent, "p" playing online, "s" playing solo
    hue: Math.floor(Math.random() * 360),
  };

  // ---------------------------------------------------------------------------
  // Cursor elements
  // ---------------------------------------------------------------------------
  const ARROW = '<svg viewBox="0 0 18 23"><path d="M1.5 1.5 L1.5 19 L6.3 14.6 L9.6 21.5 L12.6 20.2 L9.4 13.4 L16 13.4 Z"/></svg>';

  function makeCursor(label, hue, isMe) {
    const el = document.createElement("div");
    el.className = isMe ? "cursor me" : "cursor";
    el.innerHTML = (isMe ? '<span class="halo"></span>' : "") + ARROW + '<span class="tag"></span>';
    el.querySelector(".tag").textContent = label;
    el.style.setProperty("--h", hue);
    layer.appendChild(el);
    return el;
  }

  const myCursor = makeCursor("You", me.hue, true);

  function renderMe() {
    myCursor.querySelector(".tag").textContent = [iconFor(me), "You"].filter(Boolean).join(" ");
    myCursor.style.setProperty("--h", me.hue);
    const badge = badgeOf(me);
    const box = $("my-badge");
    if (!badge) return;
    box.hidden = false;
    $("my-badge-icon").textContent = badge.icon;
    $("my-badge-number").textContent = me.v ? `#${me.v.toLocaleString()}` : "";
    $("my-badge-label").textContent = badge.label;
  }

  // ---------------------------------------------------------------------------
  // Track my pointer
  // ---------------------------------------------------------------------------
  let clientX = null;
  let clientY = null;
  let dirty = false;

  const clamp01 = (v) => Math.min(1, Math.max(0, v));

  // Position as a fraction of the whole page, so it lines up across screen sizes.
  function pagePos() {
    if (clientX === null) return { x: null, y: null };
    const doc = document.documentElement;
    return {
      x: clamp01((clientX + scrollX) / doc.scrollWidth),
      y: clamp01((clientY + scrollY) / doc.scrollHeight),
    };
  }

  function toViewport(x, y) {
    const doc = document.documentElement;
    return [x * doc.scrollWidth - scrollX, y * doc.scrollHeight - scrollY];
  }

  addEventListener("pointermove", (e) => {
    clientX = e.clientX;
    clientY = e.clientY;
    dirty = true;
    if (e.pointerType === "mouse" || e.pointerType === "pen") {
      document.documentElement.classList.add("custom-cursor");
      myCursor.style.transform = `translate3d(${clientX}px, ${clientY}px, 0)`;
      myCursor.classList.add("visible");
      myCursor.classList.toggle("hover", !!e.target.closest?.("a, button"));
    }
  }, { passive: true });

  addEventListener("pointerdown", (e) => {
    clientX = e.clientX;
    clientY = e.clientY;
    if (document.body.classList.contains("arcade-open")) return;
    const { x, y } = pagePos();
    ripple(x, y, me.hue);
    publish("c");
  }, { passive: true });

  // Touch: hide our cursor for others shortly after the finger lifts.
  const endTouch = (e) => {
    if (e.pointerType !== "touch") return;
    setTimeout(() => { clientX = clientY = null; dirty = true; }, 1200);
  };
  addEventListener("pointerup", endTouch, { passive: true });
  addEventListener("pointercancel", endTouch, { passive: true });

  // Mouse left the window.
  document.addEventListener("mouseout", (e) => {
    if (e.relatedTarget) return;
    clientX = clientY = null;
    dirty = true;
    myCursor.classList.remove("visible");
  });

  addEventListener("scroll", () => { if (clientX !== null) dirty = true; }, { passive: true });

  document.addEventListener("visibilitychange", () => {
    if (document.hidden) {
      clientX = clientY = null;
      myCursor.classList.remove("visible");
    }
    publish("s");
  });

  // ---------------------------------------------------------------------------
  // Peers
  // ---------------------------------------------------------------------------
  const peers = new Map();
  let discoveryUntil = Infinity;

  const num01 = (v) => (typeof v === "number" && v >= 0 && v <= 1 ? v : null);
  const hueOf = (v) => (Number.isFinite(v) ? ((Math.round(v) % 360) + 360) % 360 : 0);
  const numberOf = (v) => (Number.isInteger(v) && v > 0 && v < 1e9 ? v : 0);

  function upsertPeer(id, msg) {
    const v = numberOf(msg.v);
    const owner = msg.o === 1;
    const g = typeof msg.g === "string" && /^[a-z0-9]{1,12}$/.test(msg.g) ? msg.g : "";
    const gs = g && ["w", "p", "s"].includes(msg.gs) ? msg.gs : "";
    const hue = hueOf(msg.h);
    let p = peers.get(id);
    let listChanged = false;

    if (!p) {
      if (peers.size >= MAX_PEERS) return null;
      p = { id, v, owner, g, gs, hue, tx: null, ty: null, cx: null, cy: null };
      p.el = makeCursor(labelFor(p), hue, false);
      peers.set(id, p);
      listChanged = true;
      if (Date.now() > discoveryUntil) toast(`${labelFor(p)} joined`, hue);
    } else if (p.v !== v || p.owner !== owner || p.g !== g || p.gs !== gs || p.hue !== hue) {
      Object.assign(p, { v, owner, g, gs, hue });
      p.el.querySelector(".tag").textContent = labelFor(p);
      p.el.style.setProperty("--h", hue);
      listChanged = true;
    }

    p.tx = num01(msg.x);
    p.ty = p.tx === null ? null : num01(msg.y);
    if (p.ty === null) p.tx = null;
    p.seen = Date.now();

    if (listChanged) renderPeople();
    return p;
  }

  function removePeer(id, announce) {
    const p = peers.get(id);
    if (!p) return;
    p.el.remove();
    peers.delete(id);
    if (announce) toast(`${labelFor(p)} left`, p.hue);
    renderPeople();
  }

  setInterval(() => {
    const cutoff = Date.now() - PEER_TIMEOUT_MS;
    for (const p of peers.values()) if (p.seen < cutoff) removePeer(p.id, true);
  }, 2000);

  // Smoothly glide remote cursors toward their latest position. The blend is
  // time-based, so it looks the same at any frame rate.
  const SMOOTHING_MS = 55;
  let lastFrame = performance.now();

  function frame(now) {
    const k = 1 - Math.exp(-Math.min(100, now - lastFrame) / SMOOTHING_MS);
    lastFrame = now;
    for (const p of peers.values()) {
      if (p.tx === null) {
        p.el.classList.remove("visible");
        p.cx = null;
        continue;
      }
      if (p.cx === null) {
        p.cx = p.tx;
        p.cy = p.ty;
      } else {
        p.cx += (p.tx - p.cx) * k;
        p.cy += (p.ty - p.cy) * k;
      }
      const [vx, vy] = toViewport(p.cx, p.cy);
      p.el.style.transform = `translate3d(${vx}px, ${vy}px, 0)`;
      p.el.classList.add("visible");
    }
    requestAnimationFrame(frame);
  }
  requestAnimationFrame(frame);

  // Colors: pick the hue furthest from everyone else's.
  const hueDist = (a, b) => { const d = Math.abs(a - b) % 360; return Math.min(d, 360 - d); };
  const minHueDist = (h, taken) => taken.reduce((m, o) => Math.min(m, hueDist(h, o)), 360);
  function bestHue(taken, start = Math.floor(Math.random() * 360)) {
    let best = start;
    for (let i = 0; i < 360; i += 5) {
      const h = (start + i) % 360;
      if (minHueDist(h, taken) > minHueDist(best, taken)) best = h;
    }
    return best;
  }

  function avoidColorClash() {
    const taken = [...peers.values()].map((p) => p.hue);
    if (!taken.length || minHueDist(me.hue, taken) >= 30) return;
    me.hue = bestHue(taken, me.hue);
    renderMe();
    renderPeople();
    publish("s");
  }

  // ---------------------------------------------------------------------------
  // UI: online count, people list, toasts, ripples
  // ---------------------------------------------------------------------------
  function renderPeople() {
    const others = [...peers.values()];
    animateCount($("online-count"), others.length + 1);

    others.sort((a, b) => (b.owner - a.owner) || ((a.v || Infinity) - (b.v || Infinity)));
    const all = [{ ...me, isMe: true }, ...others];
    const list = $("people-list");
    list.textContent = "";
    const SHOW = 30;
    for (const p of all.slice(0, SHOW)) {
      const li = document.createElement("li");
      if (p.isMe) li.className = "is-me";
      li.style.setProperty("--h", p.hue);
      const badge = badgeOf(p);
      if (badge) li.title = badge.label;
      const swatch = document.createElement("span");
      swatch.className = "swatch";
      li.append(swatch, document.createTextNode(labelFor(p)));
      if (p.isMe) {
        const you = document.createElement("span");
        you.className = "you";
        you.textContent = "you";
        li.append(you);
      }
      list.append(li);
    }
    if (all.length > SHOW) {
      const li = document.createElement("li");
      li.textContent = `+${all.length - SHOW} more`;
      list.append(li);
    }
    updatePanel();
    peerListeners.forEach((fn) => fn());
  }

  function toast(text, hue) {
    const box = $("toasts");
    const el = document.createElement("div");
    el.className = "toast";
    el.style.setProperty("--h", hue);
    const swatch = document.createElement("span");
    swatch.className = "swatch";
    el.append(swatch, document.createTextNode(text));
    box.append(el);
    while (box.children.length > 4) box.firstChild.remove();
    setTimeout(() => { el.classList.add("out"); setTimeout(() => el.remove(), 400); }, 3500);
  }

  function ripple(x, y, hue) {
    if (x === null || y === null) return;
    const [vx, vy] = toViewport(x, y);
    const el = document.createElement("div");
    el.className = "ripple";
    el.style.setProperty("--h", hue);
    el.style.setProperty("--pos", `translate(${vx}px, ${vy}px)`);
    layer.append(el);
    el.addEventListener("animationend", () => el.remove());
  }

  function animateCount(el, target) {
    const from = Number(el.dataset.value);
    el.dataset.value = target;
    if (reduceMotion || !Number.isFinite(from) || from === target) {
      el.textContent = target.toLocaleString();
      return;
    }
    const start = performance.now();
    const step = (now) => {
      const t = Math.min(1, (now - start) / 600);
      const eased = 1 - Math.pow(1 - t, 3);
      el.textContent = Math.round(from + (target - from) * eased).toLocaleString();
      if (t < 1 && el.dataset.value == target) requestAnimationFrame(step);
    };
    requestAnimationFrame(step);
  }

  function setStatus(state, text) {
    $("status").dataset.state = state;
    $("status-text").textContent = text;
  }

  $("invite").addEventListener("click", async (e) => {
    const btn = e.currentTarget;
    const original = btn.textContent;
    try {
      await navigator.clipboard.writeText(location.href);
      btn.textContent = "Link copied!";
    } catch {
      btn.textContent = "Copy the address bar link";
    }
    setTimeout(() => { btn.textContent = original; }, 2000);
  });

  // ---------------------------------------------------------------------------
  // Realtime connection (public MQTT broker over WebSockets)
  // ---------------------------------------------------------------------------
  let client = null;
  let lastSent = 0;
  let announceTimer = null;

  function send(id, msg) {
    if (!client || !client.connected) return false;
    client.publish(`${TOPIC}/${id}`, JSON.stringify(msg), { qos: 0 });
    return true;
  }

  function publish(t) {
    const { x, y } = pagePos();
    if (send(me.id, t === "l" ? { t } : { t, v: me.v || undefined, o: me.owner ? 1 : undefined, g: me.g || undefined, gs: me.gs || undefined, h: me.hue, x, y })) lastSent = Date.now();
  }

  // Someone new said hello: tell them we're here (with jitter so we don't all reply at once).
  function scheduleAnnounce() {
    if (announceTimer) return;
    announceTimer = setTimeout(() => {
      announceTimer = null;
      publish("s");
      bots.forEach((b) => sendBot(b, "s"));
    }, 100 + Math.random() * 400);
  }

  setInterval(() => {
    if (dirty || Date.now() - lastSent > HEARTBEAT_MS) {
      dirty = false;
      publish("s");
    }
  }, SEND_EVERY_MS);

  function connect() {
    if (!window.mqtt) {
      setStatus("offline", "Live cursors unavailable");
      return;
    }
    client = window.mqtt.connect(cfg.MQTT_URL, {
      clientId: `visitme_${me.id}`,
      clean: true,
      keepalive: 30,
      reconnectPeriod: 3000,
      connectTimeout: 10000,
      will: { topic: `${TOPIC}/${me.id}`, payload: JSON.stringify({ t: "l" }), qos: 0, retain: false },
    });

    client.on("connect", () => {
      setStatus("live", "Live");
      discoveryUntil = Date.now() + DISCOVERY_MS;
      client.subscribe(`${TOPIC}/+`, { qos: 0 }, (err) => {
        if (err) return;
        publish("h");
        bots.forEach((b) => sendBot(b, "h"));
      });
      for (const t of topicHandlers.keys()) client.subscribe(t, { qos: 0 });
      setTimeout(avoidColorClash, DISCOVERY_MS - 500);
    });
    client.on("reconnect", () => setStatus("connecting", "Reconnecting…"));
    client.on("offline", () => setStatus("offline", "Offline, retrying…"));
    client.on("error", () => {});

    client.on("message", (topic, payload) => {
      // Other features (the arcade) listen on their own topics.
      if (!topic.startsWith(`${TOPIC}/`)) {
        const fn = topicHandlers.get(topic);
        if (!fn || payload.length > 2048) return;
        let msg;
        try { msg = JSON.parse(payload.toString()); } catch { return; }
        if (msg && typeof msg === "object") fn(msg);
        return;
      }
      if (payload.length > 512) return;
      const id = topic.slice(TOPIC.length + 1);
      if (id === me.id || !ID_RE.test(id)) return;
      let msg;
      try { msg = JSON.parse(payload.toString()); } catch { return; }
      if (!msg || typeof msg !== "object") return;

      if (msg.t === "l") return removePeer(id, true);
      if (msg.t !== "h" && msg.t !== "s" && msg.t !== "c") return;
      const p = upsertPeer(id, msg);
      if (!p) return;
      if (msg.t === "h") scheduleAnnounce();
      if (msg.t === "c") ripple(p.tx, p.ty, p.hue);
    });
  }

  addEventListener("pagehide", () => {
    publish("l");
    bots.forEach((b) => sendBot(b, "l"));
  });
  addEventListener("pageshow", (e) => {
    if (!e.persisted || !client) return;
    if (client.connected) {
      publish("h");
      bots.forEach((b) => sendBot(b, "h"));
    } else {
      client.reconnect();
    }
  });

  // ---------------------------------------------------------------------------
  // Owner-only cursor bots. Open the site once with your #admin=<key> link to
  // unlock. Bots run in your tab (while it's open) and look like regular visitors.
  // ---------------------------------------------------------------------------
  const ADMIN_STORE = `visitme:${cfg.SITE_ID}:admin`;
  const MAX_BOTS = 8;
  const bots = [];
  let panel = null;

  async function sha256(text) {
    const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
    return Array.from(new Uint8Array(buf), (b) => b.toString(16).padStart(2, "0")).join("");
  }

  async function isAdmin() {
    const fromUrl = location.hash.match(/^#admin=(.+)$/)?.[1];
    // Hide the key from the address bar so it isn't copied with the invite link.
    if (fromUrl) history.replaceState(null, "", location.pathname + location.search);
    if (!cfg.ADMIN_HASH || !crypto.subtle) return false;
    const key = fromUrl ? decodeURIComponent(fromUrl) : storage(localStorage, ADMIN_STORE);
    if (!key || (await sha256(key)) !== cfg.ADMIN_HASH) return false;
    storage(localStorage, ADMIN_STORE, key);
    return true;
  }

  const rand = (min, max) => min + Math.random() * (max - min);

  function sendBot(b, t) {
    if (!b.ready) return;
    if (send(b.id, t === "l" ? { t } : { t, v: b.v, h: b.hue, x: b.x, y: b.y })) b.lastSent = Date.now();
  }

  // A random visitor number nobody on the page is using (never #1, the trophy).
  function randomVisitorNumber() {
    const used = new Set([me.v, ...[...peers.values()].map((p) => p.v), ...bots.map((b) => b.v)]);
    // Prefer numbers within the real visitor count so they look believable.
    for (let i = 0; i < 100 && visitorTotal > 1; i++) {
      const v = 2 + Math.floor(Math.random() * (visitorTotal - 1));
      if (!used.has(v)) return v;
    }
    let v = Math.max(visitorTotal, 1) + 1;
    while (used.has(v)) v++;
    return v;
  }

  // Each bot arrives like a new visitor: it adds to the visitor and visit
  // totals and takes the next visitor number. A separate tally remembers how
  // many visitors were bots, so the owner can still tell the real count.
  const BOT_TALLY = "bot-visitors";
  let botTally = null;

  async function addBot() {
    if (bots.length >= MAX_BOTS) return;
    const taken = [me.hue, ...[...peers.values()].map((p) => p.hue), ...bots.map((b) => b.hue)];
    const b = {
      id: randomId(), v: 0, hue: bestHue(taken), ready: false,
      x: rand(0.1, 0.9), y: rand(0.1, 0.9), path: null, waitUntil: 0, lastSent: 0,
    };
    bots.push(b);
    updatePanel();
    try {
      b.v = await counter("hit", "visitors");
      counter("hit", "visits").catch(() => {});
      counter("hit", BOT_TALLY).then((n) => { botTally = n; updatePanel(); }, () => {});
    } catch {
      b.v = randomVisitorNumber();
    }
    if (!bots.includes(b)) return;
    b.ready = true;
    sendBot(b, "h");
  }

  function removeBot(b = bots[bots.length - 1]) {
    if (!b) return;
    bots.splice(bots.indexOf(b), 1);
    sendBot(b, "l");
    updatePanel();
  }

  // Background tabs slow timers to once a second (or less), which would make
  // bots stutter or vanish. Timers inside a Worker keep full speed.
  function startTicker(ms, fn) {
    try {
      const src = `setInterval(() => postMessage(0), ${ms});`;
      new Worker(URL.createObjectURL(new Blob([src], { type: "text/javascript" }))).onmessage = fn;
    } catch {
      setInterval(fn, ms);
    }
  }

  const easeInOut = (t) => (t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2);

  // Plan a gently curved glide to a random spot; longer trips take longer.
  function planMove(b, now) {
    const x1 = rand(0.05, 0.95);
    const y1 = rand(0.08, 0.92);
    const dx = x1 - b.x;
    const dy = y1 - b.y;
    const dist = Math.hypot(dx, dy) || 1e-6;
    const bend = rand(-0.3, 0.3) * dist;
    b.path = {
      x0: b.x, y0: b.y, x1, y1,
      cx: (b.x + x1) / 2 - (dy / dist) * bend,
      cy: (b.y + y1) / 2 + (dx / dist) * bend,
      start: now,
      dur: 450 + dist * rand(1300, 2300),
    };
  }

  // Wander: glide somewhere, pause, sometimes click, repeat.
  function tickBots() {
    const now = Date.now();
    for (const b of bots) {
      if (!b.ready) continue;
      if (!b.path) {
        if (now < b.waitUntil) {
          if (now - b.lastSent > HEARTBEAT_MS) sendBot(b, "s");
          continue;
        }
        planMove(b, now);
      }
      const { x0, y0, cx, cy, x1, y1, start, dur } = b.path;
      const t = Math.min(1, (now - start) / dur);
      const e = easeInOut(t);
      const u = 1 - e;
      b.x = clamp01(u * u * x0 + 2 * u * e * cx + e * e * x1);
      b.y = clamp01(u * u * y0 + 2 * u * e * cy + e * e * y1);
      sendBot(b, "s");
      if (t >= 1) {
        b.path = null;
        if (Math.random() < 0.3) sendBot(b, "c");
        b.waitUntil = now + (Math.random() < 0.25 ? rand(0, 250) : rand(500, 2600));
      }
    }
  }
  startTicker(SEND_EVERY_MS, tickBots);

  function updatePanel() {
    if (!panel) return;
    panel.querySelector(".admin-count").textContent = `${bots.length}/${MAX_BOTS}`;
    panel.querySelector('[data-act="add"]').disabled = bots.length >= MAX_BOTS;
    panel.querySelector('[data-act="remove"]').disabled = !bots.length;
    panel.querySelector('[data-act="clear"]').disabled = !bots.length;
    panel.querySelector(".admin-note").textContent = botTally === null ? "" :
      `${botTally.toLocaleString()} bot visitors so far · ${Math.max(0, visitorTotal - botTally).toLocaleString()} real`;
  }

  function showPanel() {
    panel = document.createElement("div");
    panel.className = "admin";
    panel.innerHTML = `
      <div class="admin-title">Cursor bots <span class="admin-count"></span></div>
      <div class="admin-row">
        <button type="button" data-act="add">+ Add</button>
        <button type="button" data-act="remove">− Remove</button>
        <button type="button" data-act="clear">Clear</button>
      </div>
      <div class="admin-note"></div>
      <button type="button" class="admin-lock" data-act="lock">Lock admin</button>`;
    counter("get", BOT_TALLY).then((n) => { botTally = n; }, () => { botTally = 0; }).then(updatePanel);
    panel.addEventListener("click", (e) => {
      const act = e.target.closest("button")?.dataset.act;
      if (act === "add") addBot();
      if (act === "remove") removeBot();
      if (act === "clear" || act === "lock") while (bots.length) removeBot();
      if (act === "lock") {
        storage(localStorage, ADMIN_STORE, null);
        panel.remove();
        panel = null;
        document.body.classList.remove("has-admin");
        setOwner(false);
      }
    });
    document.body.append(panel);
    updatePanel();
    hidePanel(storage(localStorage, PANEL_HIDDEN_STORE) === "1");
    setOwner(true);
  }

  // Shift+B hides/shows the panel; bots keep running and you stay the owner.
  const PANEL_HIDDEN_STORE = `visitme:${cfg.SITE_ID}:panel-hidden`;

  function hidePanel(hide) {
    if (!panel) return;
    panel.hidden = hide;
    document.body.classList.toggle("has-admin", !hide);
    storage(localStorage, PANEL_HIDDEN_STORE, hide ? "1" : null);
  }

  addEventListener("keydown", (e) => {
    if (!panel || !e.shiftKey || e.metaKey || e.ctrlKey || e.altKey || e.key.toLowerCase() !== "b") return;
    if (e.target.closest?.("input, textarea, [contenteditable]")) return;
    hidePanel(!panel.hidden);
  });

  function setOwner(on) {
    me.owner = on;
    renderMe();
    renderPeople();
    publish("s");
  }

  const unlock = () => isAdmin().then((ok) => { if (ok && !panel) showPanel(); });
  unlock();
  // Pasting the admin link into a tab already on the site only changes the #hash.
  addEventListener("hashchange", () => { if (location.hash.startsWith("#admin=")) unlock(); });

  // ---------------------------------------------------------------------------
  // Visit counters (Abacus free counter API, with live SSE updates)
  // ---------------------------------------------------------------------------
  async function counter(action, key) {
    const res = await fetch(`${cfg.COUNTER_API}/${action}/${SITE_ID}/${key}`);
    if (!res.ok) throw new Error(`${action} ${key}: ${res.status}`);
    return (await res.json()).value;
  }

  let visitorTotal = 0;

  async function trackCounter(key, elId, shouldHit, onHit) {
    const el = $(elId);
    try {
      let value;
      if (shouldHit) {
        value = await counter("hit", key);
        onHit?.(value);
      } else {
        value = await counter("get", key).catch(() => counter("hit", key));
      }
      animateCount(el, value);
      if (key === "visitors") { visitorTotal = value; updatePanel(); }
    } catch {
      el.textContent = "?";
      return;
    }
    if (!window.EventSource) return;
    const es = new EventSource(`${cfg.COUNTER_API}/stream/${SITE_ID}/${key}`);
    es.onmessage = (e) => {
      try {
        const v = JSON.parse(e.data).value;
        if (!Number.isFinite(v)) return;
        animateCount(el, v);
        if (key === "visitors") { visitorTotal = v; updatePanel(); }
      } catch { /* ignore bad frames */ }
    };
  }

  // A "visit" counts once per browser tab session. A new visitor's count
  // becomes their permanent visitor number.
  const visitKey = `visitme:${SITE_ID}:visit`;
  const newVisit = !storage(sessionStorage, visitKey);
  storage(sessionStorage, visitKey, "1");

  trackCounter("visits", "visit-count", newVisit);
  trackCounter("visitors", "visitor-count", !me.v, (value) => {
    me.v = value;
    storage(localStorage, numberKey, String(value));
    renderMe();
    renderPeople();
    publish("s");
  });

  // ---------------------------------------------------------------------------
  // Small API for js/arcade.js
  // ---------------------------------------------------------------------------
  const peerListeners = new Set();
  const topicHandlers = new Map();

  window.visitme = {
    me,
    peers,
    labelFor,
    topic: (sub) => `visitme/${SITE_ID}/${sub}`,
    send(topic, msg) {
      if (!client || !client.connected) return false;
      client.publish(topic, JSON.stringify(msg), { qos: 0 });
      return true;
    },
    subscribe(topic, fn) {
      topicHandlers.set(topic, fn);
      if (client && client.connected) client.subscribe(topic, { qos: 0 });
    },
    unsubscribe(topic) {
      topicHandlers.delete(topic);
      if (client && client.connected) client.unsubscribe(topic);
    },
    setActivity(g, gs) {
      me.g = g || "";
      me.gs = g ? gs : "";
      renderPeople();
      publish("s");
    },
    onPeers: (fn) => peerListeners.add(fn),
  };

  renderMe();
  renderPeople();
  connect();
})();
