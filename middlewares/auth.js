const jwt = require("jsonwebtoken");
const dotenv = require("dotenv");
const { User, Settings } = require("../models");

dotenv.config();

const ADMIN_TOKEN_VALID_AFTER_IAT_KEY = "admin_token_valid_after_iat";

async function resolveAccountBanMessage(user) {
  if (!user || user.accountBanActive !== true) {
    return null;
  }

  const now = new Date();
  const banUntil =
    user.accountBanUntil instanceof Date
      ? user.accountBanUntil
      : user.accountBanUntil
      ? new Date(user.accountBanUntil)
      : null;

  if (banUntil && banUntil <= now) {
    user.accountBanActive = false;
    user.accountBanReason = null;
    user.accountBanUntil = null;
    user.accountBanBy = null;
    await user.save();
    return null;
  }

  const reason =
    typeof user.accountBanReason === "string" && user.accountBanReason.trim()
      ? user.accountBanReason.trim()
      : "بدون سبب محدد";
  const untilText = banUntil
    ? `${banUntil.getFullYear()}/${String(banUntil.getMonth() + 1).padStart(2, "0")}/${String(
        banUntil.getDate()
      ).padStart(2, "0")}`
    : "غير محدد";

  return `تم حظر حسابك مؤقتًا. السبب: ${reason}. ينتهي الحظر بتاريخ ${untilText}`;
}

async function getAdminTokenValidAfterIat() {
  const currentUnixSeconds = Math.floor(Date.now() / 1000);

  const [setting] = await Settings.findOrCreate({
    where: { key: ADMIN_TOKEN_VALID_AFTER_IAT_KEY },
    defaults: {
      value: String(currentUnixSeconds),
      description: "Reject admin JWTs issued before this unix timestamp",
      isActive: true,
    },
  });

  const parsedValue = parseInt(String(setting.value || "").trim(), 10);
  if (Number.isNaN(parsedValue) || parsedValue <= 0) {
    setting.value = String(currentUnixSeconds);
    setting.isActive = true;
    await setting.save();
    return currentUnixSeconds;
  }

  return parsedValue;
}

async function enforceAdminTokenPolicy(decoded, res) {
  if (!decoded || decoded.role !== "admin") {
    return true;
  }

  const decodedIat = Number(decoded.iat || 0);
  if (!decodedIat) {
    res.status(401).json({ error: "Admin token is invalid, please login again" });
    return false;
  }

  const validAfterIat = await getAdminTokenValidAfterIat();
  if (decodedIat < validAfterIat) {
    res.status(401).json({ error: "Admin token expired, please login again" });
    return false;
  }

  return true;
}

const authenticateToken = (req, res, next) => {
  try {
    const authHeader = req.headers.authorization;

    if (!authHeader || !authHeader.startsWith("Bearer ")) {
      return res.status(401).json({ error: "Token not provided. Unauthorized access." });
    }

    const token = authHeader.split(" ")[1];

    jwt.verify(token, process.env.JWT_SECRET, async (err, decoded) => {
      if (err) {
        if (err.name === "TokenExpiredError") {
          return res.status(401).json({ error: "Token expired, please login again" });
        }
        return res.status(403).json({ error: "Invalid token" });
      }

      const policyAllowed = await enforceAdminTokenPolicy(decoded, res);
      if (!policyAllowed) {
        return;
      }

      req.user = decoded;
      next();
    });
  } catch (error) {
    console.error("require authenticateToken error:", error);
    return res.status(500).json({ error: "Internal server error" });
  }
};

const requireAdmin = async (req, res, next) => {
  try {
    const authHeader = req.headers.authorization;

    if (!authHeader) {
      return res.status(401).json({ error: "Token not provided. Unauthorized access." });
    }

    const token = authHeader.startsWith("Bearer ")
      ? authHeader.split(" ")[1]
      : authHeader;

    jwt.verify(token, process.env.JWT_SECRET, async (err, decoded) => {
      if (err) {
        if (err.name === "TokenExpiredError") {
          return res.status(401).json({ error: "Token expired, please login again" });
        }
        return res.status(403).json({ error: "Invalid token" });
      }

      const policyAllowed = await enforceAdminTokenPolicy(decoded, res);
      if (!policyAllowed) {
        return;
      }

      if (!decoded || decoded.role !== "admin") {
        return res.status(403).json({ error: "Admin token required" });
      }

      const user = await User.findByPk(decoded.id);

      if (!user) {
        return res.status(401).json({ error: "User not found" });
      }

      if (user.isActive === false) {
        return res.status(403).json({ error: "تم حظر حسابك" });
      }

      const accountBanMessage = await resolveAccountBanMessage(user);
      if (accountBanMessage) {
        return res.status(403).json({ error: accountBanMessage });
      }

      if (user.role !== "admin") {
        return res.status(403).json({ error: "Admins only" });
      }

      req.user = {
        id: user.id,
        email: user.email,
        role: user.role,
      };

      next();
    });
  } catch (error) {
    console.error("requireAdmin error:", error);
    return res.status(500).json({ error: "Internal server error" });
  }
};

const authenticateTokenUser = async (req, res, next) => {
  try {
    const authHeader = req.headers.authorization;

    if (!authHeader) {
      return res.status(401).json({ error: "Token not provided. Unauthorized access." });
    }

    const token = authHeader.startsWith("Bearer ")
      ? authHeader.split(" ")[1]
      : authHeader;

    jwt.verify(token, process.env.JWT_SECRET, async (err, decoded) => {
      if (err) {
        if (err.name === "TokenExpiredError") {
          return res.status(401).json({ error: "Token expired, please login again" });
        }
        return res.status(403).json({ error: "Invalid token" });
      }

      const policyAllowed = await enforceAdminTokenPolicy(decoded, res);
      if (!policyAllowed) {
        return;
      }

      const user = await User.findByPk(decoded.id);

      if (!user) {
        return res.status(401).json({ error: "User not found" });
      }

      if (user.isActive === false) {
        return res.status(403).json({ error: "تم حظر حسابك" });
      }

      const accountBanMessage = await resolveAccountBanMessage(user);
      if (accountBanMessage) {
        return res.status(403).json({ error: accountBanMessage });
      }

      req.user = {
        id: user.id,
        email: user.email,
        role: user.role,
        isActive: user.isActive,
        isVerified: user.isVerified,
      };

      next();
    });
  } catch (error) {
    console.error("authenticateTokenUser error:", error);
    return res.status(500).json({ error: "Internal server error" });
  }
};

module.exports = { authenticateToken, requireAdmin, authenticateTokenUser };
