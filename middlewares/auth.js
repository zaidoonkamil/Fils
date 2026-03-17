const jwt = require('jsonwebtoken');
const dotenv = require('dotenv');
dotenv.config();
app.use(authenticateToken);
const { User } = require("../models");

app.get("/protectedRoute", (req, res) => {
    res.status(200).json({ message: "This route is protected" });
});

jwt.verify(token, process.env.JWT_SECRET, (err, user) => {
    if (err && err.name === 'TokenExpiredError') {
        return res.status(401).json({ error: "Token expired, please login again" });
    } else if (err) {
        return res.status(403).json({ error: "Forbidden" });
    }
    req.user = user;
    next();
});

const authenticateToken = (req, res, next) => {
    const token = req.headers['authorization']?.split(' ')[1]; // استخراج التوكن من الهيدر

    if (!token) {
        return res.status(401).json({ error: "Token not provided. Unauthorized access." });
    }

    jwt.verify(token, process.env.JWT_SECRET, (err, user) => {
        if (err) {
            return res.status(403).json({ error: "Invalid or expired token" });
        }
        req.user = user; // إضافة معلومات المستخدم إلى الـ request
        next(); // الانتقال إلى الـ route التالي
    });
};

const requireAdmin = async (req, res, next) => {
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

      const user = await User.findByPk(decoded.id);

      if (!user) {
        return res.status(401).json({ error: "User not found" });
      }

      if (user.role !== "admin") {
        return res.status(403).json({ error: "Admins only" });
      }

      req.user = user;
      next();
    });
  } catch (error) {
    console.error("❌ requireAdmin error:", error);
    return res.status(500).json({ error: "Internal server error" });
  }
};

module.exports = { authenticateToken, requireAdmin };
