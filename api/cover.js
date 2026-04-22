const https = require("https");
const http = require("http");
const { URL } = require("url");
const sharp = require("sharp");

const HOUR_LIMIT = 500;
const rateLimit = new Map();

setInterval(() => {
  const now = Date.now();
  for (const [ip, requests] of rateLimit.entries()) {
    const valid = requests.filter(t => now - t < 43200000);
    if (valid.length === 0) rateLimit.delete(ip);
    else rateLimit.set(ip, valid);
  }
}, 600000);

export const config = { api: { bodyParser: false } };

module.exports = async (req, res) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "*");

  if (req.method === "OPTIONS") return res.status(204).end();

  if (req.method === "POST") {
    // Mode POST: terima binary dari Worker
    try {
      const chunks = [];
      await new Promise((resolve, reject) => {
        req.on("data", c => chunks.push(c));
        req.on("end", resolve);
        req.on("error", reject);
      });

      const body = Buffer.concat(chunks);
      const boundary = req.headers["content-type"]?.split("boundary=")[1];
      if (!boundary) return send(res, 400, { error: "Missing boundary" });

      const parts = parsePart(body, boundary);
      const imageBuffer = parts["image"];
      const w = parts["w"] ? parseInt(parts["w"]) : null;
      const h = parts["h"] ? parseInt(parts["h"]) : null;
      const q = parts["q"] ? Math.min(100, Math.max(10, parseInt(parts["q"]))) : 85;

      if (!imageBuffer) return send(res, 400, { error: "Missing image" });

      const output = await sharp(imageBuffer)
        .resize(w, h, { fit: "inside", withoutEnlargement: true })
        .webp({ quality: q })
        .toBuffer();

      res.setHeader("Content-Type", "image/webp");
      res.setHeader("Cache-Control", "public, max-age=86400");
      return res.status(200).send(output);

    } catch (err) {
      return send(res, 500, { error: err.message });
    }
  }

  if (req.method !== "GET") return send(res, 405, { error: "Method Not Allowed" });

  // Mode GET: fetch sendiri lalu resize
  const { url, w, h, q, key, ...rest } = req.query || {};

  const validKey = process.env.key && key === process.env.key;

  if (!validKey) {
    const ip = req.headers["x-forwarded-for"]?.split(",")[0].trim() ||
               req.headers["x-real-ip"] ||
               req.socket?.remoteAddress ||
               "unknown";
    const now = Date.now();
    const requests = (rateLimit.get(ip) || []).filter(t => now - t < 43200000);

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

  let data, contentType;
  try {
    ({ data, contentType } = await fetchImage(imageUrl, imageUrl));
  } catch (fetchErr) {
    console.warn(`Fetch gagal (${fetchErr.message}), redirect ke: ${imageUrl}`);
    return res.redirect(302, imageUrl);
  }

  let output;
  try {
    output = await sharp(data)
      .resize(width, height, { fit: "inside", withoutEnlargement: true })
      .webp({ quality })
      .toBuffer();
  } catch {
    console.warn(`Sharp gagal, redirect ke: ${imageUrl}`);
    return res.redirect(302, imageUrl);
  }

  res.setHeader("Content-Type", "image/webp");
  res.setHeader("Cache-Control", "public, max-age=86400");
  return res.status(200).send(output);
};

function parsePart(body, boundary) {
  const result = {};
  const sep = Buffer.from("--" + boundary);
  let start = 0;
  while (true) {
    const idx = body.indexOf(sep, start);
    if (idx === -1) break;
    start = idx + sep.length;
    if (body[start] === 45 && body[start + 1] === 45) break;
    if (body[start] === 13) start += 2;
    const headerEnd = body.indexOf("\r\n\r\n", start);
    if (headerEnd === -1) break;
    const header = body.slice(start, headerEnd).toString();
    const nameMatch = header.match(/name="([^"]+)"/);
    if (!nameMatch) continue;
    const name = nameMatch[1];
    const dataStart = headerEnd + 4;
    const nextSep = body.indexOf(sep, dataStart);
    const dataEnd = nextSep === -1 ? body.length : nextSep - 2;
    const data = body.slice(dataStart, dataEnd);
    result[name] = header.includes("filename=") ? data : data.toString().trim();
    start = nextSep === -1 ? body.length : nextSep;
  }
  return result;
}

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
      const contentType = res.headers["content-type"] || "image/jpeg";
      res.on("data", c => chunks.push(c));
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
