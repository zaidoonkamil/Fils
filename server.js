require("./models/agent");
const Room = require("./models/room");
const Message = require("./models/message");
const User = require("./models/user");
require("./models/associations");
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
const chat = require("./routes/chatRoutes");
const initializeSocketIO = require("./socket/socketHandler.js");

require("./cron");

const app = express();
const server = http.createServer(app);
const io = socketIo(server, {
    cors: {
        origin: "*",
       // origin: ["https://fils.khaleeafashion.com", "http://localhost:1300"],
        methods: ["GET", "POST"],
        allowedHeaders: ["*"],
        credentials: true
    },
    allowEIO3: true
});
io.on("connection", (socket) => {
  console.log("🟢 New client connected:", socket.id);
  console.log("👉 Query params:", socket.handshake.query);

  socket.on("disconnect", () => {
    console.log("🔴 Client disconnected:", socket.id);
  });
});
app.use(express.json());
app.use("/uploads", express.static("./" + "uploads"));
app.use(express.static("public"));

sequelize.sync({
     alter: true,
    logging: console.log })
    .then(() => {
    console.log("✅ Database & User table synced!");
 }).catch(err => console.error("❌ Error syncing database:", err));

app.get("/", (req, res) => {
    res.sendFile(__dirname + "/public/index.html");
});

app.use("/", usersRouter);
app.use("/", sendmonyRouter);
app.use("/timeofday", timeOfDayRouter);
app.use("/", counterRouter);
app.use("/", notifications);
app.use("/", agentsRouter);
app.use("/", gameRouter);
app.use("/", roomsRouter);
app.use("/", adsRouter);
app.use("/", chat.router);

chat.initChatSocket(io);
initializeSocketIO(io);

server.listen(1300, '0.0.0.0', () => { 
    console.log(`🚀 Server running on http://0.0.0.0:1300`);
});