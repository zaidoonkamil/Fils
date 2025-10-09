require("./models/agent");
const Room = require("./models/room");
const Message = require("./models/message");
const User = require("./models/user");
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
const cors = require("cors");
require("./cron");

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
  res.header("Access-Control-Allow-Origin", "*"); 
  res.header("Access-Control-Allow-Methods", "GET, POST, PUT, DELETE, OPTIONS"); 
  res.header("Access-Control-Allow-Headers", "Origin, X-Requested-With, Content-Type, Accept, Authorization"); 
  next();
});

app.use("/uploads", express.static("./" + "uploads"));
app.use(express.static("public"));


sequelize.sync({
     force: false,
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

const chatNamespace = io.of("/chat");
chat.initChatSocket(chatNamespace);

const roomNamespace = io.of("/rooms");
initializeSocketIO(roomNamespace);


server.listen(1300, '0.0.0.0', () => { 
    console.log(`🚀 Server running on http://0.0.0.0:1300`);
});