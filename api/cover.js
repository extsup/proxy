const https = require("https");
const http = require("http");
const { URL } = require("url");
const sharp = require("sharp");

const HOUR_LIMIT = 500;
const rateLimit = new Map();

setInterval(() => {
  const now = Date.now();

  for (const [ip, requests] of rateLimit.entries()) {
    const valid = requests.filter((t) => now - t < 43200000);

    if (valid.length === 0) {
      rateLimit.delete(ip);
    } else {
      rateLimit.set(ip, valid);
    }
  }
}, 600000);

export const config = {
  api: {
    bodyParser: false,
  },
};

module.exports = async (req, res) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader(
    "Access-Control-Allow-Methods",
    "GET, POST, OPTIONS",
  );
  res.setHeader("Access-Control-Allow-Headers", "*");

  if (req.method === "OPTIONS") {
    return res.status(204).end();
  }

  // ============================================================
  // POST
  // ============================================================

  if (req.method === "POST") {
    try {
      const chunks = [];

      await new Promise((resolve, reject) => {
        req.on("data", (chunk) => chunks.push(chunk));
        req.on("end", resolve);
        req.on("error", reject);
      });

      const body = Buffer.concat(chunks);

      const contentType = req.headers["content-type"] || "";
      const boundary = contentType.split("boundary=")[1];

      if (!boundary) {
        return send(res, 400, {
          error: "Missing boundary",
        });
      }

      const parts = parsePart(body, boundary);

      const imageBuffer = parts["image"];

      const width = parts["w"]
        ? parseDimension(parts["w"])
        : null;

      const height = parts["h"]
        ? parseDimension(parts["h"])
        : null;

      const quality = parts["q"]
        ? parseQuality(parts["q"])
        : 85;

      if (!imageBuffer) {
        return send(res, 400, {
          error: "Missing image",
        });
      }

      if (!width && !height) {
        return send(res, 400, {
          error: "Width atau height diperlukan",
        });
      }

      const output = await sharp(imageBuffer)
        .resize(width, height, {
          fit: "inside",
          withoutEnlargement: true,
        })
        .webp({
          quality,
        })
        .toBuffer();

      res.setHeader("Content-Type", "image/webp");
      res.setHeader(
        "Cache-Control",
        "public, max-age=86400, s-maxage=86400",
      );

      return res.status(200).send(output);
    } catch (err) {
      console.error("POST resize gagal:", err);

      return send(res, 500, {
        error: "Gagal memproses gambar",
        detail: err.message,
      });
    }
  }

  // ============================================================
  // Only GET from here
  // ============================================================

  if (req.method !== "GET") {
    return send(res, 405, {
      error: "Method Not Allowed",
    });
  }

  // ============================================================
  // Query
  // ============================================================

  const {
    url,
    w,
    h,
    q,
    key,
    ...rest
  } = req.query || {};

  // ============================================================
  // Rate Limit
  // ============================================================

  const validKey =
    process.env.key &&
    key === process.env.key;

  if (!validKey) {
    const ip =
      req.headers["x-forwarded-for"]?.split(",")[0].trim() ||
      req.headers["x-real-ip"] ||
      req.socket?.remoteAddress ||
      "unknown";

    const now = Date.now();

    const requests = (
      rateLimit.get(ip) || []
    ).filter(
      (t) => now - t < 43200000,
    );

    if (requests.length >= HOUR_LIMIT) {
      return send(res, 429, {
        error: `Limit ${HOUR_LIMIT} request/12 jam tercapai`,
      });
    }

    requests.push(now);
    rateLimit.set(ip, requests);
  }

  // ============================================================
  // Validate URL
  // ============================================================

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
  // Extra parameters
  // ============================================================

  const extraParams = Object.entries(rest)
    .map(([k, v]) => {
      return `${encodeURIComponent(k)}=${encodeURIComponent(v)}`;
    })
    .join("&");

  if (extraParams) {
    imageUrl +=
      (imageUrl.includes("?") ? "&" : "?") +
      extraParams;
  }

  // ============================================================
  // Parse URL
  // ============================================================

  let parsed;

  try {
    parsed = new URL(imageUrl);
  } catch {
    return send(res, 400, {
      error: "URL gambar tidak valid",
    });
  }

  // ============================================================
  // Handle Next.js image URL
  // ============================================================

  if (parsed.pathname.includes("/_next/image")) {
    const innerUrl =
      parsed.searchParams.get("url");

    if (innerUrl) {
      try {
        imageUrl = decodeURIComponent(innerUrl);
        parsed = new URL(imageUrl);
      } catch {
        return send(res, 400, {
          error: "URL gambar tidak valid",
        });
      }
    }
  }

  // ============================================================
  // Protocol validation
  // ============================================================

  if (
    !["http:", "https:"].includes(
      parsed.protocol,
    )
  ) {
    return send(res, 400, {
      error: "Protocol tidak didukung",
    });
  }

  // ============================================================
  // Dimensions
  // ============================================================

  const width = w
    ? parseDimension(w)
    : null;

  const height = h
    ? parseDimension(h)
    : null;

  const quality = q
    ? parseQuality(q)
    : 85;

  if (!width && !height) {
    return send(res, 400, {
      error: "Parameter w atau h diperlukan",
    });
  }

  // ============================================================
  // Fetch original image
  // ============================================================

  let data;

  try {
    const result = await fetchImage(
      imageUrl,
      imageUrl,
    );

    data = result.data;

    console.log(
      `Image fetched: ${imageUrl} (${data.length} bytes)`,
    );
  } catch (err) {
    console.error(
      `Fetch gambar gagal: ${err.message}`,
    );

    return send(res, 502, {
      error: "Gagal mengambil gambar sumber",
      detail: err.message,
      url: imageUrl,
    });
  }

  // ============================================================
  // Resize
  // ============================================================

  let output;

  try {
    const metadata = await sharp(data).metadata();

    console.log(
      `Original: ${metadata.width}x${metadata.height} ${metadata.format}`,
    );

    output = await sharp(data)
      .resize(width, height, {
        fit: "inside",
        withoutEnlargement: true,
      })
      .webp({
        quality,
      })
      .toBuffer();

    const outputMetadata =
      await sharp(output).metadata();

    console.log(
      `Resized: ${outputMetadata.width}x${outputMetadata.height} ${outputMetadata.format}`,
    );
  } catch (err) {
    console.error(
      `Sharp resize gagal: ${err.message}`,
    );

    return send(res, 500, {
      error: "Gagal resize gambar",
      detail: err.message,
    });
  }

  // ============================================================
  // Response
  // ============================================================

  res.setHeader(
    "Content-Type",
    "image/webp",
  );

  res.setHeader(
    "Cache-Control",
    "public, max-age=86400, s-maxage=86400",
  );

  res.setHeader(
    "Content-Length",
    output.length,
  );

  return res.status(200).send(output);
};

// ================================================================
// Parse dimension
// ================================================================

function parseDimension(value) {
  const number = parseInt(value, 10);

  if (
    !Number.isFinite(number) ||
    number <= 0
  ) {
    return null;
  }

  return Math.min(number, 2000);
}

// ================================================================
// Parse quality
// ================================================================

function parseQuality(value) {
  const number = parseInt(value, 10);

  if (!Number.isFinite(number)) {
    return 85;
  }

  return Math.min(
    100,
    Math.max(10, number),
  );
}

// ================================================================
// Multipart parser
// ================================================================

function parsePart(body, boundary) {
  const result = {};

  const separator = Buffer.from(
    "--" + boundary,
  );

  let start = 0;

  while (true) {
    const index = body.indexOf(
      separator,
      start,
    );

    if (index === -1) {
      break;
    }

    start =
      index + separator.length;

    // Final boundary
    if (
      body[start] === 45 &&
      body[start + 1] === 45
    ) {
      break;
    }

    // CRLF
    if (body[start] === 13) {
      start += 2;
    }

    const headerEnd =
      body.indexOf(
        "\r\n\r\n",
        start,
      );

    if (headerEnd === -1) {
      break;
    }

    const header = body
      .slice(start, headerEnd)
      .toString();

    const nameMatch =
      header.match(
        /name="([^"]+)"/,
      );

    if (!nameMatch) {
      continue;
    }

    const name =
      nameMatch[1];

    const dataStart =
      headerEnd + 4;

    const nextSeparator =
      body.indexOf(
        separator,
        dataStart,
      );

    const dataEnd =
      nextSeparator === -1
        ? body.length
        : nextSeparator - 2;

    const data =
      body.slice(
        dataStart,
        dataEnd,
      );

    result[name] =
      header.includes(
        "filename=",
      )
        ? data
        : data.toString().trim();

    start =
      nextSeparator === -1
        ? body.length
        : nextSeparator;
  }

  return result;
}

// ================================================================
// Fetch image with redirect support
// ================================================================

function fetchImage(
  url,
  referer,
  redirectCount = 0,
) {
  return new Promise(
    (resolve, reject) => {
      if (redirectCount > 5) {
        return reject(
          new Error(
            "Terlalu banyak redirect",
          ),
        );
      }

      const lib =
        url.startsWith("https:")
          ? https
          : http;

      const chunks = [];

      const request =
        lib.get(
          url,
          {
            headers: {
              "User-Agent":
                "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120.0.0.0 Safari/537.36",

              "Accept":
                "image/avif,image/webp,image/apng,image/*,*/*;q=0.8",

              "Accept-Language":
                "id-ID,id;q=0.9,en-US;q=0.8,en;q=0.7",

              "Referer":
                referer,

              "Sec-Fetch-Dest":
                "image",

              "Sec-Fetch-Mode":
                "no-cors",

              "Sec-Fetch-Site":
                "same-site",
            },

            timeout: 15000,
          },

          (response) => {
            // ====================================================
            // Redirect
            // ====================================================

            if (
              [301, 302, 303, 307, 308].includes(
                response.statusCode,
              ) &&
              response.headers.location
            ) {
              const location =
                new URL(
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

            // ====================================================
            // HTTP error
            // ====================================================

            if (
              response.statusCode !== 200
            ) {
              response.resume();

              return reject(
                new Error(
                  `HTTP ${response.statusCode}`,
                ),
              );
            }

            const contentType =
              response.headers[
                "content-type"
              ] || "";

            // ====================================================
            // Receive data
            // ====================================================

            response.on(
              "data",
              (chunk) =>
                chunks.push(chunk),
            );

            response.on(
              "end",
              () => {
                const data =
                  Buffer.concat(
                    chunks,
                  );

                if (!data.length) {
                  return reject(
                    new Error(
                      "Response gambar kosong",
                    ),
                  );
                }

                resolve({
                  data,
                  contentType,
                });
              },
            );

            response.on(
              "error",
              reject,
            );
          },
        );

      request.on(
        "error",
        reject,
      );

      request.on(
        "timeout",
        () => {
          request.destroy();

          reject(
            new Error(
              "Request timeout",
            ),
          );
        },
      );
    },
  );
}

// ================================================================
// JSON response
// ================================================================

function send(
  res,
  status,
  body,
) {
  res.setHeader(
    "Content-Type",
    "application/json; charset=utf-8",
  );

  return res
    .status(status)
    .json(body);
}