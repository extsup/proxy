const https = require("https");
const http = require("http");
const { URL } = require("url");
const sharp = require("sharp");

const CUSTOM_REFERERS = {
  "komikcast":   "https://v1.komikcast.fit",
  "shngm":       "https://b.shinigami.asia",
  "softkomik":   "https://softkomik.co",
  "softdevices": "https://softkomik.co",
  "komiku":      "https://komiku.cc",
};

const MAX_HEIGHT = 1500;

module.exports = async (req, res) => {
  if (req.method !== "GET") return send(res, 405, { error: "Method Not Allowed" });

  const { url, w, h, q, ...rest } = req.query || {};
  if (!url) return send(res, 400, { error: "Missing 'url' parameter" });

  let imageUrl = decodeURIComponent(url);
  const extraParams = Object.entries(rest).map(([k, v]) => `${k}=${v}`).join("&");
  if (extraParams) imageUrl += (imageUrl.includes("?") ? "&" : "?") + extraParams;

  let parsed;
  try { parsed = new URL(imageUrl); }
  catch { return send(res, 400, { error: "URL gambar tidak valid" }); }

  if (parsed.pathname.includes("/_next/image")) {
    const innerUrl = parsed.searchParams.get("url");
    if (innerUrl) {
      imageUrl = decodeURIComponent(innerUrl);
      try { parsed = new URL(imageUrl); }
      catch { return send(res, 400, { error: "URL gambar tidak valid" }); }
    }
  }

  if (!["http:", "https:"].includes(parsed.protocol))
    return send(res, 400, { error: "Protocol tidak didukung" });

  const width   = w ? parseInt(w, 10) : null;
  const height  = h ? parseInt(h, 10) : null;
  const quality = Math.min(100, Math.max(10, parseInt(q || "85", 10)));

  let imageReferer = null;
  for (const [key, val] of Object.entries(CUSTOM_REFERERS)) {
    if (parsed.hostname.includes(key)) { imageReferer = val; break; }
  }

  let data;
  try {
    ({ data } = await fetchImage(imageUrl, imageReferer));
  } catch (e) {
    return send(res, 502, { error: `Gagal fetch gambar: ${e.message}`, referer: imageReferer, url: imageUrl });
  }

  let metadata;
  try { metadata = await sharp(data).metadata(); }
  catch { return send(res, 502, { error: "Gagal membaca dimensi gambar" }); }

  if (metadata.height > MAX_HEIGHT)
    return send(res, 403, { error: `Gambar terlalu tinggi (${metadata.height}px), kemungkinan halaman komik` });

  let output;
  try {
    output = await sharp(data)
      .resize(width, height, { fit: "inside", withoutEnlargement: true })
      .webp({ quality })
      .toBuffer();
  } catch { return send(res, 502, { error: "Gagal memproses gambar" }); }

  res.setHeader("Content-Type", "image/webp");
  res.setHeader("Cache-Control", "public, max-age=86400");
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.status(200).send(output);
};

function fetchImage(url, referer) {
  return new Promise((resolve, reject) => {
    const lib = url.startsWith("https") ? https : http;
    const chunks = [];
    const headers = {
      "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
      "Accept": "image/avif,image/webp,image/apng,image/*,*/*;q=0.8",
    };
    if (referer) headers["Referer"] = referer;

    lib.get(url, { headers, timeout: 10000 }, (res) => {
      if ([301, 302, 307, 308].includes(res.statusCode) && res.headers.location)
        return fetchImage(res.headers.location, referer).then(resolve).catch(reject);
      if (res.statusCode !== 200)
        return reject(new Error(`HTTP ${res.statusCode}`));
      res.on("data", c => chunks.push(c));
      res.on("end", () => resolve({ data: Buffer.concat(chunks) }));
      res.on("error", reject);
    })
    .on("error", reject)
    .on("timeout", function() { this.destroy(); reject(new Error("Timeout")); });
  });
}

function send(res, status, body) {
  res.setHeader("Content-Type", "application/json");
  res.status(status).json(body);
}