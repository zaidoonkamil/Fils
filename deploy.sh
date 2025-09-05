#!/bin/bash

# سكربت رفع الملفات للسيرفر
SERVER="root@fils.khaleeafashion.com"
PROJECT_PATH="/path/to/your/project"

echo "🚀 رفع الملفات للسيرفر..."

# رفع الملفات المحدثة
scp routes/rooms.js $SERVER:$PROJECT_PATH/routes/
scp routes/user.js $SERVER:$PROJECT_PATH/routes/
scp socket/socketHandler.js $SERVER:$PROJECT_PATH/socket/
scp server.js $SERVER:$PROJECT_PATH/
scp public/index.html $SERVER:$PROJECT_PATH/public/

echo "✅ تم رفع الملفات بنجاح!"

# إعادة تشغيل الخادم
echo "🔄 إعادة تشغيل الخادم..."
ssh $SERVER "cd $PROJECT_PATH && sudo pm2 restart chat-rooms"

echo "🎉 تم الانتهاء! جرب الآن: https://fils.khaleeafashion.com/."
