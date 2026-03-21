const jwt = require("jsonwebtoken");
const dotenv = require("dotenv");
const { User } = require("../models");

dotenv.config();

const authenticateToken = (req, res, next) => {
  try {
    const authHeader = req.headers.authorization;

    if (!authHeader || !authHeader.startsWith("Bearer ")) {
      return res.status(401).json({ error: "Token not provided. Unauthorized access." });
    }

    const token = authHeader.split(" ")[1];

    jwt.verify(token, process.env.JWT_SECRET, (err, decoded) => {
      if (err) {
        if (err.name === "TokenExpiredError") {
          return res.status(401).json({ error: "Token expired, please login again" });
        }
        return res.status(403).json({ error: "Invalid token" });
      }

      req.user = decoded;
      next();
    });
  } catch (error) {
    console.error("❌ authenticateToken error:", error);
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

      const user = await User.findByPk(decoded.id);

      if (!user) {
        return res.status(401).json({ error: "User not found" });
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
    console.error("❌ requireAdmin error:", error);
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

      const user = await User.findByPk(decoded.id);

      if (!user) {
        return res.status(401).json({ error: "User not found" });
      }

      if (user.isActive === false) {
        return res.status(403).json({ error: "User is blocked" });
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
    console.error("❌ authenticateToken error:", error);
    return res.status(500).json({ error: "Internal server error" });
  }
};

module.exports = { authenticateToken, requireAdmin, authenticateTokenUser };