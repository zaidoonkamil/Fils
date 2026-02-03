const User = require("./user");
const Room = require("./room");
const Message = require("./message");
const Settings = require("./settings");
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
const Referrals = require('./referrals');
const Tearms = require("./TermsAndConditions");
const AgentRequest = require('./AgentRequest');
const OtpCode = require("./OtpCode");
const NotificationLog = require("./notification_log");
const StoreCategory = require("./StoreCategory");
const DigitalProduct = require("./DigitalProduct");
const DigitalProductCode = require("./DigitalProductCode");
const ProductPurchase = require("./ProductPurchase");
const ConsumableCategory = require("./ConsumableCategory");
const ConsumableProduct = require("./ConsumableProduct");
const ConsumablePurchase = require("./ConsumablePurchase");
const GiftItem = require("./GiftItem");
const DominoMatch = require("./DominoMatch");
const DominoQueue = require("./DominoQueue");
const UserGift = require("./UserGift");


Room.hasMany(UserGift, { foreignKey: "roomId", as: "giftInstances", onDelete: "SET NULL" });
UserGift.belongsTo(Room, { foreignKey: "roomId", as: "room", onDelete: "SET NULL" });

User.hasMany(UserGift, { foreignKey: "roomOwnerId", as: "roomOwnerGifts", onDelete: "SET NULL" });
UserGift.belongsTo(User, { foreignKey: "roomOwnerId", as: "roomOwner", onDelete: "SET NULL" });

Room.belongsTo(User, { foreignKey: 'creatorId', as: 'creator', onDelete: 'CASCADE' });
Room.hasMany(Message, { foreignKey: 'roomId', as: 'messages', onDelete: 'CASCADE' });
Message.belongsTo(User, { foreignKey: 'userId', as: 'user', onDelete: 'CASCADE' });
Message.belongsTo(Room, { foreignKey: 'roomId', as: 'room', onDelete: 'CASCADE' });

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

ChatMessage.belongsTo(User, { as: "sender", foreignKey: "senderId", onDelete: 'CASCADE' });
ChatMessage.belongsTo(User, { as: "receiver", foreignKey: "receiverId", onDelete: 'CASCADE' });
User.hasMany(ChatMessage, { as: "sentMessages", foreignKey: "senderId", onDelete: 'CASCADE' });
User.hasMany(ChatMessage, { as: "receivedMessages", foreignKey: "receiverId", onDelete: 'CASCADE' });

User.hasOne(AgentRequest, { foreignKey: 'userId', onDelete: 'CASCADE' });
AgentRequest.belongsTo(User, { foreignKey: 'userId', onDelete: 'CASCADE' });

// علاقات المتجر الرقمي
StoreCategory.hasMany(DigitalProduct, { foreignKey: 'categoryId', as: 'products', onDelete: 'CASCADE' });
DigitalProduct.belongsTo(StoreCategory, { foreignKey: 'categoryId', as: 'category', onDelete: 'CASCADE' });

User.hasMany(ProductPurchase, { foreignKey: 'userId', as: 'purchases', onDelete: 'CASCADE' });
ProductPurchase.belongsTo(User, { foreignKey: 'userId', as: 'user', onDelete: 'CASCADE' });

DigitalProduct.hasMany(ProductPurchase, { foreignKey: 'productId', as: 'purchaseHistory', onDelete: 'CASCADE' });
ProductPurchase.belongsTo(DigitalProduct, { foreignKey: 'productId', as: 'product', onDelete: 'CASCADE' });

// أكواد المنتجات (كودات متعددة لكل منتج)
DigitalProduct.hasMany(DigitalProductCode, { foreignKey: 'productId', as: 'codes', onDelete: 'CASCADE' });
DigitalProductCode.belongsTo(DigitalProduct, { foreignKey: 'productId', as: 'product', onDelete: 'CASCADE' });

// علاقات متجر المنتجات الاستهلاكية
ConsumableCategory.hasMany(ConsumableProduct, { foreignKey: 'categoryId', as: 'products', onDelete: 'CASCADE' });
ConsumableProduct.belongsTo(ConsumableCategory, { foreignKey: 'categoryId', as: 'category', onDelete: 'CASCADE' });

User.hasMany(ConsumablePurchase, { foreignKey: 'userId', as: 'consumablePurchases', onDelete: 'CASCADE' });
ConsumablePurchase.belongsTo(User, { foreignKey: 'userId', as: 'user', onDelete: 'CASCADE' });

ConsumableProduct.hasMany(ConsumablePurchase, { foreignKey: 'productId', as: 'purchaseHistory', onDelete: 'CASCADE' });
ConsumablePurchase.belongsTo(ConsumableProduct, { foreignKey: 'productId', as: 'product', onDelete: 'CASCADE' });

// علاقات نظام الهدايا المتقدم
// 1. GiftItem Relationships
GiftItem.hasMany(UserGift, { foreignKey: 'giftItemId', as: 'instances', onDelete: 'CASCADE' });
UserGift.belongsTo(GiftItem, { foreignKey: 'giftItemId', as: 'item', onDelete: 'CASCADE' });

// 2. User Relationships
User.hasMany(UserGift, { foreignKey: 'userId', as: 'myGifts', onDelete: 'CASCADE' }); // Gifts owned by user
UserGift.belongsTo(User, { foreignKey: 'userId', as: 'user', onDelete: 'CASCADE' }); // Owner

User.hasMany(UserGift, { foreignKey: 'senderId', as: 'sentGifts', onDelete: 'CASCADE' }); // Gifts sent by user (historical)
UserGift.belongsTo(User, { foreignKey: 'senderId', as: 'sender', onDelete: 'CASCADE' }); // Sender (optional)

module.exports = {
  User,
  Referrals,
  Room,
  OtpCode,
  Message,
  Settings,
  Counter,
  UserCounter,
  DailyAction,
  TransferHistory,
  CounterSale,
  WithdrawalRequest,
  UserDevice,
  NotificationLog,
  GameRoom,
  GameRoomUser,
  GameResult,
  IdShop,
  Tearms,
  AgentRequest,
  ChatMessage,
  StoreCategory,
  DigitalProduct,
  DigitalProductCode,
  ProductPurchase,
  ConsumableCategory,
  ConsumableProduct,
  ConsumablePurchase,
  GiftItem,
  DominoMatch,
  DominoQueue,
  UserGift
};
