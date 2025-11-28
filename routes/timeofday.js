const express = require('express');
const router = express.Router();

router.get("/", (req, res) => {
    const now = new Date();
    const baghdadTime  = new Date(now.toLocaleString("en-US", { timeZone: "Asia/Baghdad" }));

    const hours = baghdadTime .getHours();
    const minutes = baghdadTime .getMinutes();
    const timeString = `${hours}:${minutes < 10 ? '0' + minutes : minutes}`;

    let period;

    if (hours >= 5 && hours < 17) {
        period = "morning";
    } else {
        period = "night";
    }

    res.json({
        baghdadTime: baghdadTime.toString(),
        time: timeString,
        period: period
    });
});


module.exports = router;