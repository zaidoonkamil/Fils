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
const DeviceFingerprint = require("./device_fingerprint");
const DeviceFingerprintUser = require("./device_fingerprint_user");
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
const NotificationRead = require("./NotificationRead");
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
const UserInternalVerification = require("./UserInternalVerification");
const AdminBalanceLog = require("./AdminBalanceLog");
const RoomJoinSubscription = require("./RoomJoinSubscription");
const PremiumFrame = require("./PremiumFrame");
const UserPremiumFrame = require("./UserPremiumFrame");
const CommunityPost = require("./CommunityPost");
const CommunityPostLike = require("./CommunityPostLike");
const CommunityPostComment = require("./CommunityPostComment");
const CommunityCommentLike = require("./CommunityCommentLike");
const CommunityFollow = require("./CommunityFollow");
const CommunityStory = require("./CommunityStory");


Room.hasMany(UserGift, { foreignKey: "roomId", as: "giftInstances", onDelete: "SET NULL" });
UserGift.belongsTo(Room, { foreignKey: "roomId", as: "room", onDelete: "SET NULL" });

User.hasMany(UserGift, { foreignKey: "roomOwnerId", as: "roomOwnerGifts", onDelete: "SET NULL" });
UserGift.belongsTo(User, { foreignKey: "roomOwnerId", as: "roomOwner", onDelete: "SET NULL" });

Room.belongsTo(User, { foreignKey: 'creatorId', as: 'creator', onDelete: 'CASCADE' });
Room.hasMany(Message, { foreignKey: 'roomId', as: 'messages', onDelete: 'CASCADE' });
Message.belongsTo(User, { foreignKey: 'userId', as: 'user', onDelete: 'CASCADE' });
Message.belongsTo(Room, { foreignKey: 'roomId', as: 'room', onDelete: 'CASCADE' });
Message.belongsTo(Message, { foreignKey: 'replyToId', as: 'replyTo', constraints: false });
Message.hasMany(Message, { foreignKey: 'replyToId', as: 'replies', constraints: false });
Room.hasMany(RoomJoinSubscription, { foreignKey: "roomId", as: "joinSubscriptions", onDelete: "CASCADE" });
RoomJoinSubscription.belongsTo(Room, { foreignKey: "roomId", as: "room", onDelete: "CASCADE" });
User.hasMany(RoomJoinSubscription, { foreignKey: "userId", as: "joinedRooms", onDelete: "CASCADE" });
RoomJoinSubscription.belongsTo(User, { foreignKey: "userId", as: "user", onDelete: "CASCADE" });

PremiumFrame.hasMany(UserPremiumFrame, { foreignKey: "frameId", as: "subscriptions", onDelete: "CASCADE" });
UserPremiumFrame.belongsTo(PremiumFrame, { foreignKey: "frameId", as: "frame", onDelete: "CASCADE" });
User.hasMany(UserPremiumFrame, { foreignKey: "userId", as: "premiumFrames", onDelete: "CASCADE" });
UserPremiumFrame.belongsTo(User, { foreignKey: "userId", as: "user", onDelete: "CASCADE" });

User.hasMany(CommunityPost, { foreignKey: "userId", as: "communityPosts", onDelete: "CASCADE" });
CommunityPost.belongsTo(User, { foreignKey: "userId", as: "user", onDelete: "CASCADE" });

CommunityPost.hasMany(CommunityPostLike, { foreignKey: "postId", as: "likes", onDelete: "CASCADE" });
CommunityPostLike.belongsTo(CommunityPost, { foreignKey: "postId", as: "post", onDelete: "CASCADE" });
User.hasMany(CommunityPostLike, { foreignKey: "userId", as: "communityLikes", onDelete: "CASCADE" });
CommunityPostLike.belongsTo(User, { foreignKey: "userId", as: "user", onDelete: "CASCADE" });

CommunityPost.hasMany(CommunityPostComment, {
  foreignKey: "postId",
  as: "comments",
  onDelete: "CASCADE",
});
CommunityPostComment.belongsTo(CommunityPost, {
  foreignKey: "postId",
  as: "post",
  onDelete: "CASCADE",
});
User.hasMany(CommunityPostComment, {
  foreignKey: "userId",
  as: "communityComments",
  onDelete: "CASCADE",
});
CommunityPostComment.belongsTo(User, {
  foreignKey: "userId",
  as: "user",
  onDelete: "CASCADE",
});
CommunityPostComment.belongsTo(CommunityPostComment, {
  foreignKey: "parentCommentId",
  as: "parentComment",
  onDelete: "CASCADE",
});
CommunityPostComment.hasMany(CommunityPostComment, {
  foreignKey: "parentCommentId",
  as: "replies",
  onDelete: "CASCADE",
});
CommunityPostComment.hasMany(CommunityCommentLike, {
  foreignKey: "commentId",
  as: "likes",
  onDelete: "CASCADE",
});
CommunityCommentLike.belongsTo(CommunityPostComment, {
  foreignKey: "commentId",
  as: "comment",
  onDelete: "CASCADE",
});
User.hasMany(CommunityCommentLike, {
  foreignKey: "userId",
  as: "communityCommentLikes",
  onDelete: "CASCADE",
});
CommunityCommentLike.belongsTo(User, {
  foreignKey: "userId",
  as: "user",
  onDelete: "CASCADE",
});

User.hasMany(CommunityFollow, {
  foreignKey: "followerId",
  as: "followingRelations",
  onDelete: "CASCADE",
});
CommunityFollow.belongsTo(User, {
  foreignKey: "followerId",
  as: "follower",
  onDelete: "CASCADE",
});
User.hasMany(CommunityFollow, {
  foreignKey: "followingId",
  as: "followersRelations",
  onDelete: "CASCADE",
});
CommunityFollow.belongsTo(User, {
  foreignKey: "followingId",
  as: "following",
  onDelete: "CASCADE",
});

User.hasMany(CommunityStory, {
  foreignKey: "userId",
  as: "communityStories",
  onDelete: "CASCADE",
});
CommunityStory.belongsTo(User, {
  foreignKey: "userId",
  as: "user",
  onDelete: "CASCADE",
});

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

DeviceFingerprint.hasMany(DeviceFingerprintUser, { foreignKey: "device_id", as: "deviceUsers", onDelete: "CASCADE" });
DeviceFingerprintUser.belongsTo(DeviceFingerprint, { foreignKey: "device_id", as: "device", onDelete: "CASCADE" });

User.hasMany(DeviceFingerprintUser, { foreignKey: "user_id", as: "deviceLinks", onDelete: "CASCADE" });
DeviceFingerprintUser.belongsTo(User, { foreignKey: "user_id", as: "user", onDelete: "CASCADE" });

ChatMessage.belongsTo(User, { as: "sender", foreignKey: "senderId", onDelete: 'CASCADE' });
ChatMessage.belongsTo(User, { as: "receiver", foreignKey: "receiverId", onDelete: 'CASCADE' });
User.hasMany(ChatMessage, { as: "sentMessages", foreignKey: "senderId", onDelete: 'CASCADE' });
User.hasMany(ChatMessage, { as: "receivedMessages", foreignKey: "receiverId", onDelete: 'CASCADE' });

User.hasOne(AgentRequest, { foreignKey: 'userId', onDelete: 'CASCADE' });
AgentRequest.belongsTo(User, { foreignKey: 'userId', onDelete: 'CASCADE' });

User.hasOne(UserInternalVerification, { foreignKey: "userId", as: "internalVerification", onDelete: "CASCADE" });
UserInternalVerification.belongsTo(User, { foreignKey: "userId", as: "user", onDelete: "CASCADE" });

User.hasMany(AdminBalanceLog, { foreignKey: "adminId", as: "adminBalanceActions", onDelete: "CASCADE" });
AdminBalanceLog.belongsTo(User, { foreignKey: "adminId", as: "admin", onDelete: "CASCADE" });

User.hasMany(AdminBalanceLog, { foreignKey: "targetUserId", as: "receivedAdminBalanceActions", onDelete: "CASCADE" });
AdminBalanceLog.belongsTo(User, { foreignKey: "targetUserId", as: "targetUser", onDelete: "CASCADE" });

NotificationLog.hasMany(NotificationRead, {
  foreignKey: "notificationId",
  as: "reads",
  onDelete: "CASCADE",
});
NotificationRead.belongsTo(NotificationLog, {
  foreignKey: "notificationId",
  as: "notification",
  onDelete: "CASCADE",
});
User.hasMany(NotificationRead, {
  foreignKey: "userId",
  as: "notificationReads",
  onDelete: "CASCADE",
});
NotificationRead.belongsTo(User, {
  foreignKey: "userId",
  as: "user",
  onDelete: "CASCADE",
});

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
GiftItem.hasMany(UserGift, { foreignKey: 'giftItemId', as: 'instances', onDelete: 'CASCADE' });
UserGift.belongsTo(GiftItem, { foreignKey: 'giftItemId', as: 'item', onDelete: 'CASCADE' });

User.hasMany(UserGift, { foreignKey: 'userId', as: 'myGifts', onDelete: 'CASCADE' });
UserGift.belongsTo(User, { foreignKey: 'userId', as: 'user', onDelete: 'CASCADE' });

User.hasMany(UserGift, { foreignKey: 'senderId', as: 'sentGifts', onDelete: 'CASCADE' });
UserGift.belongsTo(User, { foreignKey: 'senderId', as: 'sender', onDelete: 'CASCADE' });

User.hasMany(Referrals, { foreignKey: "referrerId", as: "myReferrals", onDelete: "CASCADE" });
User.hasMany(Referrals, { foreignKey: "referredUserId", as: "usedReferral", onDelete: "CASCADE" });

Referrals.belongsTo(User, { foreignKey: "referrerId", as: "referrer", onDelete: "CASCADE" });
Referrals.belongsTo(User, { foreignKey: "referredUserId", as: "referredUser", onDelete: "CASCADE" });

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
  DeviceFingerprint,
  DeviceFingerprintUser,
  NotificationLog,
  NotificationRead,
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
  UserGift,
  UserInternalVerification,
  AdminBalanceLog,
  RoomJoinSubscription,
  PremiumFrame,
  UserPremiumFrame,
  CommunityPost,
  CommunityPostLike,
  CommunityPostComment,
  CommunityCommentLike,
  CommunityFollow,
  CommunityStory
};
