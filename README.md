# visitme

A live website: it shows how many people have visited, who's online right now, and everyone's cursor moving in real time, each in a different color. Your own cursor is bigger, glows, and is labeled **You**.

Every visitor gets a permanent number based on when they first arrived (Visitor #1, #2, …) and a badge to match:

| Badge | Who |
| --- | --- |
| 👑 Owner | you, while your admin panel is unlocked |
| 🏆 First visitor | #1 |
| 💎 Top 10 | #2–10 |
| 🥇 Top 100 | #11–100 |
| 🥈 Top 1,000 | #101–1,000 |
| 🥉 Top 10,000 | #1,001–10,000 |
| ⭐ Visitor | everyone after |

The number is saved in the visitor's browser, so it stays the same on every visit (unless they clear their browser data or use a different device).

No server, no accounts, no build step. It's plain HTML, CSS and JavaScript, so GitHub Pages can host it for free.

## Put it online (GitHub Pages)

1. Push these files to the `main` branch of your GitHub repo.
2. On GitHub, open the repo → **Settings** → **Pages**.
3. Under **Build and deployment**, set **Source** to *Deploy from a branch*, pick **main** and **/ (root)**, then **Save**.
4. After a minute your site is live at `https://<your-username>.github.io/<repo-name>/`.

Open it in two browser windows (or send the link to a friend) to see the live cursors.

### Nicer address

- Rename the repo to `<your-username>.github.io` to get `https://<your-username>.github.io/` with nothing after it.
- Or buy a domain (Namecheap, Cloudflare, Porkbun, …) and add it under **Settings → Pages → Custom domain**. Connecting it is free.

## Arcade

Four cabinets at the bottom of the page: **Pac-Man**, **Pong**, **Tic-Tac-Toe** and **Connect Four**. Click one to play by yourself (against the computer, or classic solo Pac-Man) or against someone else on the site. Online play pairs you with anyone waiting for the same game, and each cabinet shows how many people are playing or waiting. In online Pac-Man, two Pac-Men share one maze and race for the most points.

## Cursor bots (owner only)

Open your private admin link once (it's in `admin-link.txt`, which is never uploaded). A **Cursor bots** panel appears in the corner where you can add up to 8 bots that wander around and click. They look like regular visitors: each new bot counts as a unique visitor and a visit, takes the next visitor number and badge, and counts toward "Online now". The panel shows how many visitors were bots and how many were real. Bots run in your browser tab, so they disappear when you close it. Press **Shift+B** to hide or show the panel; your bots keep running while it's hidden. The panel stays unlocked in that browser until you click **Lock admin**, which also removes your bots.

To change the key, pick a new one, put its SHA-256 hash in `ADMIN_HASH` in `js/config.js`, and use `…/#admin=<new key>`.

## How it works

| Feature | How |
| --- | --- |
| Live cursors + "Online now" | Each visitor sends their cursor position through a free public MQTT broker ([HiveMQ](https://www.hivemq.com/mqtt/public-mqtt-broker/)) over WebSockets. |
| Unique visitors / Total visits | Free counter API ([Abacus](https://jasoncameron.dev/abacus/)). Counts update live. A *visit* counts once per browser tab session; a *visitor* counts once per browser. |
| Visitor numbers | The unique-visitor count at the moment someone first arrives becomes their number. |
| Different colors | Each visitor gets a random color, and picks a new one if it's too close to someone already on the page. |

Settings live in [`js/config.js`](js/config.js). `SITE_ID` keeps your counts and cursors separate from other sites. If you copy this project for a new site, change it.

When you open the site from `localhost`, it uses a separate `-dev` space, so testing doesn't add to your real visitor counts.

## Files

```
index.html     page layout
style.css      styles (dark and light mode)
js/config.js   settings
js/app.js      live cursors, presence and counters
js/arcade.js   arcade cabinets and games
favicon.svg    tab icon
```

## Good to know

- The broker and counter are free public services. Cursor positions, colors and visitor numbers are the only things sent. No personal info is collected.
- After changing `style.css` or anything in `js/`, bump the `?v=` number on those links in `index.html` so visitors get the new version right away.
- Because the broker is public, someone who knows your `SITE_ID` could send fake cursors. The page ignores malformed messages and limits the page to 100 cursors.
