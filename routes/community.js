const express = require("express");
const fs = require("fs/promises");
const path = require("path");
const { Op, Sequelize } = require("sequelize");
const upload = require("../middlewares/uploads");
const { authenticateTokenUser } = require("../middlewares/auth");
const {
  User,
  CommunityPost,
  CommunityPostLike,
  CommunityPostComment,
  CommunityCommentLike,
  CommunityFollow,
  CommunityStory,
  CommunityHighlight,
  CommunityHighlightItem,
} = require("../models");
const { sendNotificationToUser } = require("../services/notifications");

const router = express.Router();
const uploadsDir = path.resolve(process.cwd(), "uploads");
const COMMUNITY_STORY_LIFETIME_HOURS = 24;

function normalizeStoredPath(filePath) {
  return String(filePath || "").replace(/\\/g, "/");
}

function extractImage(images) {
  if (Array.isArray(images) && images.length > 0) {
    return String(images[0] || "").trim();
  }

  if (typeof images === "string" && images.trim().length > 0) {
    const normalized = images.trim();
    if (normalized.startsWith("[")) {
      try {
        const parsed = JSON.parse(normalized);
        if (Array.isArray(parsed) && parsed.length > 0) {
          return String(parsed[0] || "").trim();
        }
      } catch (_) {
        // ignore invalid JSON and fall through to raw string
      }
    }
    return normalized;
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

function serializeAuthor(user, activeStoryUserIds = null) {
  if (!user) return null;

  return {
    id: user.id,
    name: user.name || "",
    image: extractImage(user.images),
    role: user.role || "user",
    hasActiveStory: activeStoryUserIds
      ? activeStoryUserIds.has(Number(user.id))
      : false,
  };
}

function serializeComment(
  comment,
  currentUserId,
  likesMap = new Map(),
  activeStoryUserIds = null,
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
    user: serializeAuthor(plain.user, activeStoryUserIds),
    replyToUser: replyToUser ? serializeAuthor(replyToUser, activeStoryUserIds) : null,
    replies,
  };
}

function buildNestedComments(
  comments,
  currentUserId,
  likesMap = new Map(),
  activeStoryUserIds = null
) {
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
      serializeComment(comment, currentUserId, likesMap, activeStoryUserIds, {
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

async function buildActiveStoryUserSet(userIds) {
  const normalizedIds = Array.from(
    new Set(
      (userIds || [])
        .map((value) => Number(value))
        .filter((value) => Number.isFinite(value) && value > 0)
    )
  );

  if (normalizedIds.length === 0) {
    return new Set();
  }

  const activeStories = await CommunityStory.findAll({
    where: {
      userId: {
        [Op.in]: normalizedIds,
      },
      expiresAt: {
        [Op.gt]: new Date(),
      },
    },
    attributes: ["userId"],
    group: ["userId"],
  });

  return new Set(activeStories.map((story) => Number(story.userId)));
}

function serializePost(post, currentUserId, likesMap, commentsMap, activeStoryUserIds) {
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
    user: serializeAuthor(plain.user, activeStoryUserIds),
    commentsPreview: commentsPreview.map((comment) =>
      serializeComment(comment, currentUserId, new Map(), activeStoryUserIds)
    ),
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

  const relatedUserIds = [];
  for (const post of posts) {
    if (post.userId) relatedUserIds.push(post.userId);
    if (post.user?.id) relatedUserIds.push(post.user.id);
  }
  for (const comment of comments) {
    if (comment.userId) relatedUserIds.push(comment.userId);
    if (comment.user?.id) relatedUserIds.push(comment.user.id);
  }

  const activeStoryUserIds = await buildActiveStoryUserSet(relatedUserIds);

  return posts.map((post) =>
    serializePost(post, currentUserId, likesMap, commentsMap, activeStoryUserIds)
  );
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

  const activeStoryUserIds = await buildActiveStoryUserSet(relationUserIds);

  return relationUsers.map((user) => ({
    ...serializeAuthor(user, activeStoryUserIds),
    isFollowing: followingSet.has(Number(user.id)),
    isMe: Number(user.id) === Number(currentUserId),
  }));
}

async function buildCommunitySearchResults({
  query,
  currentUserId,
  limit,
}) {
  const normalizedQuery = sanitizeText(query);
  const safeLimit = Math.min(parsePositiveInteger(limit, 20), 50);

  if (!normalizedQuery) {
    return [];
  }

  const isNumericQuery = /^\d+$/.test(normalizedQuery);
  if (!isNumericQuery && normalizedQuery.length < 3) {
    return [];
  }

  const where = {
    isActive: true,
  };

  if (isNumericQuery) {
    where[Op.and] = [
      Sequelize.where(
        Sequelize.cast(Sequelize.col("id"), "CHAR"),
        {
          [Op.like]: `${normalizedQuery}%`,
        }
      ),
    ];
  } else {
    where.name = {
      [Op.like]: `%${normalizedQuery}%`,
    };
  }

  const users = await User.findAll({
    where,
    attributes: ["id", "name", "images", "role", "location", "note"],
    order: isNumericQuery ? [["id", "ASC"]] : [["name", "ASC"]],
    limit: safeLimit,
  });

  const userIds = users.map((user) => Number(user.id)).filter(Boolean);
  const followingSet = new Set();

  if (userIds.length > 0 && Number.isFinite(Number(currentUserId)) && Number(currentUserId) > 0) {
    const currentUserRelations = await CommunityFollow.findAll({
      where: {
        followerId: currentUserId,
        followingId: {
          [Op.in]: userIds,
        },
      },
      attributes: ["followingId"],
    });

    for (const relation of currentUserRelations) {
      followingSet.add(Number(relation.followingId));
    }
  }

  const activeStoryUserIds = await buildActiveStoryUserSet(userIds);

  return users.map((user) => ({
    ...serializeAuthor(user, activeStoryUserIds),
    location: String(user.location || "").trim(),
    bio: String(user.note || "").trim(),
    isFollowing: followingSet.has(Number(user.id)),
    isMe: Number(user.id) === Number(currentUserId),
  }));
}

function serializeStory(story, activeStoryUserIds = null) {
  const plain = typeof story.toJSON === "function" ? story.toJSON() : story;
  return {
    id: plain.id,
    image: normalizeStoredPath(plain.image || ""),
    createdAt: plain.createdAt,
    expiresAt: plain.expiresAt,
    user: serializeAuthor(plain.user, activeStoryUserIds),
  };
}

function serializeHighlightItem(item) {
  const plain = typeof item.toJSON === "function" ? item.toJSON() : item;
  return {
    id: plain.id,
    image: normalizeStoredPath(plain.image || ""),
    createdAt: plain.createdAt,
  };
}

function serializeHighlight(highlight) {
  const plain = typeof highlight.toJSON === "function" ? highlight.toJSON() : highlight;
  const items = Array.isArray(plain.items) ? plain.items : [];
  return {
    id: plain.id,
    title: String(plain.title || "").trim(),
    coverImage: normalizeStoredPath(plain.coverImage || items[0]?.image || ""),
    itemsCount: items.length,
    createdAt: plain.createdAt,
    items: items.map((item) => serializeHighlightItem(item)),
  };
}

async function buildCommunityStoriesFeed(currentUserId) {
  const stories = await CommunityStory.findAll({
    where: {
      expiresAt: {
        [Op.gt]: new Date(),
      },
    },
    include: [
      {
        model: User,
        as: "user",
        attributes: ["id", "name", "images", "role", "isActive"],
        where: {
          isActive: true,
        },
      },
    ],
    order: [
      ["createdAt", "DESC"],
      ["id", "DESC"],
    ],
  });

  const grouped = new Map();
  for (const story of stories) {
    const userId = Number(story.userId);
    if (!grouped.has(userId)) {
      grouped.set(userId, []);
    }
    grouped.get(userId).push(story);
  }

  const activeStoryUserIds = await buildActiveStoryUserSet([...grouped.keys()]);

  const previews = Array.from(grouped.entries())
    .map(([userId, userStories]) => {
      const latestStory = userStories[0];
      return {
        user: serializeAuthor(latestStory.user, activeStoryUserIds),
        storiesCount: userStories.length,
        latestCreatedAt: latestStory.createdAt,
        isMe: Number(userId) === Number(currentUserId),
      };
    })
    .sort((left, right) => {
      if (left.isMe && !right.isMe) return -1;
      if (!left.isMe && right.isMe) return 1;
      return new Date(right.latestCreatedAt).getTime() - new Date(left.latestCreatedAt).getTime();
    });

  return {
    stories: previews,
    myHasStory: previews.some((item) => item.isMe),
  };
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
    res.status(500).json({ error: "خطأ في جلب منشورات المجتمع" });
  }
});

router.get("/community/stories", authenticateTokenUser, async (req, res) => {
  try {
    const payload = await buildCommunityStoriesFeed(req.user.id);
    res.json(payload);
  } catch (error) {
    console.error("Error fetching community stories feed:", error);
    res.status(500).json({ error: "خطأ في جلب الستوري" });
  }
});

router.get("/community/users/:userId/stories", authenticateTokenUser, async (req, res) => {
  try {
    const targetUserId = Number(req.params.userId);
    if (!Number.isFinite(targetUserId) || targetUserId <= 0) {
      return res.status(400).json({ error: "معرف المستخدم غير صالح" });
    }

    const stories = await CommunityStory.findAll({
      where: {
        userId: targetUserId,
        expiresAt: {
          [Op.gt]: new Date(),
        },
      },
      include: [
        {
          model: User,
          as: "user",
          attributes: ["id", "name", "images", "role", "isActive"],
          where: {
            isActive: true,
          },
        },
      ],
      order: [
        ["createdAt", "ASC"],
        ["id", "ASC"],
      ],
    });

    if (stories.length === 0) {
      return res.status(404).json({ error: "لا توجد ستوري فعالة لهذا المستخدم" });
    }

    const activeStoryUserIds = await buildActiveStoryUserSet([targetUserId]);

    res.json({
      user: serializeAuthor(stories[0].user, activeStoryUserIds),
      stories: stories.map((story) => serializeStory(story, activeStoryUserIds)),
      count: stories.length,
    });
  } catch (error) {
    console.error("Error fetching community user stories:", error);
    res.status(500).json({ error: "خطأ في جلب الستوري" });
  }
});

router.get("/community/users/:userId/highlights", authenticateTokenUser, async (req, res) => {
  try {
    const targetUserId = Number(req.params.userId);
    if (!Number.isFinite(targetUserId) || targetUserId <= 0) {
      return res.status(400).json({ error: "معرف المستخدم غير صالح" });
    }

    const highlights = await CommunityHighlight.findAll({
      where: { userId: targetUserId },
      include: [
        {
          model: CommunityHighlightItem,
          as: "items",
          attributes: ["id", "image", "createdAt"],
        },
      ],
      order: [
        ["createdAt", "DESC"],
        [{ model: CommunityHighlightItem, as: "items" }, "createdAt", "ASC"],
      ],
    });

    res.json({
      highlights: highlights.map((highlight) => serializeHighlight(highlight)),
      count: highlights.length,
    });
  } catch (error) {
    console.error("Error fetching community highlights:", error);
    res.status(500).json({ error: "خطأ في جلب الهايلايتات" });
  }
});

router.post(
  "/community/highlights",
  authenticateTokenUser,
  upload.single("image"),
  async (req, res) => {
    const imageFile = req.file || null;

    try {
      const title = sanitizeText(req.body.title);
      if (!title) {
        await deleteUploadedFile(imageFile?.path);
        return res.status(400).json({ error: "اسم الهايلايت مطلوب" });
      }

      if (!imageFile || !isImageFile(imageFile)) {
        await deleteUploadedFile(imageFile?.path);
        return res.status(400).json({ error: "يرجى اختيار صورة صالحة للهايلايت" });
      }

      const imagePath = normalizeStoredPath(imageFile.path);
      const highlight = await CommunityHighlight.create({
        userId: req.user.id,
        title,
        coverImage: imagePath,
      });
      await CommunityHighlightItem.create({
        highlightId: highlight.id,
        image: imagePath,
      });

      const hydrated = await CommunityHighlight.findByPk(highlight.id, {
        include: [
          {
            model: CommunityHighlightItem,
            as: "items",
            attributes: ["id", "image", "createdAt"],
          },
        ],
        order: [[{ model: CommunityHighlightItem, as: "items" }, "createdAt", "ASC"]],
      });

      res.status(201).json({
        success: true,
        message: "تم إنشاء الهايلايت بنجاح",
        highlight: serializeHighlight(hydrated),
      });
    } catch (error) {
      await deleteUploadedFile(imageFile?.path);
      console.error("Error creating community highlight:", error);
      res.status(500).json({ error: "خطأ في إنشاء الهايلايت" });
    }
  }
);

router.post(
  "/community/highlights/:highlightId/items",
  authenticateTokenUser,
  upload.single("image"),
  async (req, res) => {
    const imageFile = req.file || null;

    try {
      const highlight = await CommunityHighlight.findByPk(req.params.highlightId);
      if (!highlight) {
        await deleteUploadedFile(imageFile?.path);
        return res.status(404).json({ error: "الهايلايت غير موجود" });
      }

      if (Number(highlight.userId) !== Number(req.user.id)) {
        await deleteUploadedFile(imageFile?.path);
        return res.status(403).json({ error: "لا تملك صلاحية التعديل على هذا الهايلايت" });
      }

      if (!imageFile || !isImageFile(imageFile)) {
        await deleteUploadedFile(imageFile?.path);
        return res.status(400).json({ error: "يرجى اختيار صورة صالحة" });
      }

      const imagePath = normalizeStoredPath(imageFile.path);
      await CommunityHighlightItem.create({
        highlightId: highlight.id,
        image: imagePath,
      });

      if (!sanitizeText(highlight.coverImage)) {
        highlight.coverImage = imagePath;
        await highlight.save();
      }

      const hydrated = await CommunityHighlight.findByPk(highlight.id, {
        include: [
          {
            model: CommunityHighlightItem,
            as: "items",
            attributes: ["id", "image", "createdAt"],
          },
        ],
        order: [[{ model: CommunityHighlightItem, as: "items" }, "createdAt", "ASC"]],
      });

      res.json({
        success: true,
        message: "تمت إضافة قصة جديدة إلى الهايلايت",
        highlight: serializeHighlight(hydrated),
      });
    } catch (error) {
      await deleteUploadedFile(imageFile?.path);
      console.error("Error adding highlight item:", error);
      res.status(500).json({ error: "خطأ في إضافة القصة إلى الهايلايت" });
    }
  }
);

router.delete("/community/highlights/:highlightId", authenticateTokenUser, async (req, res) => {
  try {
    const highlight = await CommunityHighlight.findByPk(req.params.highlightId, {
      include: [
        {
          model: CommunityHighlightItem,
          as: "items",
          attributes: ["id", "image"],
        },
      ],
    });

    if (!highlight) {
      return res.status(404).json({ error: "الهايلايت غير موجود" });
    }

    if (Number(highlight.userId) !== Number(req.user.id)) {
      return res.status(403).json({ error: "لا تملك صلاحية حذف هذا الهايلايت" });
    }

    const imagesToDelete = Array.from(
      new Set(
        (highlight.items || [])
          .map((item) => normalizeStoredPath(item.image || ""))
          .filter((value) => value.length > 0)
      )
    );

    await CommunityHighlightItem.destroy({
      where: { highlightId: highlight.id },
    });
    await highlight.destroy();

    await Promise.all(imagesToDelete.map((item) => deleteUploadedFile(item)));

    res.json({
      success: true,
      message: "تم حذف الهايلايت",
    });
  } catch (error) {
    console.error("Error deleting community highlight:", error);
    res.status(500).json({ error: "خطأ في حذف الهايلايت" });
  }
});

router.delete(
  "/community/highlights/items/:itemId",
  authenticateTokenUser,
  async (req, res) => {
    try {
      const item = await CommunityHighlightItem.findByPk(req.params.itemId, {
        include: [
          {
            model: CommunityHighlight,
            as: "highlight",
            attributes: ["id", "userId", "coverImage"],
          },
        ],
      });

      if (!item || !item.highlight) {
        return res.status(404).json({ error: "عنصر الهايلايت غير موجود" });
      }

      if (Number(item.highlight.userId) !== Number(req.user.id)) {
        return res.status(403).json({ error: "لا تملك صلاحية حذف هذه القصة" });
      }

      const imagePath = normalizeStoredPath(item.image || "");
      const highlightId = Number(item.highlight.id);

      await item.destroy();

      const remainingItems = await CommunityHighlightItem.findAll({
        where: { highlightId },
        attributes: ["id", "image", "createdAt"],
        order: [["createdAt", "ASC"]],
      });

      if (remainingItems.length == 0) {
        await item.highlight.destroy();
      } else {
        const nextCover = normalizeStoredPath(remainingItems[0].image || "");
        if (normalizeStoredPath(item.highlight.coverImage || "") !== nextCover) {
          item.highlight.coverImage = nextCover;
          await item.highlight.save();
        }
      }

      await deleteUploadedFile(imagePath);

      res.json({
        success: true,
        deletedHighlight: remainingItems.length === 0,
        highlightId,
        message: remainingItems.length === 0
          ? "تم حذف آخر قصة وتمت إزالة الهايلايت"
          : "تم حذف القصة من الهايلايت",
      });
    } catch (error) {
      console.error("Error deleting community highlight item:", error);
      res.status(500).json({ error: "خطأ في حذف قصة الهايلايت" });
    }
  }
);

router.post(
  "/community/stories",
  authenticateTokenUser,
  upload.single("image"),
  async (req, res) => {
    const imageFile = req.file || null;

    try {
      if (!imageFile || !isImageFile(imageFile)) {
        await deleteUploadedFile(imageFile?.path);
        return res.status(400).json({ error: "يرجى اختيار صورة صالحة للستوري" });
      }

      const expiresAt = new Date(
        Date.now() + COMMUNITY_STORY_LIFETIME_HOURS * 60 * 60 * 1000
      );

      const story = await CommunityStory.create({
        userId: req.user.id,
        image: normalizeStoredPath(imageFile.path),
        expiresAt,
      });

      const hydrated = await CommunityStory.findByPk(story.id, {
        include: [
          {
            model: User,
            as: "user",
            attributes: ["id", "name", "images", "role"],
          },
        ],
      });
      const activeStoryUserIds = await buildActiveStoryUserSet([req.user.id]);

      res.status(201).json({
        success: true,
        message: "تمت إضافة الستوري بنجاح",
        story: serializeStory(hydrated, activeStoryUserIds),
      });
    } catch (error) {
      await deleteUploadedFile(imageFile?.path);
      console.error("Error creating community story:", error);
      res.status(500).json({ error: "خطأ في إضافة الستوري" });
    }
  }
);

router.get("/community/users/search", authenticateTokenUser, async (req, res) => {
  try {
    const users = await buildCommunitySearchResults({
      query: req.query.q,
      currentUserId: req.user.id,
      limit: req.query.limit,
    });

    res.json({
      users,
      count: users.length,
    });
  } catch (error) {
    console.error("Error searching community users:", error);
    res.status(500).json({ error: "خطأ في البحث عن المستخدمين" });
  }
});

router.get("/community/users/:userId/profile", authenticateTokenUser, async (req, res) => {
  try {
    const targetUserId = Number(req.params.userId);
    if (!Number.isFinite(targetUserId) || targetUserId <= 0) {
      return res.status(400).json({ error: "معرف المستخدم غير صالح" });
    }

    const user = await User.findByPk(targetUserId, {
      attributes: ["id", "name", "images", "note", "location", "role", "url", "isActive"],
    });

    if (!user || user.isActive === false) {
      return res.status(404).json({ error: "المستخدم غير موجود" });
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
    const highlights = await CommunityHighlight.findAll({
      where: { userId: targetUserId },
      include: [
        {
          model: CommunityHighlightItem,
          as: "items",
          attributes: ["id", "image", "createdAt"],
        },
      ],
      order: [
        ["createdAt", "DESC"],
        [{ model: CommunityHighlightItem, as: "items" }, "createdAt", "ASC"],
      ],
    });

    const activeStoryUserIds = await buildActiveStoryUserSet([
      targetUserId,
      ...recentFollowers.map((follow) => Number(follow.follower?.id)).filter(Boolean),
    ]);

    res.json({
      user: {
        id: user.id,
        name: user.name || "",
        image: extractImage(user.images),
        hasActiveStory: activeStoryUserIds.has(Number(user.id)),
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
          .map((follow) => serializeAuthor(follow.follower, activeStoryUserIds))
          .filter(Boolean),
        highlights: highlights.map((highlight) => serializeHighlight(highlight)),
      },
      posts: postsPayload.posts,
      pagination: postsPayload.pagination,
    });
  } catch (error) {
    console.error("Error fetching community user profile:", error);
    res.status(500).json({ error: "خطأ في جلب ملف المستخدم" });
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
      return res.status(400).json({ error: "معرف المستخدم غير صالح" });
    }

    if (targetUserId === currentUserId) {
      return res.status(400).json({ error: "لا يمكنك متابعة نفسك" });
    }

    const targetUser = await User.findByPk(targetUserId, {
      attributes: ["id", "isActive"],
    });
    if (!targetUser || targetUser.isActive === false) {
      return res.status(404).json({ error: "المستخدم غير موجود" });
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
          `${String(follower?.name || "").trim()} بدأ بمتابعتك`,
          "متابع جديد",
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
    res.status(500).json({ error: "خطأ في تحديث المتابعة" });
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
        return res.status(400).json({ error: "يسمح فقط برفع الصور أو الفيديو داخل المنشور" });
      }

      const content = sanitizeText(req.body.content);
      const image = imageFile?.path ? normalizeStoredPath(imageFile.path) : null;
      const video = videoFile?.path ? normalizeStoredPath(videoFile.path) : null;

      if (!content && !image && !video) {
        await Promise.all([
          deleteUploadedFile(image),
          deleteUploadedFile(video),
        ]);
        return res.status(400).json({ error: "يجب إضافة نص أو صورة أو فيديو على الأقل" });
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
      res.status(500).json({ error: "خطأ في إنشاء المنشور" });
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
        return res.status(404).json({ error: "المنشور غير موجود" });
      }

      if (Number(post.userId) !== Number(req.user.id)) {
        await Promise.all([
          deleteUploadedFile(imageFile?.path),
          deleteUploadedFile(videoFile?.path),
        ]);
        return res.status(403).json({ error: "لا تملك صلاحية تعديل هذا المنشور" });
      }

      if ((imageFile && !isImageFile(imageFile)) || (videoFile && !isVideoFile(videoFile))) {
        await Promise.all([
          deleteUploadedFile(imageFile?.path),
          deleteUploadedFile(videoFile?.path),
        ]);
        return res.status(400).json({ error: "يسمح فقط برفع الصور أو الفيديو داخل المنشور" });
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
        return res.status(400).json({ error: "يجب أن يبقى في المنشور نص أو صورة أو فيديو" });
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

      if (Number(post.userId) != Number(req.user.id)) {
        try {
          const actor = await User.findByPk(req.user.id, {
            attributes: ["id", "name"],
          });
          await sendNotificationToUser(
            post.userId,
          `${String(actor?.name || "").trim()} أعجب بمنشورك`,
          "إعجاب جديد",
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

    const activeStoryUserIds = await buildActiveStoryUserSet(
      comments.map((comment) => Number(comment.userId)).filter(Boolean)
    );
    const likesMap = await buildCommentLikesMap(
      comments.map((comment) => Number(comment.id)).filter(Boolean)
    );

    res.json({
      comments: buildNestedComments(
        comments,
        req.user.id,
        likesMap,
        activeStoryUserIds
      ),
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
    if (post.commentsEnabled === false) {
      return res.status(403).json({ error: "تم إيقاف التعليقات على هذا المنشور" });
    }

    const content = sanitizeText(req.body.content);
    if (!content) {
      return res.status(400).json({ error: "نص التعليق مطلوب" });
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
        return res.status(400).json({ error: "التعليق المراد الرد عليه غير صالح" });
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
          `${String(actor?.name || "").trim()} رد على تعليقك`,
          "رد جديد",
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
          `${String(actor?.name || "").trim()} علّق على منشورك`,
          "تعليق جديد",
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
    const activeStoryUserIds = await buildActiveStoryUserSet([
      req.user.id,
      parentComment?.user?.id,
    ]);

    res.status(201).json({
      comment: serializeComment(hydrated, req.user.id, new Map(), activeStoryUserIds, {
        replyToUser: parentComment?.user || null,
        replies: [],
      }),
      count,
    });
  } catch (error) {
    console.error("Error creating community comment:", error);
    res.status(500).json({ error: "خطأ في إضافة التعليق" });
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
      return res.status(404).json({ error: "التعليق غير موجود" });
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
            `${String(actor?.name || "").trim()} أعجب بتعليقك`,
            "إعجاب بتعليق",
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
    res.status(500).json({ error: "خطأ في تحديث إعجاب التعليق" });
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
    const activeStoryUserIds = await buildActiveStoryUserSet([
      req.user.id,
      comment.user?.id,
    ]);

    res.json({
      comment: serializeComment(comment, req.user.id, new Map(), activeStoryUserIds, {
        replies: [],
      }),
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
      message: "تم حذف التعليق",
    });
  } catch (error) {
    console.error("Error deleting community comment:", error);
    res.status(500).json({ error: "خطأ في حذف التعليق" });
  }
});

module.exports = router;





