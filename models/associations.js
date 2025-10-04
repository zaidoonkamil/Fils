const User = require("./user");
const Room = require("./room");
const Message = require("./message");
const Settings = require("./settings");

// تعريف العلاقات
Room.belongsTo(User, { foreignKey: 'creatorId', as: 'creator', onDelete: 'CASCADE' });

Room.hasMany(Message, { foreignKey: 'roomId', as: 'messages', onDelete: 'CASCADE' });

Message.belongsTo(User, { foreignKey: 'userId', as: 'user', onDelete: 'CASCADE' });

Message.belongsTo(Room, { foreignKey: 'roomId', as: 'room', onDelete: 'CASCADE' });

module.exports = {
    User,
    Room,
    Message,
    Settings
};
