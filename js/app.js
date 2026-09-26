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

  const ADJECTIVES = ["Swift", "Sunny", "Cosmic", "Quiet", "Brave", "Fuzzy", "Lucky", "Neon", "Clever", "Mellow",
    "Zippy", "Bold", "Gentle", "Witty", "Curious", "Jolly", "Mighty", "Sleepy", "Electric", "Velvet"];
  const ANIMALS = ["Otter", "Fox", "Panda", "Koala", "Falcon", "Lynx", "Penguin", "Gecko", "Moose", "Dolphin",
    "Raccoon", "Owl", "Tiger", "Llama", "Hedgehog", "Narwhal", "Badger", "Sparrow", "Axolotl", "Wombat"];

  const pick = (arr) => arr[Math.floor(Math.random() * arr.length)];
  const randomId = () => Array.from(crypto.getRandomValues(new Uint8Array(6)), (b) => (b % 36).toString(36)).join("") +
    Date.now().toString(36).slice(-4);

  const me = {
    id: randomId(),
    name: `${pick(ADJECTIVES)} ${pick(ANIMALS)}`,
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

  // ---------------------------------------------------------------------------
  // Track my pointer
  // ---------------------------------------------------------------------------
  let clientX = null;
  let clientY = null;
  let dirty = false;

  const clamp01 = (v) => Math.min(1, Math.max(0, v));

  // Position as a fraction of the whole page, so it lines up across screen sizes.
  function pagePos(cx = clientX, cy = clientY) {
    if (cx === null) return { x: null, y: null };
    const doc = document.documentElement;
    return {
      x: clamp01((cx + scrollX) / doc.scrollWidth),
      y: clamp01((cy + scrollY) / doc.scrollHeight),
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
  const nameOf = (v) => (typeof v === "string" ? v.trim().slice(0, 24) : "") || "Someone";

  function upsertPeer(id, msg) {
    const name = nameOf(msg.n);
    const hue = hueOf(msg.h);
    let p = peers.get(id);
    let listChanged = false;

    if (!p) {
      if (peers.size >= MAX_PEERS) return null;
      p = { id, name, hue, el: makeCursor(name, hue, false), tx: null, ty: null, cx: null, cy: null };
      peers.set(id, p);
      listChanged = true;
      if (Date.now() > discoveryUntil) toast(`${name} joined`, hue);
    } else if (p.name !== name || p.hue !== hue) {
      p.name = name;
      p.hue = hue;
      p.el.querySelector(".tag").textContent = name;
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
    if (announce) toast(`${p.name} left`, p.hue);
    renderPeople();
  }

  setInterval(() => {
    const cutoff = Date.now() - PEER_TIMEOUT_MS;
    for (const p of peers.values()) if (p.seen < cutoff) removePeer(p.id, true);
  }, 2000);

  // Smoothly glide remote cursors toward their latest position.
  function frame() {
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
        p.cx += (p.tx - p.cx) * 0.35;
        p.cy += (p.ty - p.cy) * 0.35;
      }
      const [vx, vy] = toViewport(p.cx, p.cy);
      p.el.style.transform = `translate3d(${vx}px, ${vy}px, 0)`;
      p.el.classList.add("visible");
    }
    requestAnimationFrame(frame);
  }
  requestAnimationFrame(frame);

  // Pick a color far from everyone else's once we know who's here.
  function avoidColorClash() {
    const hues = [...peers.values()].map((p) => p.hue);
    const dist = (a, b) => { const d = Math.abs(a - b) % 360; return Math.min(d, 360 - d); };
    const minDist = (h) => hues.reduce((m, o) => Math.min(m, dist(h, o)), 360);
    if (!hues.length || minDist(me.hue) >= 30) return;
    let best = me.hue;
    for (let h = 0; h < 360; h += 5) if (minDist(h) > minDist(best)) best = h;
    me.hue = best;
    myCursor.style.setProperty("--h", best);
    renderPeople();
    publish("s");
  }

  // ---------------------------------------------------------------------------
  // UI: online count, people list, toasts, ripples
  // ---------------------------------------------------------------------------
  function renderPeople() {
    animateCount($("online-count"), peers.size + 1);
    const list = $("people-list");
    list.textContent = "";
    const all = [{ ...me, isMe: true }, ...[...peers.values()].sort((a, b) => a.name.localeCompare(b.name))];
    const SHOW = 30;
    for (const p of all.slice(0, SHOW)) {
      const li = document.createElement("li");
      if (p.isMe) li.className = "is-me";
      li.style.setProperty("--h", p.hue);
      const swatch = document.createElement("span");
      swatch.className = "swatch";
      li.append(swatch, document.createTextNode(p.name));
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

  function publish(t) {
    if (!client || !client.connected) return;
    const { x, y } = pagePos();
    const msg = t === "l" ? { t } : { t, n: me.name, h: me.hue, x, y };
    client.publish(`${TOPIC}/${me.id}`, JSON.stringify(msg), { qos: 0 });
    lastSent = Date.now();
  }

  // Someone new said hello: tell them we're here (with jitter so we don't all reply at once).
  function scheduleAnnounce() {
    if (announceTimer) return;
    announceTimer = setTimeout(() => { announceTimer = null; publish("s"); }, 100 + Math.random() * 400);
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
        if (!err) publish("h");
      });
      setTimeout(avoidColorClash, DISCOVERY_MS - 500);
    });
    client.on("reconnect", () => setStatus("connecting", "Reconnecting…"));
    client.on("offline", () => setStatus("offline", "Offline, retrying…"));
    client.on("error", () => {});

    client.on("message", (topic, payload) => {
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

  addEventListener("pagehide", () => publish("l"));
  addEventListener("pageshow", (e) => {
    if (!e.persisted || !client) return;
    if (client.connected) publish("h");
    else client.reconnect();
  });

  // ---------------------------------------------------------------------------
  // Visit counters (Abacus free counter API, with live SSE updates)
  // ---------------------------------------------------------------------------
  const storage = (store, key, value) => {
    try {
      if (value === undefined) return store.getItem(key);
      store.setItem(key, value);
    } catch { return null; }
  };

  async function counter(action, key) {
    const res = await fetch(`${cfg.COUNTER_API}/${action}/${SITE_ID}/${key}`);
    if (!res.ok) throw new Error(`${action} ${key}: ${res.status}`);
    return (await res.json()).value;
  }

  async function trackCounter(key, elId, shouldHit) {
    const el = $(elId);
    try {
      let value;
      if (shouldHit) value = await counter("hit", key);
      else value = await counter("get", key).catch(() => counter("hit", key));
      animateCount(el, value);
    } catch {
      el.textContent = "?";
      return;
    }
    if (!window.EventSource) return;
    const es = new EventSource(`${cfg.COUNTER_API}/stream/${SITE_ID}/${key}`);
    es.onmessage = (e) => {
      try {
        const v = JSON.parse(e.data).value;
        if (Number.isFinite(v)) animateCount(el, v);
      } catch { /* ignore bad frames */ }
    };
  }

  // A "visit" is counted once per browser tab session; a "visitor" once per browser.
  const visitKey = `visitme:${SITE_ID}:visit`;
  const visitorKey = `visitme:${SITE_ID}:visitor`;
  const newVisit = !storage(sessionStorage, visitKey);
  const newVisitor = !storage(localStorage, visitorKey);
  storage(sessionStorage, visitKey, "1");
  storage(localStorage, visitorKey, "1");

  trackCounter("visits", "visit-count", newVisit);
  trackCounter("visitors", "visitor-count", newVisitor);

  renderPeople();
  connect();
})();
