const express = require("express");

function timerRoute(io) {
  const router = express.Router();

  // راوت بدء العداد
  router.get("/start/:seconds", (req, res) => {
    const seconds = parseInt(req.params.seconds);
    let remainingTime = seconds;

    // إرسال بدء العداد لكل المشتركين
    io.emit("startCountdown", remainingTime);

    const timer = setInterval(() => {
      if (remainingTime > 0) {
        remainingTime--;
        io.emit("countdown", remainingTime);
      } else {
        clearInterval(timer);
        io.emit("countdownFinished");
      }
    }, 1000);

    res.send(`تم بدء العداد لمدة ${seconds} ثانية`);
  });

  return router;
}

module.exports = timerRoute;
