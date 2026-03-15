const https = require("https");
const http = require("http");
const { URL } = require("url");
const sharp = require("sharp");

const HOUR_LIMIT = 500;
const MAX_REDIRECTS = 5;
const MAX_IMAGE_SIZE = 20 * 1024 * 1024; // 20MB
const rateLimit = new Map();

setInterval(() => {
  const now = Date.now();
  for (const [ip, requests] of rateLimit.entries()) {
    const valid = requests.filter(t => now - t < 43200000);
    if (valid.length === 0) rateLimit.delete(ip);
    else rateLimit.set(ip, valid);
  }
}, 600000);

module.exports = async (req, res) => {
  // CORS preflight
  if (req.method === "OPTIONS") {
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS");
    res.setHeader("Access-Control-Allow-Headers", "Content-Type");
    return res.status(204).end();
  }

  if (req.method !== "GET") return send(res, 405, { error: "Method Not Allowed" });

  const { url, w, h, q, key, ...rest } = req.query || {};

  const validKey = process.env.key && key === process.env.key;

  if (!validKey) {
    const ip = req.headers["x-forwarded-for"]?.split(",")[0].trim() ||
               req.headers["x-real-ip"] ||
               req.socket?.remoteAddress ||
               "unknown";
    const now = Date.now();
    const requests = (rateLimit.get(ip) || []).filter(t => now - t < 43200000);

    console.log(`IP: ${ip} | requests: ${requests.length} | limit: ${HOUR_LIMIT}`);

    if (requests.length >= HOUR_LIMIT)
      return send(res, 429, { error: `Limit ${HOUR_LIMIT} request/12 jam tercapai`, ip });

    requests.push(now);
    rateLimit.set(ip, requests);
  }

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

  // Referer dari domain target + trailing slash
  const referer = `${parsed.protocol}//${parsed.hostname}/`;

  let data, contentType;
  try {
    ({ data, contentType } = await fetchImage(imageUrl, referer));
  } catch (fetchErr) {
    console.warn(`Fetch gagal: ${fetchErr.message}`);
    return send(res, 502, { error: `Fetch gagal: ${fetchErr.message}` });
  }

  let output;
  try {
    output = await sharp(data)
      .resize(width, height, { fit: "inside", withoutEnlargement: true })
      .webp({ quality })
      .toBuffer();
  } catch (sharpErr) {
    console.warn(`Sharp gagal: ${sharpErr.message}`);
    return send(res, 422, { error: `Gagal memproses gambar: ${sharpErr.message}` });
  }

  res.setHeader("Content-Type", "image/webp");
  res.setHeader("Cache-Control", "public, max-age=86400");
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.status(200).send(output);
};

function fetchImage(url, referer, redirectCount = 0) {
  return new Promise((resolve, reject) => {
    // Batasi redirect maksimal 5x
    if (redirectCount > MAX_REDIRECTS)
      return reject(new Error("Too many redirects"));

    const lib = url.startsWith("https") ? https : http;
    const chunks = [];
    let totalSize = 0;

    lib.get(url, {
      headers: {
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
        "Accept": "image/avif,image/webp,image/apng,image/*,*/*;q=0.8",
        "Accept-Language": "id-ID,id;q=0.9,en-US;q=0.8,en;q=0.7",
        "Accept-Encoding": "gzip, deflate, br",
        "Cache-Control": "no-cache",
        "Pragma": "no-cache",
        "Referer": referer,
        "Sec-Fetch-Dest": "image",
        "Sec-Fetch-Mode": "no-cors",
        "Sec-Fetch-Site": "cross-site",
        "Sec-Ch-Ua": '"Chromium";v="120", "Google Chrome";v="120"',
        "Sec-Ch-Ua-Mobile": "?0",
        "Sec-Ch-Ua-Platform": '"Windows"',
      },
      timeout: 10000,
    }, (res) => {
      // Handle redirect dengan counter
      if ([301, 302, 307, 308].includes(res.statusCode) && res.headers.location)
        return fetchImage(res.headers.location, referer, redirectCount + 1)
          .then(resolve).catch(reject);

      if (res.statusCode !== 200)
        return reject(new Error(`HTTP ${res.statusCode}`));

      const contentType = res.headers["content-type"] || "image/jpeg";

      res.on("data", c => {
        // Batasi ukuran response maksimal 20MB
        totalSize += c.length;
        if (totalSize > MAX_IMAGE_SIZE) {
          res.destroy();
          return reject(new Error("Image too large (>20MB)"));
        }
        chunks.push(c);
      });

      res.on("end", () => resolve({ data: Buffer.concat(chunks), contentType }));
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
