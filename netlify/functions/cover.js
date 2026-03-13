const https = require("https");
const http = require("http");
const { URL } = require("url");
const sharp = require("sharp");

// ── KONFIGURASI ──────────────────────────────────────────────────────────────

const CUSTOM_REFERERS = {
  "komikcast": "https://v1.komikcast.fit",
  "shinigami": "https://b.shinigami.asia",
  "softkomik": "https://softkomik.co",
  "komiku":    "https://komiku.cc",
};

const MAX_HEIGHT = 1500;

// ── HANDLER ──────────────────────────────────────────────────────────────────

exports.handler = async (event) => {
  if (event.httpMethod !== "GET") return err(405, "Method Not Allowed");

  const { url, q, ...rest } = event.queryStringParameters || {};
  if (!url) return err(400, "Missing 'url' parameter");

  let imageUrl = decodeURIComponent(url);
  const extraParams = Object.entries(rest).map(([k, v]) => `${k}=${v}`).join("&");
  if (extraParams) imageUrl += (imageUrl.includes("?") ? "&" : "?") + extraParams;

  let parsed;
  try { parsed = new URL(imageUrl); }
  catch { return err(400, "URL gambar tidak valid"); }

  if (!["http:", "https:"].includes(parsed.protocol)) return err(400, "Protocol tidak didukung");

  const quality = Math.min(100, Math.max(10, parseInt(q || "85", 10)));

  let imageReferer = parsed.origin;
  for (const [key, val] of Object.entries(CUSTOM_REFERERS)) {
    if (parsed.hostname.includes(key)) { imageReferer = val; break; }
  }

  let data, contentType;
  try {
    ({ data, contentType } = await fetchImage(imageUrl, imageReferer));
  } catch (e) {
    return err(502, `Gagal fetch gambar: ${e.message}`);
  }

  let metadata;
  try { metadata = await sharp(data).metadata(); }
  catch { return err(502, "Gagal membaca dimensi gambar"); }

  if (metadata.height > MAX_HEIGHT) {
    return err(403, `Gambar terlalu tinggi (${metadata.height}px), kemungkinan halaman komik`);
  }

  let output;
  try {
    output = await sharp(data)
      .resize(null, MAX_HEIGHT, { fit: "inside", withoutEnlargement: true })
      .webp({ quality })
      .toBuffer();
  } catch { return err(502, "Gagal memproses gambar"); }

  return {
    statusCode: 200,
    headers: {
      "Content-Type": "image/webp",
      "Cache-Control": "no-store",
      "Access-Control-Allow-Origin": "*",
    },
    body: output.toString("base64"),
    isBase64Encoded: true,
  };
};

// ── HELPERS ──────────────────────────────────────────────────────────────────

function fetchImage(url, referer) {
  return new Promise((resolve, reject) => {
    const lib = url.startsWith("https") ? https : http;
    const chunks = [];

    lib.get(url, {
      headers: {
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
        "Referer": referer,
        "Origin": referer,
        "Accept": "image/avif,image/webp,image/apng,image/*,*/*;q=0.8",
        "Accept-Language": "id-ID,id;q=0.9,en-US;q=0.8,en;q=0.7",
        "Sec-Fetch-Dest": "image",
        "Sec-Fetch-Mode": "no-cors",
        "Sec-Fetch-Site": "cross-site",
      },
      timeout: 10000,
    }, (res) => {
      if ([301, 302, 307, 308].includes(res.statusCode) && res.headers.location)
        return fetchImage(res.headers.location, referer).then(resolve).catch(reject);

      if (res.statusCode !== 200)
        return reject(new Error(`HTTP ${res.statusCode}`));

      const contentType = res.headers["content-type"] || "image/jpeg";
      res.on("data", c => chunks.push(c));
      res.on("end", () => resolve({ data: Buffer.concat(chunks), contentType }));
      res.on("error", reject);
    })
    .on("error", reject)
    .on("timeout", function() { this.destroy(); reject(new Error("Timeout")); });
  });
}

function err(status, message) {
  return { statusCode: status, headers: { "Content-Type": "application/json" }, body: JSON.stringify({ error: message }) };
}