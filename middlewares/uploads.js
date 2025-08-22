const multer = require("multer");
const path = require("path");
const fs = require("fs");

const uploadDir = "uploads";

// التحقق من وجود المجلد "uploads"، وإذا لم يكن موجودًا يتم إنشاؤه
if (!fs.existsSync(uploadDir)) {
  fs.mkdirSync(uploadDir);
}


const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    cb(null, "uploads/");
  },
  filename: (req, file, cb) => {
    cb(null, Date.now() + path.extname(file.originalname));
  }
});

const upload = multer({ 
  storage: storage,
  limits: { fileSize: 5 * 1024 * 1024 }, // حد الحجم 5MB لكل صورة
  fileFilter: (req, file, cb) => {
    if (file.mimetype.startsWith("image/")) {
      cb(null, true);
    } else {
      cb(new Error("❌ الملف يجب أن يكون صورة"), false);
    }
  }
});

module.exports = upload;
