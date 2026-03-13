const https = require("https");
const http = require("http");
const { URL } = require("url");
const sharp = require("sharp");

// ── KONFIGURASI ──────────────────────────────────────────────────────────────

const ALLOWED_REFERER_PATTERNS = [
  /\/(komik|manga|series|manhwa|manhua)\//i,
];

// Referer khusus per domain (untuk situs yang butuh referer spesifik)
const CUSTOM_REFERERS = {
  "komikcast": "https://v1.komikcast.fit",
};

const MAX_WIDTH  = 600;
const MAX_HEIGHT = 900;

// ── HANDLER ──────────────────────────────────────────────────────────────────

exports.handler = async (event) => {
  if (event.httpMethod !== "GET") return err(405, "Method Not Allowed");

  const { url, w, h, q } = event.queryStringParameters || {};
  if (!url) return err(400, "Missing 'url' parameter");

  // Cek Referer
  const referer = event.headers["referer"] || event.headers["origin"] || "";
  if (referer) {
    let parsedRef;
    try { parsedRef = new URL(referer); }
    catch { return err(403, "Referer tidak valid"); }

    const isRoot = parsedRef.pathname === "/" || parsedRef.pathname === "";
    const isAllowed = ALLOWED_REFERER_PATTERNS.some(p => p.test(parsedRef.pathname));

    if (!isRoot && !isAllowed) {
      return err(403, "Forbidden: halaman ini tidak diizinkan menggunakan proxy");
    }
  }

  const imageUrl = decodeURIComponent(url);

  let parsed;
  try { parsed = new URL(imageUrl); }
  catch { return err(400, "URL gambar tidak valid"); }

  if (!["http:", "https:"].includes(parsed.protocol)) {
    return err(400, "Protocol tidak didukung");
  }

  const width   = Math.min(MAX_WIDTH,  parseInt(w || "0", 10));
  const height  = Math.min(MAX_HEIGHT, parseInt(h || "0", 10));
  const quality = Math.min(100, Math.max(10, parseInt(q || "85", 10)));

  // Tentukan referer ke sumber gambar
  let imageReferer = parsed.origin;
  for (const [key, val] of Object.entries(CUSTOM_REFERERS)) {
    if (parsed.hostname.includes(key)) {
      imageReferer = val;
      break;
    }
  }

  let data, contentType;
  try {
    ({ data, contentType } = await fetchImage(imageUrl, imageReferer));
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