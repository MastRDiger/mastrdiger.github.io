// Site settings.
// SITE_ID keeps your visitor counts and live cursors separate from every other
// site using the same free services. Keep it unique (letters, numbers, dashes).
window.SITE_CONFIG = {
  SITE_ID: "mastrdiger-visitme-r7ria65g",

  // Free public MQTT broker that relays live cursor positions between visitors.
  MQTT_URL: "wss://broker.hivemq.com:8884/mqtt",

  // Free counter API (https://jasoncameron.dev/abacus/) for visit totals.
  COUNTER_API: "https://abacus.jasoncameron.dev",

  // SHA-256 of your secret admin key. Open the site with #admin=<key> to get
  // the cursor-bot controls. Your link is in admin-link.txt (not uploaded).
  ADMIN_HASH: "cfcd199ea7203c3726968993bce0b01822371e08cc90da383ca3f3c26045e634",
};
