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
const chat = require("./routes/chatRoutes");
const { initializeSocketIO } = require("./socket/socketHandler.js");
const { initDominoSocket } = require("./socket/dominoHandler");
const cors = require("cors");
require("./cron");
require("dotenv").config();


const app = express();
const server = http.createServer(app);
const io = socketIo(server, {
    cors: {
        origin: "*",
        methods: ["GET", "POST"],
        allowedHeaders: ["*"],
        credentials: true
    },
    allowEIO3: true
});

app.use(cors({ origin: "*" }));
app.use(express.json());

app.use((req, res, next) => {
    res.setHeader("Cache-Control", "no-store, no-cache, must-revalidate, private");
    res.setHeader("Pragma", "no-cache");
    res.setHeader("Expires", "0");
    next();
});

app.use((req, res, next) => {
    res.header("Access-Control-Allow-Origin", "*");
    res.header("Access-Control-Allow-Methods", "GET, POST, PUT, DELETE, OPTIONS");
    res.header("Access-Control-Allow-Headers", "Origin, X-Requested-With, Content-Type, Accept, Authorization");
    next();
});

app.use("/uploads", express.static("./" + "uploads"));
app.use(express.static("public", {
    setHeaders: (res) => {
        res.setHeader("Cache-Control", "no-store, no-cache, must-revalidate, private");
    }
}));

sequelize.sync({
    force: false,
    logging: console.log
})
.then(async () => {
        await Counter.sync({ alter: true });
        console.log('Database and Counter table synced successfully');
    }).catch(err => console.error('Error syncing database:', err));



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
app.use("/", stateCounterRouter);
app.use("/", chat.router);

const chatNamespace = io.of("/chat");
chat.initChatSocket(chatNamespace);

const dominoNamespace = io.of("/domino");
initDominoSocket(dominoNamespace);

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
        message: err.message,
    });
});


const PORT = process.env.PORT || 1400;
const HOST = process.env.HOST || "0.0.0.0";

server.listen(PORT, HOST, () => {
    console.log(`Server running on http://${HOST}:${PORT}`);
});
