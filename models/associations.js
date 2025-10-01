const User = require("./user");
const Room = require("./room");
const Message = require("./message");
const Settings = require("./settings");

// تعريف العلاقات
Room.belongsTo(User, { 
    foreignKey: 'creatorId', 
    as: 'creator' 
});

Room.hasMany(Message, { 
    foreignKey: 'roomId', 
    as: 'messages' 
});

Message.belongsTo(User, { 
    foreignKey: 'userId', 
    as: 'user' 
});

Message.belongsTo(Room, { 
    foreignKey: 'roomId', 
    as: 'room' 
});

module.exports = {
    User,
    Room,
    Message,
    Settings
};
