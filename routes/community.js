const express = require("express");
const fs = require("fs/promises");
const path = require("path");
const { Op } = require("sequelize");
const upload = require("../middlewares/uploads");
const { authenticateTokenUser } = require("../middlewares/auth");
const {
  User,
  CommunityPost,
  CommunityPostLike,
  CommunityPostComment,
} = require("../models");

const router = express.Router();
const uploadsDir = path.resolve(process.cwd(), "uploads");

function normalizeStoredPath(filePath) {
  return String(filePath || "").replace(/\\/g, "/");
}

function extractImage(images) {
  if (Array.isArray(images) && images.length > 0) {
    return String(images[0] || "").trim();
  }

  if (typeof images === "string") {
    return images.trim();
  }

  return "";
}

function sanitizeText(value) {
  if (value === undefined || value === null) return "";
  return String(value).trim();
}

function parsePositiveInteger(value, fallback) {
  const parsed = Number.parseInt(String(value ?? ""), 10);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return fallback;
  }
  return parsed;
}

async function deleteUploadedFile(filePath) {
  if (!filePath) return;

  const normalizedPath = normalizeStoredPath(filePath);
  const absolutePath = path.resolve(process.cwd(), normalizedPath);
  if (!absolutePath.startsWith(uploadsDir + path.sep) && absolutePath !== uploadsDir) {
    return;
  }

  try {
    await fs.unlink(absolutePath);
  } catch (error) {
    if (error.code !== "ENOENT") {
      throw error;
    }
  }
}

function isImageFile(file) {
  if (!file) return false;
  return String(file.mimetype || "").startsWith("image/");
}

function serializeAuthor(user) {
  if (!user) return null;

  return {
    id: user.id,
    name: user.name || "",
    image: extractImage(user.images),
    role: user.role || "user",
  };
}

function serializeComment(comment, currentUserId) {
  const plain = typeof comment.toJSON === "function" ? comment.toJSON() : comment;
  return {
    id: plain.id,
    content: plain.content || "",
    createdAt: plain.createdAt,
    updatedAt: plain.updatedAt,
    isMine: Number(plain.userId) === Number(currentUserId),
    user: serializeAuthor(plain.user),
  };
}

function serializePost(post, currentUserId, likesMap, commentsMap) {
  const plain = typeof post.toJSON === "function" ? post.toJSON() : post;
  const likes = likesMap.get(plain.id) || [];
  const comments = commentsMap.get(plain.id) || [];
  const commentsPreview = comments.slice(Math.max(0, comments.length - 2));

  return {
    id: plain.id,
    content: plain.content || "",
    image: normalizeStoredPath(plain.image || ""),
    createdAt: plain.createdAt,
    updatedAt: plain.updatedAt,
    isMine: Number(plain.userId) === Number(currentUserId),
    isLiked: likes.some((like) => Number(like.userId) === Number(currentUserId)),
    likesCount: likes.length,
    commentsCount: comments.length,
    user: serializeAuthor(plain.user),
    commentsPreview: commentsPreview.map((comment) => serializeComment(comment, currentUserId)),
  };
}

async function buildPostsPayload(posts, currentUserId) {
  const postIds = posts.map((post) => Number(post.id)).filter(Boolean);
  const likesMap = new Map();
  const commentsMap = new Map();

  if (postIds.length === 0) {
    return [];
  }

  const [likes, comments] = await Promise.all([
    CommunityPostLike.findAll({
      where: { postId: { [Op.in]: postIds } },
      attributes: ["id", "postId", "userId"],
    }),
    CommunityPostComment.findAll({
      where: { postId: { [Op.in]: postIds } },
      include: [
        {
          model: User,
          as: "user",
          attributes: ["id", "name", "images", "role"],
        },
      ],
      order: [
        ["postId", "ASC"],
        ["createdAt", "ASC"],
      ],
    }),
  ]);

  for (const like of likes) {
    const postId = Number(like.postId);
    const list = likesMap.get(postId) || [];
    list.push(like);
    likesMap.set(postId, list);
  }

  for (const comment of comments) {
    const postId = Number(comment.postId);
    const list = commentsMap.get(postId) || [];
    list.push(comment);
    commentsMap.set(postId, list);
  }

  return posts.map((post) => serializePost(post, currentUserId, likesMap, commentsMap));
}

router.get("/community/posts", authenticateTokenUser, async (req, res) => {
  try {
    const page = parsePositiveInteger(req.query.page, 1);
    const limit = Math.min(parsePositiveInteger(req.query.limit, 20), 100);
    const offset = (page - 1) * limit;

    const { rows, count } = await CommunityPost.findAndCountAll({
      include: [
        {
          model: User,
          as: "user",
          attributes: ["id", "name", "images", "role"],
        },
      ],
      order: [["createdAt", "DESC"]],
      limit,
      offset,
    });

    const posts = await buildPostsPayload(rows, req.user.id);
    res.json({
      posts,
      pagination: {
        page,
        limit,
        total: count,
        hasMore: offset + rows.length < count,
      },
    });
  } catch (error) {
    console.error("Error fetching community posts:", error);
    res.status(500).json({ error: "خطأ في جلب منشورات المجتمع" });
  }
});

router.post(
  "/community/posts",
  authenticateTokenUser,
  upload.single("image"),
  async (req, res) => {
    try {
      if (req.file && !isImageFile(req.file)) {
        await deleteUploadedFile(req.file.path);
        return res.status(400).json({ error: "يسمح فقط برفع الصور داخل المنشور" });
      }

      const content = sanitizeText(req.body.content);
      const image = req.file?.path ? normalizeStoredPath(req.file.path) : null;

      if (!content && !image) {
        if (image) {
          await deleteUploadedFile(image);
        }
        return res.status(400).json({ error: "يجب إضافة نص أو صورة على الأقل" });
      }

      const post = await CommunityPost.create({
        userId: req.user.id,
        content: content || null,
        image,
      });

      const hydrated = await CommunityPost.findByPk(post.id, {
        include: [
          {
            model: User,
            as: "user",
            attributes: ["id", "name", "images", "role"],
          },
        ],
      });

      const posts = await buildPostsPayload([hydrated], req.user.id);
      res.status(201).json(posts[0]);
    } catch (error) {
      console.error("Error creating community post:", error);
      res.status(500).json({ error: "خطأ في إنشاء المنشور" });
    }
  }
);

router.patch(
  "/community/posts/:postId",
  authenticateTokenUser,
  upload.single("image"),
  async (req, res) => {
    try {
      const post = await CommunityPost.findByPk(req.params.postId, {
        include: [
          {
            model: User,
            as: "user",
            attributes: ["id", "name", "images", "role"],
          },
        ],
      });

      if (!post) {
        if (req.file?.path) {
          await deleteUploadedFile(req.file.path);
        }
        return res.status(404).json({ error: "المنشور غير موجود" });
      }

      if (Number(post.userId) !== Number(req.user.id)) {
        if (req.file?.path) {
          await deleteUploadedFile(req.file.path);
        }
        return res.status(403).json({ error: "لا تملك صلاحية تعديل هذا المنشور" });
      }

      if (req.file && !isImageFile(req.file)) {
        await deleteUploadedFile(req.file.path);
        return res.status(400).json({ error: "يسمح فقط برفع الصور داخل المنشور" });
      }

      const nextContent =
        req.body.content !== undefined ? sanitizeText(req.body.content) : sanitizeText(post.content);
      const shouldRemoveImage = String(req.body.removeImage || "").trim() === "true";
      const previousImage = post.image;

      if (req.file?.path) {
        post.image = normalizeStoredPath(req.file.path);
      } else if (shouldRemoveImage) {
        post.image = null;
      }

      post.content = nextContent || null;

      if (!post.content && !post.image) {
        if (req.file?.path) {
          await deleteUploadedFile(req.file.path);
        }
        post.image = previousImage;
        return res.status(400).json({ error: "يجب أن يبقى في المنشور نص أو صورة" });
      }

      await post.save();

      if ((req.file?.path || shouldRemoveImage) && previousImage && previousImage !== post.image) {
        await deleteUploadedFile(previousImage);
      }

      const posts = await buildPostsPayload([post], req.user.id);
      res.json(posts[0]);
    } catch (error) {
      console.error("Error updating community post:", error);
      res.status(500).json({ error: "خطأ في تعديل المنشور" });
    }
  }
);

router.delete("/community/posts/:postId", authenticateTokenUser, async (req, res) => {
  try {
    const post = await CommunityPost.findByPk(req.params.postId);
    if (!post) {
      return res.status(404).json({ error: "المنشور غير موجود" });
    }

    if (Number(post.userId) !== Number(req.user.id)) {
      return res.status(403).json({ error: "لا تملك صلاحية حذف هذا المنشور" });
    }

    const imagePath = post.image;

    await Promise.all([
      CommunityPostLike.destroy({ where: { postId: post.id } }),
      CommunityPostComment.destroy({ where: { postId: post.id } }),
      post.destroy(),
    ]);

    await deleteUploadedFile(imagePath);

    res.json({ success: true, message: "تم حذف المنشور" });
  } catch (error) {
    console.error("Error deleting community post:", error);
    res.status(500).json({ error: "خطأ في حذف المنشور" });
  }
});

router.post("/community/posts/:postId/likes/toggle", authenticateTokenUser, async (req, res) => {
  try {
    const post = await CommunityPost.findByPk(req.params.postId);
    if (!post) {
      return res.status(404).json({ error: "المنشور غير موجود" });
    }

    const existingLike = await CommunityPostLike.findOne({
      where: {
        postId: post.id,
        userId: req.user.id,
      },
    });

    let isLiked = false;
    if (existingLike) {
      await existingLike.destroy();
    } else {
      await CommunityPostLike.create({
        postId: post.id,
        userId: req.user.id,
      });
      isLiked = true;
    }

    const likesCount = await CommunityPostLike.count({
      where: { postId: post.id },
    });

    res.json({
      success: true,
      isLiked,
      likesCount,
    });
  } catch (error) {
    console.error("Error toggling community post like:", error);
    res.status(500).json({ error: "خطأ في تحديث الإعجاب" });
  }
});

router.get("/community/posts/:postId/comments", authenticateTokenUser, async (req, res) => {
  try {
    const post = await CommunityPost.findByPk(req.params.postId);
    if (!post) {
      return res.status(404).json({ error: "المنشور غير موجود" });
    }

    const comments = await CommunityPostComment.findAll({
      where: { postId: post.id },
      include: [
        {
          model: User,
          as: "user",
          attributes: ["id", "name", "images", "role"],
        },
      ],
      order: [["createdAt", "ASC"]],
    });

    res.json({
      comments: comments.map((comment) => serializeComment(comment, req.user.id)),
      count: comments.length,
    });
  } catch (error) {
    console.error("Error fetching community comments:", error);
    res.status(500).json({ error: "خطأ في جلب التعليقات" });
  }
});

router.post("/community/posts/:postId/comments", authenticateTokenUser, async (req, res) => {
  try {
    const post = await CommunityPost.findByPk(req.params.postId);
    if (!post) {
      return res.status(404).json({ error: "المنشور غير موجود" });
    }

    const content = sanitizeText(req.body.content);
    if (!content) {
      return res.status(400).json({ error: "نص التعليق مطلوب" });
    }

    const comment = await CommunityPostComment.create({
      postId: post.id,
      userId: req.user.id,
      content,
    });

    const hydrated = await CommunityPostComment.findByPk(comment.id, {
      include: [
        {
          model: User,
          as: "user",
          attributes: ["id", "name", "images", "role"],
        },
      ],
    });

    const count = await CommunityPostComment.count({
      where: { postId: post.id },
    });

    res.status(201).json({
      comment: serializeComment(hydrated, req.user.id),
      count,
    });
  } catch (error) {
    console.error("Error creating community comment:", error);
    res.status(500).json({ error: "خطأ في إضافة التعليق" });
  }
});

router.patch("/community/comments/:commentId", authenticateTokenUser, async (req, res) => {
  try {
    const comment = await CommunityPostComment.findByPk(req.params.commentId, {
      include: [
        {
          model: User,
          as: "user",
          attributes: ["id", "name", "images", "role"],
        },
      ],
    });

    if (!comment) {
      return res.status(404).json({ error: "التعليق غير موجود" });
    }

    if (Number(comment.userId) !== Number(req.user.id)) {
      return res.status(403).json({ error: "لا تملك صلاحية تعديل هذا التعليق" });
    }

    const content = sanitizeText(req.body.content);
    if (!content) {
      return res.status(400).json({ error: "نص التعليق مطلوب" });
    }

    comment.content = content;
    await comment.save();

    res.json({
      comment: serializeComment(comment, req.user.id),
    });
  } catch (error) {
    console.error("Error updating community comment:", error);
    res.status(500).json({ error: "خطأ في تعديل التعليق" });
  }
});

router.delete("/community/comments/:commentId", authenticateTokenUser, async (req, res) => {
  try {
    const comment = await CommunityPostComment.findByPk(req.params.commentId);
    if (!comment) {
      return res.status(404).json({ error: "التعليق غير موجود" });
    }

    if (Number(comment.userId) !== Number(req.user.id)) {
      return res.status(403).json({ error: "لا تملك صلاحية حذف هذا التعليق" });
    }

    const postId = comment.postId;
    await comment.destroy();

    const count = await CommunityPostComment.count({
      where: { postId },
    });

    res.json({
      success: true,
      count,
      message: "تم حذف التعليق",
    });
  } catch (error) {
    console.error("Error deleting community comment:", error);
    res.status(500).json({ error: "خطأ في حذف التعليق" });
  }
});

module.exports = router;
