# visitme

A live website: it shows how many people have visited, who's online right now, and everyone's cursor moving in real time, each in a different color. Your own cursor is bigger, glows, and is labeled **You**.

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

## How it works

| Feature | How |
| --- | --- |
| Live cursors + "Online now" | Each visitor sends their cursor position through a free public MQTT broker ([HiveMQ](https://www.hivemq.com/mqtt/public-mqtt-broker/)) over WebSockets. |
| Unique visitors / Total visits | Free counter API ([Abacus](https://jasoncameron.dev/abacus/)). Counts update live. A *visit* counts once per browser tab session; a *visitor* counts once per browser. |
| Different colors | Each visitor gets a random color, and picks a new one if it's too close to someone already on the page. |

Settings live in [`js/config.js`](js/config.js). `SITE_ID` keeps your counts and cursors separate from other sites. If you copy this project for a new site, change it.

When you open the site from `localhost`, it uses a separate `-dev` space, so testing doesn't add to your real visitor counts.

## Files

```
index.html     page layout
style.css      styles (dark and light mode)
js/config.js   settings
js/app.js      live cursors, presence and counters
favicon.svg    tab icon
```

## Good to know

- The broker and counter are free public services. Cursor positions and random names like "Swift Otter" are the only things sent. No personal info is collected.
- Because the broker is public, someone who knows your `SITE_ID` could send fake cursors. The page ignores malformed messages and limits the page to 100 cursors.
