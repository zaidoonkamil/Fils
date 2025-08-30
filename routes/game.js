const express = require("express");
const router = express.Router();
const { User, GameRoom, GameRoomUser, GameResult } = require("../models");
const { Op } = require("sequelize");

router.post("/join-game/:id", async (req, res) => {
  try {
    const userId = req.params.id;
    const user = await User.findByPk(userId);
    if (!user) {
      return res.status(404).json({ error: "المستخدم غير موجود" });
    }

    if (user.card < 1) {
      return res.status(400).json({ error: "لا يوجد لديك بطاقة للدخول للعبة" });
    }
    user.card -= 1;
    await user.save();

    const existing = await GameRoomUser.findOne({
      where: { userId },
      include: { model: GameRoom, where: { status: { [Op.not]: "finished" } } },
    });
    if (existing) {
      return res.status(400).json({ error: "أنت بالفعل في غرفة أخرى!" });
    }

    let room = await GameRoom.findOne({
      where: { status: "waiting" },
      include: { model: GameRoomUser },
      order: [["createdAt", "ASC"]],
    });

    if (!room) {
      room = await GameRoom.create({ status: "waiting" });
    }
    await GameRoomUser.create({ roomId: room.id, userId });

    const players = await GameRoomUser.findAll({ where: { roomId: room.id } });

    if (players.length === 4) {
      const winnerIndex = Math.floor(Math.random() * 4);
      const winner = players[winnerIndex];

      const userWinner = await User.findByPk(winner.userId);
      const rewardGems = 50; 
      userWinner.Jewel += rewardGems;
      await userWinner.save();

      await GameResult.create({ roomId: room.id, winnerId: winner.userId, rewardGems });

      room.status = "finished";
      await room.save();

      return res.json({
        message: "اللعبة اكتملت",
        winner: winner.userId,
        rewardGems,
        players: players.map(p => p.userId),
      });
    }

    res.json({
      message: "تم الانضمام للغرفة، انتظر اكتمال 4 لاعبين",
      roomId: room.id,
      currentPlayers: players.map(p => p.userId),
      playersCount: players.length,
    });

  } catch (err) {
    console.error("❌ خطأ أثناء الانضمام للعبة:", err);
    res.status(500).json({ error: "حدث خطأ أثناء الدخول للعبة" });
  }
});

router.get("/last-finished-game/:userId", async (req, res) => {
  try {
    const { userId } = req.params;

    const user = await User.findByPk(userId);
    if (!user) {
      return res.status(404).json({ error: "المستخدم غير موجود" });
    }

    const lastRoomUser = await GameRoomUser.findOne({
      where: { userId },
      include: {
        model: GameRoom,
        where: { status: "finished" },
        include: {
          model: GameRoomUser,
          include: {
            model: User,
            attributes: ["id", "name"] 
          }
        }
      },
      order: [["createdAt", "DESC"]]
    });

    if (!lastRoomUser || !lastRoomUser.GameRoom) {
      return res.status(404).json({ message: "لا توجد لعبة منتهية للمستخدم" });
    }

    const room = lastRoomUser.GameRoom;
    const players = room.GameRoomUsers.map(gru => ({
      id: gru.User.id,
      name: gru.User.name
    }));

    res.json({
      roomId: room.id,
      winnerId: room.GameResult ? room.GameResult.winnerId : null,
      rewardGems: room.GameResult ? room.GameResult.rewardGems : null,
      players
    });

  } catch (err) {
    console.error("❌ خطأ أثناء جلب آخر لعبة:", err);
    res.status(500).json({ error: "حدث خطأ أثناء جلب آخر لعبة" });
  }
});

module.exports = router;
