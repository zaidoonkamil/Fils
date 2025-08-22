const User = require("./user");
const Counter = require("./counter");
const UserCounter = require("./usercounters");
const DailyAction = require("./DailyAction");
const TransferHistory = require("./transferHistory");
const CounterSale = require("./counterSale");
const WithdrawalRequest = require("./withdrawalRequest");
const UserDevice = require("./user_device");

User.hasMany(UserCounter, { foreignKey: 'userId', constraints: false });
UserCounter.belongsTo(User, { foreignKey: 'userId', constraints: false });

Counter.hasMany(UserCounter, { foreignKey: 'counterId', constraints: false });
UserCounter.belongsTo(Counter, { foreignKey: 'counterId', constraints: false });

User.hasOne(DailyAction, { foreignKey: "user_id", constraints: false });
DailyAction.belongsTo(User, { foreignKey: "user_id", constraints: false });

User.hasMany(TransferHistory, { as: 'SentTransfers', foreignKey: 'senderId', constraints: false });
User.hasMany(TransferHistory, { as: 'ReceivedTransfers', foreignKey: 'receiverId', constraints: false });
TransferHistory.belongsTo(User, { as: 'Sender', foreignKey: 'senderId', constraints: false });
TransferHistory.belongsTo(User, { as: 'Receiver', foreignKey: 'receiverId', constraints: false });

UserCounter.hasMany(CounterSale, { foreignKey: 'userCounterId', constraints: false });
CounterSale.belongsTo(UserCounter, { foreignKey: 'userCounterId', constraints: false });

User.hasMany(CounterSale, { foreignKey: 'userId', constraints: false });
CounterSale.belongsTo(User, { foreignKey: 'userId', constraints: false });

WithdrawalRequest.belongsTo(User, { foreignKey: 'userId', as: 'user', constraints: false });
User.hasMany(WithdrawalRequest, { foreignKey: 'userId', as: 'withdrawalRequests', constraints: false });

User.hasMany(UserDevice, { foreignKey: 'user_id', as: 'devices', onDelete: 'CASCADE' });
UserDevice.belongsTo(User, { foreignKey: 'user_id', as: 'user', onDelete: 'CASCADE' });


module.exports = {
  User,
  DailyAction,
  Counter,
  UserCounter,
  TransferHistory,
  CounterSale,
  WithdrawalRequest,
  UserDevice,
};
