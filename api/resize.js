const https = require("https");
const http = require("http");
const { URL } = require("url");
const sharp = require("sharp");

export const config = { api: { bodyParser: false } };

// =============================================
// REFERER MAP - tambah domain baru di sini
// format: "hostname": "referer"
// =============================================
const REFERER_MAP = {
  "minio.imgkc1.my.id": null,         // gunakan imageUrl sendiri sebagai referer
  "mgkomik.cc": "https://web1.mgkomik.cc/",
  "web1.mgkomik.cc": "https://web1.mgkomik.cc/",
  // "cdn.kiryuu.id": "https://kiryuu.id/",
  // "img.shinigami.asia": "https://shinigami.asia/",
};

function getReferer(hostname, imageUrl) {
  for (const [key, val] of Object.entries(REFERER_MAP)) {
    if (hostname.includes(key)) return val ?? imageUrl;
  }
  return imageUrl; // default: referer = url gambar itu sendiri
}
// =============================================

module.exports = async (req, res) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "*");

  if (req.method === "OPTIONS") return res.status(204).end();
  if (req.method !== "GET") return send(res, 405, { error: "Method Not Allowed" });

  const { url, w, h, q, ...rest } = req.query || {};
  if (!url) return send(res, 400, { error: "Missing 'url' parameter" });

  let imageUrl;
  try {
    imageUrl = decodeURIComponent(url);
  } catch {
    return send(res, 400, { error: "URL tidak dapat di-decode" });
  }

  // Sambung kembali sisa query params (X-Amz-*, dll) ke imageUrl
  const extraParams = Object.entries(rest).map(([k, v]) => `${k}=${v}`).join("&");
  if (extraParams) imageUrl += (imageUrl.includes("?") ? "&" : "?") + extraParams;

  let parsed;
  try {
    parsed = new URL(imageUrl);
  } catch {
    return send(res, 400, { error: "URL gambar tidak valid" });
  }

  if (!["http:", "https:"].includes(parsed.protocol)) {
    return send(res, 400, { error: "Protocol tidak didukung" });
  }

  const width   = w ? parseInt(w, 10) : null;
  const height  = h ? parseInt(h, 10) : null;
  const quality = Math.min(100, Math.max(10, parseInt(q || "80", 10)));

  const referer = getReferer(parsed.hostname, imageUrl);

  let data;
  try {
    ({ data } = await fetchImage(imageUrl, referer));
  } catch (err) {
    console.warn(`Fetch gagal (${err.message}), redirect ke: ${imageUrl}`);
    return res.redirect(302, imageUrl);
  }

  let output;
  try {
    output = await sharp(data)
      .resize(width, height, { fit: "inside", withoutEnlargement: true })
      .webp({ quality })
      .toBuffer();
  } catch (err) {
    console.warn(`Sharp gagal (${err.message}), redirect ke: ${imageUrl}`);
    return res.redirect(302, imageUrl);
  }

  res.setHeader("Content-Type", "image/webp");
  res.setHeader("Cache-Control", "public, max-age=86400, s-maxage=86400");
  res.setHeader("Content-Length", output.length);
  return res.status(200).send(output);
};

function fetchImage(url, referer, redirects = 0) {
  return new Promise((resolve, reject) => {
    if (redirects > 5) return reject(new Error("Terlalu banyak redirect"));

    const lib = url.startsWith("https:") ? https : http;

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
    }, response => {
      if ([301, 302, 303, 307, 308].includes(response.statusCode) &&
          response.headers.location) {
        const next = new URL(response.headers.location, url).toString();
        response.resume();
        return fetchImage(next, referer, redirects + 1).then(resolve).catch(reject);
      }

      if (response.statusCode !== 200) {
        response.resume();
        return reject(new Error(`HTTP ${response.statusCode}`));
      }

      const chunks = [];
      response.on("data", c => chunks.push(c));
      response.on("end", () => {
        const data = Buffer.concat(chunks);
        data.length
          ? resolve({ data, contentType: response.headers["content-type"] })
          : reject(new Error("Response gambar kosong"));
      });
      response.on("error", reject);
    }).on("error", reject).on("timeout", function () {
      this.destroy();
      reject(new Error("Request timeout"));
    });
  });
}

function send(res, status, body) {
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  return res.status(status).json(body);
}
