const https = require("https");
const http = require("http");
const { URL } = require("url");

export const config = {
  api: {
    bodyParser: false,
  },
};

module.exports = async (req, res) => {
  // ============================================================
  // CORS
  // ============================================================

  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader(
    "Access-Control-Allow-Methods",
    "GET, OPTIONS",
  );
  res.setHeader("Access-Control-Allow-Headers", "*");

  if (req.method === "OPTIONS") {
    return res.status(204).end();
  }

  // ============================================================
  // Only GET
  // ============================================================

  if (req.method !== "GET") {
    return send(res, 405, {
      error: "Method Not Allowed",
    });
  }

  // ============================================================
  // Get URL
  // ============================================================

  const { url } = req.query || {};

  if (!url) {
    return send(res, 400, {
      error: "Missing 'url' parameter",
    });
  }

  let imageUrl;

  try {
    imageUrl = decodeURIComponent(url);
  } catch {
    return send(res, 400, {
      error: "URL tidak dapat di-decode",
    });
  }

  // ============================================================
  // Validate URL
  // ============================================================

  let parsed;

  try {
    parsed = new URL(imageUrl);
  } catch {
    return send(res, 400, {
      error: "URL gambar tidak valid",
    });
  }

  if (!["http:", "https:"].includes(parsed.protocol)) {
    return send(res, 400, {
      error: "Protocol tidak didukung",
    });
  }

  // ============================================================
  // Fetch image
  // ============================================================

  try {
    const { data, contentType } = await fetchImage(
      imageUrl,
      "https://web1.mgkomik.cc/",
    );

    res.setHeader(
      "Content-Type",
      contentType || "image/webp",
    );

    res.setHeader(
      "Cache-Control",
      "public, max-age=86400, s-maxage=86400",
    );

    res.setHeader(
      "Content-Length",
      data.length,
    );

    return res.status(200).send(data);

  } catch (err) {
    console.error(
      `Fetch gambar gagal: ${err.message}`,
    );

    return send(res, 502, {
      error: "Gagal mengambil gambar",
      detail: err.message,
    });
  }
};

// ================================================================
// Fetch image with redirect support
// ================================================================

function fetchImage(
  url,
  referer,
  redirectCount = 0,
) {
  return new Promise((resolve, reject) => {
    if (redirectCount > 5) {
      return reject(
        new Error("Terlalu banyak redirect"),
      );
    }

    const lib = url.startsWith("https:")
      ? https
      : http;

    const request = lib.get(
      url,
      {
        headers: {
          "User-Agent":
            "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120.0.0.0 Safari/537.36",

          "Accept":
            "image/avif,image/webp,image/apng,image/*,*/*;q=0.8",

          "Accept-Language":
            "id-ID,id;q=0.9,en-US;q=0.8,en;q=0.7",

          "Referer": referer,

          "Sec-Fetch-Dest": "image",
          "Sec-Fetch-Mode": "no-cors",
          "Sec-Fetch-Site": "same-site",
        },

        timeout: 15000,
      },

      (response) => {
        // ========================================================
        // Redirect
        // ========================================================

        if (
          [301, 302, 303, 307, 308].includes(
            response.statusCode,
          ) &&
          response.headers.location
        ) {
          const location = new URL(
            response.headers.location,
            url,
          ).toString();

          console.log(
            `Redirect ${response.statusCode}: ${url} -> ${location}`,
          );

          response.resume();

          return fetchImage(
            location,
            referer,
            redirectCount + 1,
          )
            .then(resolve)
            .catch(reject);
        }

        // ========================================================
        // HTTP error
        // ========================================================

        if (response.statusCode !== 200) {
          response.resume();

          return reject(
            new Error(
              `HTTP ${response.statusCode}`,
            ),
          );
        }

        // ========================================================
        // Content type
        // ========================================================

        const contentType =
          response.headers["content-type"] ||
          "application/octet-stream";

        const chunks = [];

        // ========================================================
        // Receive data
        // ========================================================

        response.on("data", (chunk) => {
          chunks.push(chunk);
        });

        response.on("end", () => {
          const data = Buffer.concat(chunks);

          if (!data.length) {
            return reject(
              new Error("Response gambar kosong"),
            );
          }

          resolve({
            data,
            contentType,
          });
        });

        response.on("error", reject);
      },
    );

    request.on("error", reject);

    request.on("timeout", () => {
      request.destroy();

      reject(
        new Error("Request timeout"),
      );
    });
  });
}

// ================================================================
// JSON response
// ================================================================

function send(res, status, body) {
  res.setHeader(
    "Content-Type",
    "application/json; charset=utf-8",
  );

  return res
    .status(status)
    .json(body);
}