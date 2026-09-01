const express = require("express");
const router = express.Router();
const chatController = require("../controllers/chat.controller");
const { protect, protectOptional, restrictTo } = require("../middleware/auth.middleware");
const { chatRateLimit, sendMessageRateLimit, startChatRateLimit } = require("../middleware/rateLimit.middleware");
const validate = require("../middleware/validate.middleware");
const {
  startChatSchema,
  sendMessageSchema,
  getChatsQuerySchema,
  getMessagesQuerySchema,
} = require("../validators/chat.validator");

// Guest-eligible routes use protectOptional (allows both auth and guest)
router.post(
  "/",
  protectOptional,
  startChatRateLimit,
  validate(startChatSchema),
  chatController.startChat
);

// Get upload signature for direct Cloudinary uploads (before other routes)
router.get(
  "/signature/upload",
  protectOptional,
  chatController.getUploadSignature
);

// Customer chat list - authenticated only (guests don't have persistent lists)
router.get(
  "/my",
  protect,
  restrictTo("customer"),
  validate(getChatsQuerySchema, "query"),
  chatController.getMyChats
);

// Guest-eligible routes
router.get("/:id", protectOptional, chatController.getChatDetails);

router.get(
  "/:id/messages",
  protectOptional,
  validate(getMessagesQuerySchema, "query"),
  chatController.getChatMessages
);

router.post(
  "/:id/messages",
  protectOptional,
  sendMessageRateLimit,
  validate(sendMessageSchema),
  chatController.sendMessage
);

router.patch("/:id/read", protectOptional, chatController.markMessagesRead);

router.patch("/:id/close", protectOptional, chatRateLimit, chatController.closeChat);
router.patch("/:id/toggle-bot", protectOptional, chatRateLimit, chatController.toggleBot);

// Update message attachments with real URLs after upload (sync blob URLs to real Cloudinary URLs)
router.patch(
  "/:id/messages/:messageId/attachments",
  protectOptional,
  chatController.updateMessageAttachments
);

// Admin routes - keep strict auth
router.get(
  "/admin/stats",
  protect,
  restrictTo("admin"),
  chatController.getChatStats
);

router.get(
  "/admin/all",
  protect,
  restrictTo("admin"),
  validate(getChatsQuerySchema, "query"),
  chatController.getAllChats
);

router.get(
  "/admin/queue",
  protect,
  restrictTo("admin"),
  chatController.getWaitingQueue
);

router.patch(
  "/:id/resolve",
  protect,
  restrictTo("admin"),
  chatController.resolveChat
);

module.exports = router;
