const https = require("https");
const http = require("http");
const { URL } = require("url");
const sharp = require("sharp");

const DAY_LIMIT = 3;
const rateLimit = new Map();

setInterval(() => {
  const now = Date.now();
  for (const [ip, requests] of rateLimit.entries()) {
    const valid = requests.filter(t => now - t < 86400000);
    if (valid.length === 0) rateLimit.delete(ip);
    else rateLimit.set(ip, valid);
  }
}, 600000);

module.exports = async (req, res) => {
  if (req.method !== "GET") return send(res, 405, { error: "Method Not Allowed" });

  const { url, w, h, q, key, ...rest } = req.query || {};

  const validKey = process.env.key && key === process.env.key;

  if (!validKey) {
    const ip = req.headers["x-forwarded-for"]?.split(",")[0].trim() ||
               req.headers["x-real-ip"] ||
               req.socket?.remoteAddress ||
               "unknown";
    const now = Date.now();
    const requests = (rateLimit.get(ip) || []).filter(t => now - t < 86400000);

    if (requests.length >= DAY_LIMIT)
      return send(res, 429, { error: `Limit ${DAY_LIMIT} request/hari tercapai` });

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

  let data;
  try {
    ({ data } = await fetchImage(imageUrl, parsed.origin));
  } catch (e) {
    return send(res, 502, { error: `Gagal fetch gambar: ${e.message}`, url: imageUrl });
  }

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

    lib.get(url, {
      headers: {
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
        "Accept": "image/avif,image/webp,image/apng,image/*,*/*;q=0.8",
        "Accept-Language": "id-ID,id;q=0.9,en-US;q=0.8,en;q=0.7",
        "Referer": referer,
        "Sec-Fetch-Dest": "image",
        "Sec-Fetch-Mode": "no-cors",
        "Sec-Fetch-Site": "same-site",
      },
      timeout: 10000,
    }, (res) => {
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