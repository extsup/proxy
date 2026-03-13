/**
 * Cover Image Proxy - Netlify Function
 * Hanya untuk resize cover manga/komik, BUKAN untuk halaman komik.
 * 
 * Usage:
 *   /.netlify/functions/cover?url=https://example.com/cover.jpg&w=300&h=400
 *   /cover?url=...  (via redirect di netlify.toml)
 */

const https = require("https");
const http = require("http");
const { URL } = require("url");

// ============================================================
// KONFIGURASI - Sesuaikan dengan kebutuhanmu
// ============================================================

/**
 * Daftar ALLOWED REFERER:
 * Hanya request dari domain ini yang diizinkan.
 * Tambahkan domain kamu di sini.
 */
const ALLOWED_REFERERS = [
  "localhost",
  "127.0.0.1",
  // Tambahkan domain kamu:
  "proxygambar.vercel.app",
  "shinigami-reader.netlify.app",   // contoh
  // "yourdomain.com",
  // "yourdomain.netlify.app",
];

/**
 * Daftar ALLOWED IMAGE SOURCES:
 * URL gambar hanya boleh berasal dari domain ini.
 * Ini mencegah proxy dipakai untuk fetch sembarang URL.
 */
const ALLOWED_IMAGE_DOMAINS = [
  // Komikcast
  "komikcast.site",
  "komikcast.io",
  "cdn.komikcast.site",
  "cdn.komikcast.io",
  "i0.wp.com",
  "i1.wp.com",
  "i2.wp.com",
  "i3.wp.com",

  // WestManga
  "westmanga.tv",
  "cdn.westmanga.tv",

  // Shinigami
  "shngm.io",
  "api.shngm.io",
  "cdn.shngm.io",

  // KeiKomik / Firebase Storage
  "firebasestorage.googleapis.com",
  "storage.googleapis.com",

  // CDN umum yang sering dipakai situs manga Indonesia
  "cdnx.rawkuma.com",
  "asuracomic.net",
  "weserv.nl",
  "images.weserv.nl",

  // Tambahkan sesuai kebutuhan:
  // "cdn.situmangakamu.com",
];

/**
 * Pattern URL yang DIBLOKIR (halaman komik, bukan cover).
 * Jika URL mengandung salah satu pattern ini → tolak.
 */
const BLOCKED_PATH_PATTERNS = [
  /\/chapter\//i,
  /\/ch-\d+/i,
  /\/ch\d+/i,
  /\/page\/\d+/i,
  /\/read\//i,
  /\/p\d+\.(jpg|png|webp)/i,      // halaman seperti 001.jpg, p001.png
  /\/\d{2,4}\.(jpg|png|webp)/i,   // 001.jpg, 0001.webp
];

/**
 * Ukuran maksimum yang diizinkan (px).
 * Cover biasanya tidak lebih dari 500x800.
 */
const MAX_WIDTH = 600;
const MAX_HEIGHT = 900;

/**
 * Ukuran file maksimum yang di-proxy (bytes).
 * Cegah abuse dengan file besar.
 */
const MAX_FILE_SIZE = 5 * 1024 * 1024; // 5MB

// ============================================================
// HANDLER
// ============================================================

exports.handler = async (event) => {
  // Hanya izinkan GET
  if (event.httpMethod !== "GET") {
    return respond(405, "Method Not Allowed");
  }

  const params = event.queryStringParameters || {};
  const imageUrl = params.url;

  if (!imageUrl) {
    return respond(400, "Missing 'url' parameter");
  }

  // --- 1. Cek Referer ---
  const referer = event.headers["referer"] || event.headers["origin"] || "";
  if (!isAllowedReferer(referer)) {
    console.warn(`[BLOCKED] Referer tidak diizinkan: ${referer}`);
    return respond(403, "Forbidden: Referer tidak diizinkan");
  }

  // --- 2. Validasi URL ---
  let parsedUrl;
  try {
    parsedUrl = new URL(imageUrl);
  } catch {
    return respond(400, "URL tidak valid");
  }

  if (!["http:", "https:"].includes(parsedUrl.protocol)) {
    return respond(400, "Hanya HTTP/HTTPS yang diizinkan");
  }

  // --- 3. Cek domain whitelist ---
  if (!isAllowedDomain(parsedUrl.hostname)) {
    console.warn(`[BLOCKED] Domain tidak diizinkan: ${parsedUrl.hostname}`);
    return respond(403, `Forbidden: Domain '${parsedUrl.hostname}' tidak ada di whitelist`);
  }

  // --- 4. Cek apakah ini halaman komik (bukan cover) ---
  const fullPath = parsedUrl.pathname + parsedUrl.search;
  for (const pattern of BLOCKED_PATH_PATTERNS) {
    if (pattern.test(fullPath)) {
      console.warn(`[BLOCKED] Terdeteksi sebagai halaman komik: ${fullPath}`);
      return respond(403, "Forbidden: URL terdeteksi sebagai halaman komik, bukan cover");
    }
  }

  // --- 5. Parse width & height ---
  let w = parseInt(params.w || params.width || "0", 10);
  let h = parseInt(params.h || params.height || "0", 10);
  const quality = Math.min(100, Math.max(10, parseInt(params.q || params.quality || "85", 10)));

  // Clamp ke batas maksimum
  if (w > MAX_WIDTH) w = MAX_WIDTH;
  if (h > MAX_HEIGHT) h = MAX_HEIGHT;

  // --- 6. Fetch gambar dari sumber ---
  let imageData;
  let contentType;
  try {
    const result = await fetchImage(imageUrl);
    imageData = result.data;
    contentType = result.contentType;

    if (imageData.length > MAX_FILE_SIZE) {
      return respond(413, "File terlalu besar");
    }
  } catch (err) {
    console.error(`[ERROR] Gagal fetch gambar: ${err.message}`);
    return respond(502, `Gagal mengambil gambar: ${err.message}`);
  }

  // --- 7. Kembalikan gambar (tanpa resize jika tidak diminta) ---
  // Netlify Functions tidak punya sharp/jimp secara native,
  // jadi kita forward saja ke wsrv.nl untuk resize jika diperlukan.
  if (w > 0 || h > 0) {
    // Redirect ke wsrv.nl dengan parameter resize
    const wsrvUrl = buildWsrvUrl(imageUrl, w, h, quality);
    return {
      statusCode: 302,
      headers: {
        Location: wsrvUrl,
        "Cache-Control": "public, max-age=86400",
        "X-Proxy-By": "cover-proxy",
      },
      body: "",
    };
  }

  // Tanpa resize → kembalikan langsung
  return {
    statusCode: 200,
    headers: {
      "Content-Type": contentType || "image/jpeg",
      "Cache-Control": "public, max-age=86400",
      "X-Proxy-By": "cover-proxy",
      "Access-Control-Allow-Origin": "*",
    },
    body: imageData.toString("base64"),
    isBase64Encoded: true,
  };
};

// ============================================================
// HELPERS
// ============================================================

function isAllowedReferer(referer) {
  if (!referer) {
    // Izinkan request tanpa referer (misalnya dari curl/testing langsung)
    // Ganti ke `return false` jika ingin lebih ketat
    return true;
  }
  return ALLOWED_REFERERS.some((allowed) =>
    referer.toLowerCase().includes(allowed.toLowerCase())
  );
}

function isAllowedDomain(hostname) {
  return ALLOWED_IMAGE_DOMAINS.some(
    (allowed) =>
      hostname === allowed || hostname.endsWith("." + allowed)
  );
}

function buildWsrvUrl(imageUrl, w, h, quality) {
  const base = "https://wsrv.nl/?";
  const params = new URLSearchParams({
    url: imageUrl,
    ...(w > 0 ? { w: String(w) } : {}),
    ...(h > 0 ? { h: String(h) } : {}),
    q: String(quality),
    output: "webp",
    we: "1", // without enlargement
  });
  return base + params.toString();
}

function fetchImage(url) {
  return new Promise((resolve, reject) => {
    const protocol = url.startsWith("https") ? https : http;
    const chunks = [];

    const req = protocol.get(
      url,
      {
        headers: {
          "User-Agent":
            "Mozilla/5.0 (compatible; CoverProxy/1.0; +https://github.com)",
          Referer: new URL(url).origin,
          Accept: "image/webp,image/apng,image/*,*/*;q=0.8",
        },
        timeout: 10000,
      },
      (res) => {
        // Ikuti redirect
        if ([301, 302, 307, 308].includes(res.statusCode) && res.headers.location) {
          return fetchImage(res.headers.location).then(resolve).catch(reject);
        }

        if (res.statusCode !== 200) {
          return reject(new Error(`Status ${res.statusCode}`));
        }

        const contentType = res.headers["content-type"] || "image/jpeg";
        if (!contentType.startsWith("image/")) {
          return reject(new Error("Response bukan gambar"));
        }

        res.on("data", (chunk) => chunks.push(chunk));
        res.on("end", () =>
          resolve({ data: Buffer.concat(chunks), contentType })
        );
        res.on("error", reject);
      }
    );

    req.on("error", reject);
    req.on("timeout", () => {
      req.destroy();
      reject(new Error("Request timeout"));
    });
  });
}

function respond(status, message) {
  return {
    statusCode: status,
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ error: message, status }),
  };
}
