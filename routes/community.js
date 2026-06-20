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
  CommunityCommentLike,
  CommunityFollow,
} = require("../models");
const { sendNotificationToUser } = require("../services/notifications");

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

function isVideoFile(file) {
  if (!file) return false;
  return String(file.mimetype || "").startsWith("video/");
}

function extractSingleUpload(files, fieldName) {
  if (!files || !Array.isArray(files[fieldName]) || files[fieldName].length === 0) {
    return null;
  }
  return files[fieldName][0] || null;
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

function serializeComment(
  comment,
  currentUserId,
  likesMap = new Map(),
  {
    replies = [],
    replyToUser = null,
  } = {}
) {
  const plain = typeof comment.toJSON === "function" ? comment.toJSON() : comment;
  const likes = likesMap.get(Number(plain.id)) || [];
  return {
    id: plain.id,
    postId: plain.postId,
    parentCommentId: plain.parentCommentId ? Number(plain.parentCommentId) : null,
    content: plain.content || "",
    createdAt: plain.createdAt,
    updatedAt: plain.updatedAt,
    isMine: Number(plain.userId) === Number(currentUserId),
    likesCount: likes.length,
    isLiked: likes.some((like) => Number(like.userId) === Number(currentUserId)),
    user: serializeAuthor(plain.user),
    replyToUser: replyToUser ? serializeAuthor(replyToUser) : null,
    replies,
  };
}

function buildNestedComments(comments, currentUserId, likesMap = new Map()) {
  const plainComments = comments.map((comment) =>
    typeof comment.toJSON === "function" ? comment.toJSON() : comment
  );
  const rawById = new Map(
    plainComments.map((comment) => [Number(comment.id), comment])
  );
  const serializedById = new Map();

  for (const comment of plainComments) {
    const parentComment = comment.parentCommentId
      ? rawById.get(Number(comment.parentCommentId)) || null
      : null;
    serializedById.set(
      Number(comment.id),
      serializeComment(comment, currentUserId, likesMap, {
        replyToUser: parentComment?.user || null,
        replies: [],
      })
    );
  }

  const roots = [];
  for (const comment of plainComments) {
    const serialized = serializedById.get(Number(comment.id));
    const parentId = comment.parentCommentId ? Number(comment.parentCommentId) : null;
    if (parentId && serializedById.has(parentId)) {
      serializedById.get(parentId).replies.push(serialized);
    } else {
      roots.push(serialized);
    }
  }

  return roots;
}

async function buildCommentLikesMap(commentIds) {
  const likesMap = new Map();
  if (commentIds.length === 0) {
    return likesMap;
  }

  const likes = await CommunityCommentLike.findAll({
    where: {
      commentId: {
        [Op.in]: commentIds,
      },
    },
    attributes: ["id", "commentId", "userId"],
  });

  for (const like of likes) {
    const commentId = Number(like.commentId);
    const list = likesMap.get(commentId) || [];
    list.push(like);
    likesMap.set(commentId, list);
  }

  return likesMap;
}

async function collectCommunityCommentDescendantIds(rootCommentId) {
  const collectedIds = new Set([Number(rootCommentId)]);
  let frontier = [Number(rootCommentId)];

  while (frontier.length > 0) {
    const replies = await CommunityPostComment.findAll({
      where: {
        parentCommentId: {
          [Op.in]: frontier,
        },
      },
      attributes: ["id"],
    });

    const nextFrontier = [];
    for (const reply of replies) {
      const replyId = Number(reply.id);
      if (!collectedIds.has(replyId)) {
        collectedIds.add(replyId);
        nextFrontier.push(replyId);
      }
    }
    frontier = nextFrontier;
  }

  return Array.from(collectedIds);
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
    video: normalizeStoredPath(plain.video || ""),
    commentsEnabled: plain.commentsEnabled !== false,
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

async function buildPaginatedPostsPayload({
  currentUserId,
  page,
  limit,
  where = {},
}) {
  const safePage = parsePositiveInteger(page, 1);
  const safeLimit = Math.min(parsePositiveInteger(limit, 20), 100);
  const offset = (safePage - 1) * safeLimit;

  const { rows, count } = await CommunityPost.findAndCountAll({
    where,
    include: [
      {
        model: User,
        as: "user",
        attributes: ["id", "name", "images", "role"],
      },
    ],
    order: [["createdAt", "DESC"]],
    limit: safeLimit,
    offset,
  });

  const posts = await buildPostsPayload(rows, currentUserId);
  return {
    posts,
    pagination: {
      page: safePage,
      limit: safeLimit,
      total: count,
      hasMore: offset + rows.length < count,
    },
  };
}

async function getCommunityRelationshipSummary(targetUserId, currentUserId) {
  const [postsCount, followersCount, followingCount, followRelation] = await Promise.all([
    CommunityPost.count({ where: { userId: targetUserId } }),
    CommunityFollow.count({ where: { followingId: targetUserId } }),
    CommunityFollow.count({ where: { followerId: targetUserId } }),
    currentUserId && Number(currentUserId) !== Number(targetUserId)
      ? CommunityFollow.findOne({
          where: {
            followerId: currentUserId,
            followingId: targetUserId,
          },
          attributes: ["id"],
        })
      : null,
  ]);

  return {
    postsCount,
    followersCount,
    followingCount,
    isFollowing: !!followRelation,
  };
}

async function buildCommunityConnectionList({
  targetUserId,
  currentUserId,
  mode,
}) {
  const isFollowersMode = mode === "followers";
  const relations = await CommunityFollow.findAll({
    where: isFollowersMode
        ? { followingId: targetUserId }
        : { followerId: targetUserId },
    include: [
      {
        model: User,
        as: isFollowersMode ? "follower" : "following",
        attributes: ["id", "name", "images", "role"],
      },
    ],
    order: [["createdAt", "DESC"]],
  });

  const relationUsers = relations
    .map((relation) => relation[isFollowersMode ? "follower" : "following"])
    .filter(Boolean);

  const relationUserIds = relationUsers
    .map((user) => Number(user.id))
    .filter(Boolean);

  const followingSet = new Set();
  if (relationUserIds.length > 0 && Number.isFinite(Number(currentUserId)) && Number(currentUserId) > 0) {
    const currentUserRelations = await CommunityFollow.findAll({
      where: {
        followerId: currentUserId,
        followingId: {
          [Op.in]: relationUserIds,
        },
      },
      attributes: ["followingId"],
    });
    for (const relation of currentUserRelations) {
      followingSet.add(Number(relation.followingId));
    }
  }

  return relationUsers.map((user) => ({
    ...serializeAuthor(user),
    isFollowing: followingSet.has(Number(user.id)),
    isMe: Number(user.id) === Number(currentUserId),
  }));
}

router.get("/community/posts", authenticateTokenUser, async (req, res) => {
  try {
    const targetUserId = req.query.userId ? Number(req.query.userId) : null;
    const payload = await buildPaginatedPostsPayload({
      currentUserId: req.user.id,
      page: req.query.page,
      limit: req.query.limit,
      where: targetUserId ? { userId: targetUserId } : {},
    });
    res.json(payload);
  } catch (error) {
    console.error("Error fetching community posts:", error);
    res.status(500).json({ error: "Ø®Ø·Ø£ ÙÙŠ Ø¬Ù„Ø¨ Ù…Ù†Ø´ÙˆØ±Ø§Øª Ø§Ù„Ù…Ø¬ØªÙ…Ø¹" });
  }
});

router.get("/community/users/:userId/profile", authenticateTokenUser, async (req, res) => {
  try {
    const targetUserId = Number(req.params.userId);
    if (!Number.isFinite(targetUserId) || targetUserId <= 0) {
      return res.status(400).json({ error: "Ù…Ø¹Ø±Ù Ø§Ù„Ù…Ø³ØªØ®Ø¯Ù… ØºÙŠØ± ØµØ§Ù„Ø­" });
    }

    const user = await User.findByPk(targetUserId, {
      attributes: ["id", "name", "images", "note", "location", "role", "url", "isActive"],
    });

    if (!user || user.isActive === false) {
      return res.status(404).json({ error: "Ø§Ù„Ù…Ø³ØªØ®Ø¯Ù… ØºÙŠØ± Ù…ÙˆØ¬ÙˆØ¯" });
    }

    const [summary, postsPayload, recentFollowers] = await Promise.all([
      getCommunityRelationshipSummary(targetUserId, req.user.id),
      buildPaginatedPostsPayload({
        currentUserId: req.user.id,
        page: req.query.page,
        limit: req.query.limit,
        where: { userId: targetUserId },
      }),
      CommunityFollow.findAll({
        where: { followingId: targetUserId },
        include: [
          {
            model: User,
            as: "follower",
            attributes: ["id", "name", "images", "role"],
          },
        ],
        order: [["createdAt", "DESC"]],
        limit: 4,
      }),
    ]);

    res.json({
      user: {
        id: user.id,
        name: user.name || "",
        image: extractImage(user.images),
        bio: String(user.note || "").trim(),
        location: String(user.location || "").trim(),
        role: user.role || "user",
        url: String(user.url || "").trim(),
        isMe: Number(req.user.id) === Number(user.id),
        isFollowing: summary.isFollowing,
        postsCount: summary.postsCount,
        followersCount: summary.followersCount,
        followingCount: summary.followingCount,
        recentFollowers: recentFollowers
          .map((follow) => serializeAuthor(follow.follower))
          .filter(Boolean),
      },
      posts: postsPayload.posts,
      pagination: postsPayload.pagination,
    });
  } catch (error) {
    console.error("Error fetching community user profile:", error);
    res.status(500).json({ error: "Ø®Ø·Ø£ ÙÙŠ Ø¬Ù„Ø¨ Ù…Ù„Ù Ø§Ù„Ù…Ø³ØªØ®Ø¯Ù…" });
  }
});

router.get("/community/users/:userId/followers", authenticateTokenUser, async (req, res) => {
  try {
    const targetUserId = Number(req.params.userId);
    if (!Number.isFinite(targetUserId) || targetUserId <= 0) {
      return res.status(400).json({ error: "معرف المستخدم غير صالح" });
    }

    const users = await buildCommunityConnectionList({
      targetUserId,
      currentUserId: req.user.id,
      mode: "followers",
    });

    res.json({
      users,
      count: users.length,
    });
  } catch (error) {
    console.error("Error fetching community followers:", error);
    res.status(500).json({ error: "خطأ في جلب المتابعين" });
  }
});

router.get("/community/users/:userId/following", authenticateTokenUser, async (req, res) => {
  try {
    const targetUserId = Number(req.params.userId);
    if (!Number.isFinite(targetUserId) || targetUserId <= 0) {
      return res.status(400).json({ error: "معرف المستخدم غير صالح" });
    }

    const users = await buildCommunityConnectionList({
      targetUserId,
      currentUserId: req.user.id,
      mode: "following",
    });

    res.json({
      users,
      count: users.length,
    });
  } catch (error) {
    console.error("Error fetching community following list:", error);
    res.status(500).json({ error: "خطأ في جلب الذين يتابعهم" });
  }
});

router.post("/community/users/:userId/follow-toggle", authenticateTokenUser, async (req, res) => {
  try {
    const targetUserId = Number(req.params.userId);
    const currentUserId = Number(req.user.id);

    if (!Number.isFinite(targetUserId) || targetUserId <= 0) {
      return res.status(400).json({ error: "Ù…Ø¹Ø±Ù Ø§Ù„Ù…Ø³ØªØ®Ø¯Ù… ØºÙŠØ± ØµØ§Ù„Ø­" });
    }

    if (targetUserId === currentUserId) {
      return res.status(400).json({ error: "Ù„Ø§ ÙŠÙ…ÙƒÙ†Ùƒ Ù…ØªØ§Ø¨Ø¹Ø© Ù†ÙØ³Ùƒ" });
    }

    const targetUser = await User.findByPk(targetUserId, {
      attributes: ["id", "isActive"],
    });
    if (!targetUser || targetUser.isActive === false) {
      return res.status(404).json({ error: "Ø§Ù„Ù…Ø³ØªØ®Ø¯Ù… ØºÙŠØ± Ù…ÙˆØ¬ÙˆØ¯" });
    }

    const existing = await CommunityFollow.findOne({
      where: {
        followerId: currentUserId,
        followingId: targetUserId,
      },
    });

    let isFollowing = false;
    if (existing) {
      await existing.destroy();
    } else {
      await CommunityFollow.create({
        followerId: currentUserId,
        followingId: targetUserId,
      });
      isFollowing = true;

      try {
        const follower = await User.findByPk(currentUserId, {
          attributes: ["id", "name"],
        });
        await sendNotificationToUser(
          targetUserId,
          `${String(follower?.name || "Ù…Ø³ØªØ®Ø¯Ù…").trim()} Ø¨Ø¯Ø£ Ø¨Ù…ØªØ§Ø¨Ø¹ØªÙƒ`,
          "Ù…ØªØ§Ø¨Ø¹ Ø¬Ø¯ÙŠØ¯",
          {
            category: "community",
            subcategory: "follow",
          },
        );
      } catch (notificationError) {
        console.error("Error sending community follow notification:", notificationError);
      }
    }

    const [followersCount, followingCount] = await Promise.all([
      CommunityFollow.count({ where: { followingId: targetUserId } }),
      CommunityFollow.count({ where: { followerId: targetUserId } }),
    ]);

    res.json({
      success: true,
      isFollowing,
      followersCount,
      followingCount,
    });
  } catch (error) {
    console.error("Error toggling community follow:", error);
    res.status(500).json({ error: "Ø®Ø·Ø£ ÙÙŠ ØªØ­Ø¯ÙŠØ« Ø§Ù„Ù…ØªØ§Ø¨Ø¹Ø©" });
  }
});

router.post(
  "/community/posts",
  authenticateTokenUser,
  upload.fields([
    { name: "image", maxCount: 1 },
    { name: "video", maxCount: 1 },
  ]),
  async (req, res) => {
    const imageFile = extractSingleUpload(req.files, "image");
    const videoFile = extractSingleUpload(req.files, "video");

    try {
      if ((imageFile && !isImageFile(imageFile)) || (videoFile && !isVideoFile(videoFile))) {
        await Promise.all([
          deleteUploadedFile(imageFile?.path),
          deleteUploadedFile(videoFile?.path),
        ]);
        return res.status(400).json({ error: "ÙŠØ³Ù…Ø­ ÙÙ‚Ø· Ø¨Ø±ÙØ¹ Ø§Ù„ØµÙˆØ± Ø£Ùˆ Ø§Ù„ÙÙŠØ¯ÙŠÙˆ Ø¯Ø§Ø®Ù„ Ø§Ù„Ù…Ù†Ø´ÙˆØ±" });
      }

      const content = sanitizeText(req.body.content);
      const image = imageFile?.path ? normalizeStoredPath(imageFile.path) : null;
      const video = videoFile?.path ? normalizeStoredPath(videoFile.path) : null;

      if (!content && !image && !video) {
        await Promise.all([
          deleteUploadedFile(image),
          deleteUploadedFile(video),
        ]);
        return res.status(400).json({ error: "ÙŠØ¬Ø¨ Ø¥Ø¶Ø§ÙØ© Ù†Øµ Ø£Ùˆ ØµÙˆØ±Ø© Ø£Ùˆ ÙÙŠØ¯ÙŠÙˆ Ø¹Ù„Ù‰ Ø§Ù„Ø£Ù‚Ù„" });
      }

      const post = await CommunityPost.create({
        userId: req.user.id,
        content: content || null,
        image,
        video,
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
      await Promise.all([
        deleteUploadedFile(imageFile?.path),
        deleteUploadedFile(videoFile?.path),
      ]);
      console.error("Error creating community post:", error);
      res.status(500).json({ error: "Ø®Ø·Ø£ ÙÙŠ Ø¥Ù†Ø´Ø§Ø¡ Ø§Ù„Ù…Ù†Ø´ÙˆØ±" });
    }
  }
);

router.patch(
  "/community/posts/:postId",
  authenticateTokenUser,
  upload.fields([
    { name: "image", maxCount: 1 },
    { name: "video", maxCount: 1 },
  ]),
  async (req, res) => {
    const imageFile = extractSingleUpload(req.files, "image");
    const videoFile = extractSingleUpload(req.files, "video");

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
        await Promise.all([
          deleteUploadedFile(imageFile?.path),
          deleteUploadedFile(videoFile?.path),
        ]);
        return res.status(404).json({ error: "Ø§Ù„Ù…Ù†Ø´ÙˆØ± ØºÙŠØ± Ù…ÙˆØ¬ÙˆØ¯" });
      }

      if (Number(post.userId) !== Number(req.user.id)) {
        await Promise.all([
          deleteUploadedFile(imageFile?.path),
          deleteUploadedFile(videoFile?.path),
        ]);
        return res.status(403).json({ error: "Ù„Ø§ ØªÙ…Ù„Ùƒ ØµÙ„Ø§Ø­ÙŠØ© ØªØ¹Ø¯ÙŠÙ„ Ù‡Ø°Ø§ Ø§Ù„Ù…Ù†Ø´ÙˆØ±" });
      }

      if ((imageFile && !isImageFile(imageFile)) || (videoFile && !isVideoFile(videoFile))) {
        await Promise.all([
          deleteUploadedFile(imageFile?.path),
          deleteUploadedFile(videoFile?.path),
        ]);
        return res.status(400).json({ error: "ÙŠØ³Ù…Ø­ ÙÙ‚Ø· Ø¨Ø±ÙØ¹ Ø§Ù„ØµÙˆØ± Ø£Ùˆ Ø§Ù„ÙÙŠØ¯ÙŠÙˆ Ø¯Ø§Ø®Ù„ Ø§Ù„Ù…Ù†Ø´ÙˆØ±" });
      }

      const nextContent =
        req.body.content !== undefined ? sanitizeText(req.body.content) : sanitizeText(post.content);
      const shouldRemoveImage = String(req.body.removeImage || "").trim() === "true";
      const shouldRemoveVideo = String(req.body.removeVideo || "").trim() === "true";
      const previousImage = post.image;
      const previousVideo = post.video;

      if (imageFile?.path) {
        post.image = normalizeStoredPath(imageFile.path);
      } else if (shouldRemoveImage) {
        post.image = null;
      }

      if (videoFile?.path) {
        post.video = normalizeStoredPath(videoFile.path);
      } else if (shouldRemoveVideo) {
        post.video = null;
      }

      post.content = nextContent || null;

      if (!post.content && !post.image && !post.video) {
        await Promise.all([
          deleteUploadedFile(imageFile?.path),
          deleteUploadedFile(videoFile?.path),
        ]);
        post.image = previousImage;
        post.video = previousVideo;
        return res.status(400).json({ error: "ÙŠØ¬Ø¨ Ø£Ù† ÙŠØ¨Ù‚Ù‰ ÙÙŠ Ø§Ù„Ù…Ù†Ø´ÙˆØ± Ù†Øµ Ø£Ùˆ ØµÙˆØ±Ø© Ø£Ùˆ ÙÙŠØ¯ÙŠÙˆ" });
      }

      await post.save();

      if ((imageFile?.path || shouldRemoveImage) && previousImage && previousImage !== post.image) {
        await deleteUploadedFile(previousImage);
      }

      if ((videoFile?.path || shouldRemoveVideo) && previousVideo && previousVideo !== post.video) {
        await deleteUploadedFile(previousVideo);
      }

      const posts = await buildPostsPayload([post], req.user.id);
      res.json(posts[0]);
    } catch (error) {
      await Promise.all([
        deleteUploadedFile(imageFile?.path),
        deleteUploadedFile(videoFile?.path),
      ]);
      console.error("Error updating community post:", error);
      res.status(500).json({ error: "Ø®Ø·Ø£ ÙÙŠ ØªØ¹Ø¯ÙŠÙ„ Ø§Ù„Ù…Ù†Ø´ÙˆØ±" });
    }
  }
);

router.delete("/community/posts/:postId", authenticateTokenUser, async (req, res) => {
  try {
    const post = await CommunityPost.findByPk(req.params.postId);
    if (!post) {
      return res.status(404).json({ error: "Ø§Ù„Ù…Ù†Ø´ÙˆØ± ØºÙŠØ± Ù…ÙˆØ¬ÙˆØ¯" });
    }

    if (Number(post.userId) !== Number(req.user.id)) {
      return res.status(403).json({ error: "Ù„Ø§ ØªÙ…Ù„Ùƒ ØµÙ„Ø§Ø­ÙŠØ© Ø­Ø°Ù Ù‡Ø°Ø§ Ø§Ù„Ù…Ù†Ø´ÙˆØ±" });
    }

    const imagePath = post.image;
    const videoPath = post.video;

    await Promise.all([
      CommunityPostLike.destroy({ where: { postId: post.id } }),
      CommunityPostComment.destroy({ where: { postId: post.id } }),
      post.destroy(),
    ]);

    await Promise.all([
      deleteUploadedFile(imagePath),
      deleteUploadedFile(videoPath),
    ]);

    res.json({ success: true, message: "ØªÙ… Ø­Ø°Ù Ø§Ù„Ù…Ù†Ø´ÙˆØ±" });
  } catch (error) {
    console.error("Error deleting community post:", error);
    res.status(500).json({ error: "Ø®Ø·Ø£ ÙÙŠ Ø­Ø°Ù Ø§Ù„Ù…Ù†Ø´ÙˆØ±" });
  }
});

router.post("/community/posts/:postId/likes/toggle", authenticateTokenUser, async (req, res) => {
  try {
    const post = await CommunityPost.findByPk(req.params.postId);
    if (!post) {
      return res.status(404).json({ error: "Ø§Ù„Ù…Ù†Ø´ÙˆØ± ØºÙŠØ± Ù…ÙˆØ¬ÙˆØ¯" });
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

      if (Number(post.userId) != Number(req.user.id)) {
        try {
          const actor = await User.findByPk(req.user.id, {
            attributes: ["id", "name"],
          });
          await sendNotificationToUser(
            post.userId,
            `${String(actor?.name || "Ù…Ø³ØªØ®Ø¯Ù…").trim()} Ø£Ø¹Ø¬Ø¨ Ø¨Ù…Ù†Ø´ÙˆØ±Ùƒ`,
            "Ø¥Ø¹Ø¬Ø§Ø¨ Ø¬Ø¯ÙŠØ¯",
            {
              category: "community",
              subcategory: "like",
            },
          );
        } catch (notificationError) {
          console.error("Error sending community like notification:", notificationError);
        }
      }
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
    res.status(500).json({ error: "Ø®Ø·Ø£ ÙÙŠ ØªØ­Ø¯ÙŠØ« Ø§Ù„Ø¥Ø¹Ø¬Ø§Ø¨" });
  }
});

router.get("/community/posts/:postId/comments", authenticateTokenUser, async (req, res) => {
  try {
    const post = await CommunityPost.findByPk(req.params.postId);
    if (!post) {
      return res.status(404).json({ error: "Ø§Ù„Ù…Ù†Ø´ÙˆØ± ØºÙŠØ± Ù…ÙˆØ¬ÙˆØ¯" });
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

    const likesMap = await buildCommentLikesMap(
      comments.map((comment) => Number(comment.id)).filter(Boolean)
    );

    res.json({
      comments: buildNestedComments(comments, req.user.id, likesMap),
      count: comments.length,
    });
  } catch (error) {
    console.error("Error fetching community comments:", error);
    res.status(500).json({ error: "Ø®Ø·Ø£ ÙÙŠ Ø¬Ù„Ø¨ Ø§Ù„ØªØ¹Ù„ÙŠÙ‚Ø§Øª" });
  }
});

router.post("/community/posts/:postId/comments", authenticateTokenUser, async (req, res) => {
  try {
    const post = await CommunityPost.findByPk(req.params.postId);
    if (!post) {
      return res.status(404).json({ error: "Ø§Ù„Ù…Ù†Ø´ÙˆØ± ØºÙŠØ± Ù…ÙˆØ¬ÙˆØ¯" });
    }
    if (post.commentsEnabled === false) {
      return res.status(403).json({ error: "تم إيقاف التعليقات على هذا المنشور" });
    }

    const content = sanitizeText(req.body.content);
    if (!content) {
      return res.status(400).json({ error: "Ù†Øµ Ø§Ù„ØªØ¹Ù„ÙŠÙ‚ Ù…Ø·Ù„ÙˆØ¨" });
    }

    let parentComment = null;
    if (req.body.parentCommentId !== undefined && req.body.parentCommentId !== null && String(req.body.parentCommentId).trim() !== "") {
      parentComment = await CommunityPostComment.findByPk(req.body.parentCommentId, {
        include: [
          {
            model: User,
            as: "user",
            attributes: ["id", "name", "images", "role"],
          },
        ],
      });

      if (!parentComment || Number(parentComment.postId) !== Number(post.id)) {
        return res.status(400).json({ error: "Ø§Ù„ØªØ¹Ù„ÙŠÙ‚ Ø§Ù„Ù…Ø±Ø§Ø¯ Ø§Ù„Ø±Ø¯ Ø¹Ù„ÙŠÙ‡ ØºÙŠØ± ØµØ§Ù„Ø­" });
      }
    }

    const comment = await CommunityPostComment.create({
      postId: post.id,
      userId: req.user.id,
      parentCommentId: parentComment ? parentComment.id : null,
      content,
    });

    if (parentComment && Number(parentComment.userId) !== Number(req.user.id)) {
      try {
        const actor = await User.findByPk(req.user.id, {
          attributes: ["id", "name"],
        });
        await sendNotificationToUser(
          parentComment.userId,
          `${String(actor?.name || "Ù…Ø³ØªØ®Ø¯Ù…").trim()} Ø±Ø¯ Ø¹Ù„Ù‰ ØªØ¹Ù„ÙŠÙ‚Ùƒ`,
          "Ø±Ø¯ Ø¬Ø¯ÙŠØ¯",
          {
            category: "community",
            subcategory: "reply",
          },
        );
      } catch (notificationError) {
        console.error("Error sending community reply notification:", notificationError);
      }
    } else if (Number(post.userId) != Number(req.user.id)) {
      try {
        const actor = await User.findByPk(req.user.id, {
          attributes: ["id", "name"],
        });
        await sendNotificationToUser(
          post.userId,
          `${String(actor?.name || "Ù…Ø³ØªØ®Ø¯Ù…").trim()} Ø¹Ù„Ù‘Ù‚ Ø¹Ù„Ù‰ Ù…Ù†Ø´ÙˆØ±Ùƒ`,
          "ØªØ¹Ù„ÙŠÙ‚ Ø¬Ø¯ÙŠØ¯",
          {
            category: "community",
            subcategory: "comment",
          },
        );
      } catch (notificationError) {
        console.error("Error sending community comment notification:", notificationError);
      }
    }

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
      comment: serializeComment(hydrated, req.user.id, new Map(), {
        replyToUser: parentComment?.user || null,
        replies: [],
      }),
      count,
    });
  } catch (error) {
    console.error("Error creating community comment:", error);
    res.status(500).json({ error: "Ø®Ø·Ø£ ÙÙŠ Ø¥Ø¶Ø§ÙØ© Ø§Ù„ØªØ¹Ù„ÙŠÙ‚" });
  }
});

router.post("/community/posts/:postId/comments/toggle", authenticateTokenUser, async (req, res) => {
  try {
    const post = await CommunityPost.findByPk(req.params.postId);
    if (!post) {
      return res.status(404).json({ error: "المنشور غير موجود" });
    }

    if (Number(post.userId) !== Number(req.user.id)) {
      return res.status(403).json({ error: "لا تملك صلاحية تعديل هذا المنشور" });
    }

    post.commentsEnabled = post.commentsEnabled === false;
    await post.save();

    res.json({
      success: true,
      commentsEnabled: post.commentsEnabled === true,
      message: post.commentsEnabled === true
          ? "تم تفعيل التعليقات"
          : "تم إيقاف التعليقات",
    });
  } catch (error) {
    console.error("Error toggling community post comments:", error);
    res.status(500).json({ error: "خطأ في تحديث حالة التعليقات" });
  }
});

router.post("/community/comments/:commentId/likes/toggle", authenticateTokenUser, async (req, res) => {
  try {
    const comment = await CommunityPostComment.findByPk(req.params.commentId);
    if (!comment) {
      return res.status(404).json({ error: "Ø§Ù„ØªØ¹Ù„ÙŠÙ‚ ØºÙŠØ± Ù…ÙˆØ¬ÙˆØ¯" });
    }

    const existingLike = await CommunityCommentLike.findOne({
      where: {
        commentId: comment.id,
        userId: req.user.id,
      },
    });

    let isLiked = false;
    if (existingLike) {
      await existingLike.destroy();
    } else {
      await CommunityCommentLike.create({
        commentId: comment.id,
        userId: req.user.id,
      });
      isLiked = true;

      if (Number(comment.userId) !== Number(req.user.id)) {
        try {
          const actor = await User.findByPk(req.user.id, {
            attributes: ["id", "name"],
          });
          await sendNotificationToUser(
            comment.userId,
            `${String(actor?.name || "Ù…Ø³ØªØ®Ø¯Ù…").trim()} Ø£Ø¹Ø¬Ø¨ Ø¨ØªØ¹Ù„ÙŠÙ‚Ùƒ`,
            "Ø¥Ø¹Ø¬Ø§Ø¨ Ø¨ØªØ¹Ù„ÙŠÙ‚",
            {
              category: "community",
              subcategory: "comment_like",
            },
          );
        } catch (notificationError) {
          console.error("Error sending community comment like notification:", notificationError);
        }
      }
    }

    const likesCount = await CommunityCommentLike.count({
      where: { commentId: comment.id },
    });

    res.json({
      success: true,
      isLiked,
      likesCount,
    });
  } catch (error) {
    console.error("Error toggling community comment like:", error);
    res.status(500).json({ error: "Ø®Ø·Ø£ ÙÙŠ ØªØ­Ø¯ÙŠØ« Ø¥Ø¹Ø¬Ø§Ø¨ Ø§Ù„ØªØ¹Ù„ÙŠÙ‚" });
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
      return res.status(404).json({ error: "Ø§Ù„ØªØ¹Ù„ÙŠÙ‚ ØºÙŠØ± Ù…ÙˆØ¬ÙˆØ¯" });
    }

    if (Number(comment.userId) !== Number(req.user.id)) {
      return res.status(403).json({ error: "Ù„Ø§ ØªÙ…Ù„Ùƒ ØµÙ„Ø§Ø­ÙŠØ© ØªØ¹Ø¯ÙŠÙ„ Ù‡Ø°Ø§ Ø§Ù„ØªØ¹Ù„ÙŠÙ‚" });
    }

    const content = sanitizeText(req.body.content);
    if (!content) {
      return res.status(400).json({ error: "Ù†Øµ Ø§Ù„ØªØ¹Ù„ÙŠÙ‚ Ù…Ø·Ù„ÙˆØ¨" });
    }

    comment.content = content;
    await comment.save();

    res.json({
      comment: serializeComment(comment, req.user.id, new Map(), {
        replies: [],
      }),
    });
  } catch (error) {
    console.error("Error updating community comment:", error);
    res.status(500).json({ error: "Ø®Ø·Ø£ ÙÙŠ ØªØ¹Ø¯ÙŠÙ„ Ø§Ù„ØªØ¹Ù„ÙŠÙ‚" });
  }
});

router.delete("/community/comments/:commentId", authenticateTokenUser, async (req, res) => {
  try {
    const comment = await CommunityPostComment.findByPk(req.params.commentId);
    if (!comment) {
      return res.status(404).json({ error: "Ø§Ù„ØªØ¹Ù„ÙŠÙ‚ ØºÙŠØ± Ù…ÙˆØ¬ÙˆØ¯" });
    }

    if (Number(comment.userId) !== Number(req.user.id)) {
      return res.status(403).json({ error: "Ù„Ø§ ØªÙ…Ù„Ùƒ ØµÙ„Ø§Ø­ÙŠØ© Ø­Ø°Ù Ù‡Ø°Ø§ Ø§Ù„ØªØ¹Ù„ÙŠÙ‚" });
    }

    const postId = comment.postId;
    const relatedCommentIds = await collectCommunityCommentDescendantIds(comment.id);

    await Promise.all([
      CommunityCommentLike.destroy({
        where: {
          commentId: {
            [Op.in]: relatedCommentIds,
          },
        },
      }),
      CommunityPostComment.destroy({
        where: {
          id: {
            [Op.in]: relatedCommentIds,
          },
        },
      }),
    ]);

    const count = await CommunityPostComment.count({
      where: { postId },
    });

    res.json({
      success: true,
      count,
      message: "ØªÙ… Ø­Ø°Ù Ø§Ù„ØªØ¹Ù„ÙŠÙ‚",
    });
  } catch (error) {
    console.error("Error deleting community comment:", error);
    res.status(500).json({ error: "Ø®Ø·Ø£ ÙÙŠ Ø­Ø°Ù Ø§Ù„ØªØ¹Ù„ÙŠÙ‚" });
  }
});

module.exports = router;





