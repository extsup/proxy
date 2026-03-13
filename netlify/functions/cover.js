const https = require("https");
const http = require("http");
const { URL } = require("url");
const sharp = require("sharp");

// ── KONFIGURASI ──────────────────────────────────────────────────────────────

const ALLOWED_IMAGE_DOMAINS = [
  // Komikcast
  "minio-prod-2.komikcast.to",
  "cdn.komiku.cc",
  "softkomik.co",
];

// Referer yang dikirim saat fetch gambar (per domain)
const REFERERS = {
  "komikcast": "https://v1.komikcast.fit",
  "komiku":    "https://komiku.cc",
  "softkomik": "https://softkomik.co",
};

const MAX_WIDTH  = 600;
const MAX_HEIGHT = 900;

// ── HANDLER ──────────────────────────────────────────────────────────────────

exports.handler = async (event) => {
  if (event.httpMethod !== "GET") return err(405, "Method Not Allowed");

  const { url, w, h, q } = event.queryStringParameters || {};
  if (!url) return err(400, "Missing 'url' parameter");

  const imageUrl = decodeURIComponent(url);

  let parsed;
  try { parsed = new URL(imageUrl); }
  catch { return err(400, "URL tidak valid"); }

  if (!ALLOWED_IMAGE_DOMAINS.some(d => parsed.hostname === d || parsed.hostname.endsWith("." + d))) {
    return err(403, `Domain '${parsed.hostname}' tidak diizinkan`);
  }

  const width   = Math.min(MAX_WIDTH,  parseInt(w || "0", 10));
  const height  = Math.min(MAX_HEIGHT, parseInt(h || "0", 10));
  const quality = Math.min(100, Math.max(10, parseInt(q || "85", 10)));

  // Tentukan referer berdasarkan domain
  let referer = parsed.origin;
  if (parsed.hostname.includes("komikcast")) referer = REFERERS.komikcast;
  if (parsed.hostname.includes("komiku"))    referer = REFERERS.komiku;

  let data, contentType;
  try {
    ({ data, contentType } = await fetchImage(imageUrl, referer));
  } catch (e) {
    return err(502, `Gagal fetch gambar: ${e.message}`);
  }

  let output = data;
  let mime   = contentType || "image/jpeg";

  if (width > 0 || height > 0) {
    try {
      output = await sharp(data)
        .resize(width || null, height || null, { fit: "inside", withoutEnlargement: true })
        .webp({ quality })
        .toBuffer();
      mime = "image/webp";
    } catch {
      // fallback: kembalikan original
    }
  }

  return {
    statusCode: 200,
    headers: {
      "Content-Type": mime,
      "Cache-Control": "public, max-age=86400",
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
        "User-Agent": "Mozilla/5.0 (compatible; CoverProxy/1.0)",
        "Referer": referer,
        "Accept": "image/webp,image/*,*/*;q=0.8",
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
