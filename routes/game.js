const express = require("express");
const router = express.Router();
const { User, GameRoom, GameRoomUser, GameResult } = require("../models");
const { Op } = require("sequelize");
const Sequelize = require("sequelize");

function shuffle(array) {
  for (let i = array.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [array[i], array[j]] = [array[j], array[i]];
  }
  return array;
}

router.post("/join-game/:id", async (req, res) => {
  try {
    const userId = req.params.id;

    const user = await User.findByPk(userId);
    if (!user) return res.status(404).json({ error: "المستخدم غير موجود" });

    const existing = await GameRoomUser.findOne({
      where: { userId },
      include: {
        model: GameRoom,
        where: { status: { [Op.not]: "finished" } },
        include: [
          {
            model: GameRoomUser,
            include: {
              model: User,
              attributes: ["id", "name"]
            }
          }
        ]
      }
    });

    if (existing) {
      const room = existing.GameRoom;
      const players = room.GameRoomUsers.map(gru => ({
        id: gru.User.id,
        name: gru.User.name
      }));

      return res.json({
        message: "أنت بالفعل في مباراة حالية",
        roomId: room.id,
        status: room.status,
        playersCount: players.length,
        players
      });
    }

    if (user.card < 1)
      return res.status(400).json({ error: "لا يوجد لديك بطاقة للدخول للعبة" });

    user.card -= 1;
    await user.save();

    let room = await GameRoom.findOne({
      where: { status: "waiting" },
      include: { model: GameRoomUser },
      order: [["createdAt", "ASC"]],
    });

    if (!room) room = await GameRoom.create({ status: "waiting" });

    await GameRoomUser.create({ roomId: room.id, userId });

    const players = await GameRoomUser.findAll({
      where: { roomId: room.id },
      include: User,
    });

    if (players.length === 4) {
      const shuffledPlayers = shuffle(players);
      const winner = shuffledPlayers[Math.floor(Math.random() * shuffledPlayers.length)];

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
        players: shuffledPlayers.map(p => p.userId),
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
        include: [
          {
            model: GameRoomUser,
            include: {
              model: User,
              attributes: ["id", "name"]
            }
          },
          {
            model: GameResult   
          }
        ]
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
