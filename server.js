require("./models/agent");
const Room = require("./models/room");
const Message = require("./models/message");
const Counter = require("./models/counter");
const User = require("./models/user");
require("./models/device_fingerprint");
require("./models/device_fingerprint_user");
const express = require("express");
const http = require("http");
const socketIo = require("socket.io");
const sequelize = require("./config/db");
const usersRouter = require("./routes/user");
const timeOfDayRouter = require("./routes/timeofday.js");
const sendmonyRouter = require("./routes/send_mony.js");
const counterRouter = require("./routes/counter.js");
const notifications = require("./routes/notifications.js");
const agentsRouter = require("./routes/agents.js");
const gameRouter = require("./routes/game.js");
const roomsRouter = require("./routes/rooms.js");
const adsRouter = require("./routes/ads");
const store = require("./routes/store");
const consumable = require("./routes/consumable");
const stateCounterRouter = require("./routes/StateCounter");
const giftSystemRouter = require("./routes/giftSystem");
const premiumFramesRouter = require("./routes/premiumFrames");
const entryEffectsRouter = require("./routes/entryEffects");
const communityRouter = require("./routes/community");
const chat = require("./routes/chatRoutes");
const reportsRouter = require("./routes/reports");
const { applyRateLimit } = require("./middlewares/requestRateLimiter");
const { initializeSocketIO } = require("./socket/socketHandler.js");
const { initDominoSocket } = require("./socket/dominoHandler");
const ensureSchema = require("./scripts/ensureSchema");
const runPreSyncCleanup = require("./scripts/preSyncCleanup");
const cors = require("cors");
require("./cron");
require("dotenv").config();


const isProduction = process.env.NODE_ENV === "production";
const productionAllowedOrigins = [
    "https://pro.kakplus.com",
    "https://ssdashss.kakplus.com",
];
const developmentAllowedOrigins = [
    ...productionAllowedOrigins,
    "http://localhost",
    "http://localhost:3000",
    "http://localhost:5000",
    "http://localhost:8080",
    "http://localhost:1400",
    "http://127.0.0.1:3000",
    "http://127.0.0.1:5000",
    "http://127.0.0.1:8080",
    "http://127.0.0.1:1400",
];
const defaultAllowedOrigins = isProduction ? productionAllowedOrigins : developmentAllowedOrigins;
function normalizeOrigin(origin) {
    return String(origin || "").trim().replace(/\/+$/, "");
}

const configuredAllowedOrigins = (process.env.CORS_ORIGINS || "")
    .split(",")
    .map(normalizeOrigin)
    .filter(Boolean);
const allowedOrigins = Array.from(new Set([
    ...defaultAllowedOrigins.map(normalizeOrigin),
    ...configuredAllowedOrigins,
]));

function isOriginAllowed(origin) {
    if (!origin) return true;
    const normalizedOrigin = normalizeOrigin(origin);
    if (allowedOrigins.includes(normalizedOrigin)) return true;

    try {
        const parsedOrigin = new URL(normalizedOrigin);
        const hostname = parsedOrigin.hostname.toLowerCase();

        if (!isProduction && (hostname === "localhost" || hostname === "127.0.0.1")) {
            return true;
        }

        return false;
    } catch (_) {
        return false;
    }
}

const corsOptions = {
    origin(origin, callback) {
        if (isOriginAllowed(origin)) {
            return callback(null, true);
        }
        return callback(new Error("Not allowed by CORS"));
    },
    methods: ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
    allowedHeaders: ["Origin", "X-Requested-With", "Content-Type", "Accept", "Authorization"],
    credentials: true,
};

const app = express();
app.set("trust proxy", 1);
const server = http.createServer(app);
const io = socketIo(server, {
    cors: {
        origin(origin, callback) {
            if (isOriginAllowed(origin)) {
                return callback(null, true);
            }
            return callback(new Error("Not allowed by CORS"));
        },
        methods: ["GET", "POST"],
        allowedHeaders: ["Authorization", "Content-Type"],
        credentials: true
    },
    allowEIO3: true
});

app.use(cors(corsOptions));
app.use(express.json({ limit: "1mb" }));
app.use(express.urlencoded({ extended: true, limit: "1mb" }));
app.use(applyRateLimit);

app.use((req, res, next) => {
    res.setHeader("Cache-Control", "no-store, no-cache, must-revalidate, private");
    res.setHeader("Pragma", "no-cache");
    res.setHeader("Expires", "0");
    next();
});

app.use("/uploads", express.static("./" + "uploads"));
app.use(express.static("public", {
    setHeaders: (res) => {
        res.setHeader("Cache-Control", "no-store, no-cache, must-revalidate, private");
    }
}));

app.use("/", usersRouter);
app.use("/", sendmonyRouter);
app.use("/timeofday", timeOfDayRouter);
app.use("/", counterRouter);
app.use("/", notifications);
app.use("/", agentsRouter);
app.use("/", gameRouter);
app.use("/", roomsRouter);
app.use("/", adsRouter);
app.use("/", store);
app.use("/", consumable);
app.use("/", giftSystemRouter);
app.use("/", premiumFramesRouter);
app.use("/", entryEffectsRouter);
app.use("/", communityRouter);
app.use("/", stateCounterRouter);
app.use("/", chat.router);
app.use("/", reportsRouter);

const chatNamespace = io.of("/chat");
chat.initChatSocket(chatNamespace);
app.set("chatNamespace", chatNamespace);

const dominoNamespace = io.of("/domino");
initDominoSocket(dominoNamespace);
app.set("dominoNamespace", dominoNamespace);

const roomNamespace = io.of("/rooms");
initializeSocketIO(roomNamespace);
app.set("roomsIO", roomNamespace);

// Global Error Handler for Debugging
app.use((err, req, res, next) => {
    console.error("Global Error Caught:", err);
    try {
        const fs = require("fs");
        const logMsg = `\n[${new Date().toISOString()}] GLOBAL ERROR: ${err.message}\nStack: ${err.stack}\n`;
        fs.appendFileSync("global_error_log.txt", logMsg);
    } catch (e) {}
    
    res.status(500).json({
        error: "حدث خطأ داخلي في السيرفر",
        ...(isProduction ? {} : { message: err.message }),
    });
});


const PORT = process.env.PORT || 1400;
const HOST = process.env.HOST || "0.0.0.0";

async function bootstrap() {
    try {
        await sequelize.authenticate();
        await runPreSyncCleanup();
        await ensureSchema();
        console.log("Database schema ensured successfully");

        server.listen(PORT, HOST, () => {
            console.log(`Server running on http://${HOST}:${PORT}`);
        });
    } catch (err) {
        console.error("Error bootstrapping server:", err);
        process.exit(1);
    }
}

bootstrap();
