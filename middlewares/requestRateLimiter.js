const jwt = require("jsonwebtoken");

function getJwtSecret() {
  const secret = String(process.env.JWT_SECRET || "").trim();
  if (!secret) {
    throw new Error("JWT_SECRET is not configured");
  }
  return secret;
}

function resolveClientIp(req) {
  const forwarded = req.headers["x-forwarded-for"];
  if (typeof forwarded === "string" && forwarded.trim()) {
    return forwarded.split(",")[0].trim();
  }
  if (Array.isArray(forwarded) && forwarded.length > 0) {
    return String(forwarded[0] || "").trim();
  }
  return String(req.ip || req.connection?.remoteAddress || req.socket?.remoteAddress || "").trim() || "unknown";
}

function extractTokenFromHeader(authHeader) {
  const rawHeader = String(authHeader || "").trim();
  if (!rawHeader) return null;

  const normalized = rawHeader.replace(/^"+|"+$/g, "").trim();
  if (!normalized) return null;

  const bearerSegments = normalized
    .split(/\s+/)
    .filter((segment) => segment && segment.toLowerCase() !== "bearer");

  if (bearerSegments.length > 0) {
    return bearerSegments[bearerSegments.length - 1].trim();
  }

  return normalized;
}

function getUserIdFromToken(req) {
  try {
    const token = extractTokenFromHeader(req.headers.authorization);
    if (!token) return null;
    const decoded = jwt.verify(token, getJwtSecret());
    if (!decoded || !decoded.id) return null;
    return String(decoded.id).trim();
  } catch (_) {
    return null;
  }
}

function isStaticRequest(pathname) {
  return (
    pathname.startsWith("/uploads") ||
    pathname.startsWith("/public") ||
    pathname.startsWith("/socket.io")
  );
}

function normalizePath(pathname) {
  return String(pathname || "/").toLowerCase();
}

function buildRateRules() {
  return [
    {
      name: "ads-read",
      windowMs: 60 * 1000,
      maxRequests: 40,
      methods: ["GET"],
      match: (pathname) =>
        pathname === "/ads" ||
        pathname === "/ads/store" ||
        pathname === "/ads/counter",
      message: "تم تجاوز الحد المسموح لجلب الإعلانات. حاول مرة أخرى بعد دقيقة.",
    },
    {
      name: "community-feed-read",
      windowMs: 60 * 1000,
      maxRequests: 50,
      methods: ["GET"],
      match: (pathname) =>
        pathname === "/community/posts" ||
        pathname.startsWith("/community/posts/"),
      message: "تم تجاوز الحد المسموح لجلب منشورات المجتمع. حاول مرة أخرى بعد دقيقة.",
    },
    {
      name: "rooms-read",
      windowMs: 60 * 1000,
      maxRequests: 70,
      methods: ["GET"],
      match: (pathname) =>
        pathname === "/rooms" ||
        pathname === "/search-rooms" ||
        pathname === "/my-room" ||
        pathname.startsWith("/room/"),
      message: "تم تجاوز الحد المسموح لجلب بيانات الرومات. حاول مرة أخرى بعد دقيقة.",
    },
    {
      name: "auth-sensitive",
      windowMs: 15 * 60 * 1000,
      maxRequests: 30,
      methods: ["POST"],
      match: (pathname) =>
        pathname === "/login" ||
        pathname === "/admin/login" ||
        pathname.includes("/reset-password") ||
        pathname.includes("/forgot-password") ||
        pathname.includes("/verify-otp") ||
        pathname.includes("/request-agent"),
      message: "تم تجاوز الحد المسموح لمحاولات التحقق. حاول مرة أخرى بعد 15 دقيقة.",
    },
    {
      name: "financial",
      windowMs: 60 * 1000,
      maxRequests: 20,
      methods: ["POST", "PUT", "PATCH", "DELETE"],
      match: (pathname) =>
        pathname.includes("/sendmony") ||
        pathname.includes("/withdrawalrequest") ||
        pathname.includes("/buy-counter") ||
        pathname.includes("/buy-gift") ||
        pathname.includes("/convert-gift") ||
        pathname.includes("/send-gift") ||
        pathname.includes("/store/buy") ||
        pathname.includes("/deposit-") ||
        pathname.includes("/finance") ||
        pathname.includes("/balance"),
      message: "تم تجاوز الحد المسموح للعمليات المالية. حاول مرة أخرى بعد دقيقة.",
    },
    {
      name: "chat-actions",
      windowMs: 60 * 1000,
      maxRequests: 45,
      methods: ["POST", "PUT", "PATCH", "DELETE"],
      match: (pathname) =>
        pathname.includes("/chat/") ||
        pathname.includes("/messages") ||
        pathname.includes("/comments") ||
        pathname.includes("/likes") ||
        pathname.includes("/follow-toggle"),
      message: "تم تجاوز الحد المسموح للتفاعلات السريعة. حاول مرة أخرى بعد دقيقة.",
    },
    {
      name: "uploads",
      windowMs: 10 * 60 * 1000,
      maxRequests: 20,
      methods: ["POST", "PUT", "PATCH"],
      match: (pathname, req) =>
        String(req.headers["content-type"] || "").toLowerCase().includes("multipart/form-data") ||
        pathname.includes("/stories") ||
        pathname.includes("/highlights") ||
        pathname.includes("/posts") ||
        pathname.includes("/gift-items") ||
        pathname.includes("/store/products"),
      message: "تم تجاوز الحد المسموح لعمليات الرفع. حاول مرة أخرى بعد 10 دقائق.",
    },
    {
      name: "writes",
      windowMs: 60 * 1000,
      maxRequests: 80,
      methods: ["POST", "PUT", "PATCH", "DELETE"],
      match: () => true,
      message: "تم تجاوز الحد المسموح للطلبات المتكررة. حاول مرة أخرى بعد دقيقة.",
    },
    {
      name: "reads",
      windowMs: 60 * 1000,
      maxRequests: 240,
      methods: ["GET"],
      match: () => true,
      message: "تم تجاوز الحد المسموح لجلب البيانات. حاول مرة أخرى بعد دقيقة.",
    },
  ];
}

const rateBuckets = new Map();
const rateRules = buildRateRules();

function getRuleForRequest(req) {
  const pathname = normalizePath(req.path || req.originalUrl || "/");
  const method = String(req.method || "GET").toUpperCase();

  if (isStaticRequest(pathname)) {
    return null;
  }

  for (const rule of rateRules) {
    if (rule.methods.includes(method) && rule.match(pathname, req)) {
      return rule;
    }
  }

  return null;
}

function cleanupExpiredBuckets() {
  const now = Date.now();
  for (const [key, bucket] of rateBuckets.entries()) {
    if (!bucket || bucket.resetAt <= now) {
      rateBuckets.delete(key);
    }
  }
}

setInterval(cleanupExpiredBuckets, 5 * 60 * 1000).unref();

function createBucketKey(req, rule) {
  const ipAddress = resolveClientIp(req);
  const userId = getUserIdFromToken(req);
  const actorKey = userId ? `user:${userId}` : `ip:${ipAddress}`;
  return `${rule.name}:${actorKey}`;
}

function applyRateLimit(req, res, next) {
  try {
    const rule = getRuleForRequest(req);
    if (!rule) {
      return next();
    }

    const now = Date.now();
    const bucketKey = createBucketKey(req, rule);
    const existingBucket = rateBuckets.get(bucketKey);

    if (!existingBucket || existingBucket.resetAt <= now) {
      rateBuckets.set(bucketKey, {
        count: 1,
        resetAt: now + rule.windowMs,
      });
      return next();
    }

    existingBucket.count += 1;

    if (existingBucket.count > rule.maxRequests) {
      const retryAfterSeconds = Math.max(1, Math.ceil((existingBucket.resetAt - now) / 1000));
      res.setHeader("Retry-After", String(retryAfterSeconds));
      return res.status(429).json({
        error: rule.message,
        retryAfterSeconds,
      });
    }

    return next();
  } catch (error) {
    console.error("requestRateLimiter error:", error);
    return next();
  }
}

module.exports = {
  applyRateLimit,
};
