require("./models/agent");
require("./models/room");
require("./models/message");
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
const initializeSocketIO = require("./socket/socketHandler.js");

require("./cron");

const app = express();
const server = http.createServer(app);
const io = socketIo(server, {
    cors: {
        origin: "*",
        methods: ["GET", "POST"]
    }
});

app.use(express.json());
app.use("/uploads", express.static("./" + "uploads"));
app.use(express.static("public"));

sequelize.sync({
    alter: true
   //  force: false,
 }).then(() => console.log("✅ Database & User table synced!"))
  .catch(err => console.error("❌ Error syncing database:", err));

app.use("/", usersRouter);
app.use("/", sendmonyRouter);
app.use("/timeofday", timeOfDayRouter);
app.use("/", counterRouter);
app.use("/", notifications);
app.use("/", agentsRouter);
app.use("/", gameRouter);
app.use("/", roomsRouter);

// تهيئة Socket.IO
initializeSocketIO(io);

server.listen(1300, () => {
    console.log(`🚀 Server running on http://localhost:1300`);
});