const User = require("./user");
const Counter = require("./counter");
const UserCounter = require("./usercounters");
const DailyAction = require("./DailyAction");
const TransferHistory = require("./transferHistory");
const CounterSale = require("./counterSale");
const WithdrawalRequest = require("./withdrawalRequest");
const UserDevice = require("./user_device");
const GameRoom = require("./GameRoom");
const GameRoomUser = require("./GameRoomUser");
const GameResult = require("./GameResult");
const IdShop = require("./IdShop");
const ChatMessage = require("./ChatMessage");

User.hasMany(UserCounter, { foreignKey: 'userId', constraints: false });
UserCounter.belongsTo(User, { foreignKey: 'userId', constraints: false });

Counter.hasMany(UserCounter, { foreignKey: 'counterId', constraints: false });
UserCounter.belongsTo(Counter, { foreignKey: 'counterId', constraints: false });

User.hasOne(DailyAction, { foreignKey: "user_id", constraints: false });
DailyAction.belongsTo(User, { foreignKey: "user_id", constraints: false });

User.hasMany(TransferHistory, { as: 'SentTransfers', foreignKey: 'senderId', onDelete: 'CASCADE' });
User.hasMany(TransferHistory, { as: 'ReceivedTransfers', foreignKey: 'receiverId', onDelete: 'CASCADE' });
TransferHistory.belongsTo(User, { as: 'Sender', foreignKey: 'senderId', onDelete: 'CASCADE' });
TransferHistory.belongsTo(User, { as: 'Receiver', foreignKey: 'receiverId', onDelete: 'CASCADE' });

UserCounter.hasMany(CounterSale, { foreignKey: 'userCounterId', constraints: false });
CounterSale.belongsTo(UserCounter, { foreignKey: 'userCounterId', constraints: false });

User.hasMany(CounterSale, { foreignKey: 'userId', constraints: false });
CounterSale.belongsTo(User, { foreignKey: 'userId', constraints: false });

WithdrawalRequest.belongsTo(User, { foreignKey: 'userId', as: 'user', onDelete: 'CASCADE' });
User.hasMany(WithdrawalRequest, { foreignKey: 'userId', as: 'withdrawalRequests', onDelete: 'CASCADE' });

User.hasMany(UserDevice, { foreignKey: 'user_id', as: 'devices', onDelete: 'CASCADE' });
UserDevice.belongsTo(User, { foreignKey: 'user_id', as: 'user', onDelete: 'CASCADE' });

ChatMessage.belongsTo(User, { as: "sender", foreignKey: "senderId" , onDelete: 'CASCADE'});
ChatMessage.belongsTo(User, { as: "receiver", foreignKey: "receiverId" , onDelete: 'CASCADE' });

User.hasMany(ChatMessage, { as: "sentMessages", foreignKey: "senderId" , onDelete: 'CASCADE' });
User.hasMany(ChatMessage, { as: "receivedMessages", foreignKey: "receiverId" , onDelete: 'CASCADE'});

module.exports = {
  User,
  DailyAction,
  Counter,
  UserCounter,
  TransferHistory,
  CounterSale,
  WithdrawalRequest,
  UserDevice,
  GameRoom,
  GameRoomUser,
  GameResult,
  IdShop,
  ChatMessage
};
