const https = require("https");
const http = require("http");
const { URL } = require("url");

export const config = { api: { bodyParser: false } };

module.exports = async (req, res) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "*");

  if (req.method === "OPTIONS") return res.status(204).end();
  if (req.method !== "GET") return send(res, 405, { error: "Method Not Allowed" });

  const { url } = req.query || {};
  if (!url) return send(res, 400, { error: "Missing 'url' parameter" });

  let imageUrl;
  try {
    imageUrl = decodeURIComponent(url);
  } catch {
    return send(res, 400, { error: "URL tidak dapat di-decode" });
  }

  let parsed;
  try {
    parsed = new URL(imageUrl);
  } catch {
    return send(res, 400, { error: "URL gambar tidak valid" });
  }

  if (!["http:", "https:"].includes(parsed.protocol)) {
    return send(res, 400, { error: "Protocol tidak didukung" });
  }

  // Komikcast (minio.imgkc1.my.id): proxy langsung, jangan redirect
if (parsed.hostname === "minio.imgkc1.my.id") {
  try {
    const { data, contentType } = await fetchImage(imageUrl, "https://komikcast.io/");
    res.setHeader("Content-Type", contentType || "image/webp");
    res.setHeader("Cache-Control", "public, max-age=86400, s-maxage=86400");
    res.setHeader("Content-Length", data.length);
    return res.status(200).send(data);
  } catch (err) {
    return send(res, 502, { error: "Gagal fetch MinIO", detail: err.message });
  }
}

  // MGKomik dan sumber lain: tetap proxy gambar
  try {
    const { data, contentType } = await fetchImage(
      imageUrl,
      "https://web1.mgkomik.cc/",
    );

    res.setHeader("Content-Type", contentType || "image/webp");
    res.setHeader("Cache-Control", "public, max-age=86400, s-maxage=86400");
    res.setHeader("Content-Length", data.length);
    return res.status(200).send(data);
  } catch (err) {
    return send(res, 502, {
      error: "Gagal mengambil gambar",
      detail: err.message,
    });
  }
};

function fetchImage(url, referer, redirects = 0) {
  return new Promise((resolve, reject) => {
    if (redirects > 5) return reject(new Error("Terlalu banyak redirect"));

    const lib = url.startsWith("https:") ? https : http;

    lib.get(url, {
      headers: {
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120.0.0.0 Safari/537.36",
        "Accept": "image/avif,image/webp,image/apng,image/*,*/*;q=0.8",
        "Referer": referer,
      },
      timeout: 15000,
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
          ? resolve({
              data,
              contentType: response.headers["content-type"],
            })
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