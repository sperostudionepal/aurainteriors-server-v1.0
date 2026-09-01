const ChatService = require("../services/chatService");
const GuestSession = require("../models/guestSession.model");
const catchAsync = require("../utils/catchAsync");
const AppError = require("../utils/AppError");

// Helper to extract guest session ID from request (try multiple sources)
const getGuestSessionId = (req) => {
  return req.body?.guestSessionId || req.query?.guestSessionId || req.headers?.['x-guest-session-id'] || req.cookies?.guestSessionId;
};

// ==================== CUSTOMER OPERATIONS ====================

/**
 * Get upload signature for direct Cloudinary uploads
 */
exports.getUploadSignature = catchAsync(async (req, res, next) => {
  const { generateUploadSignature } = require("../config/cloudinary");
  
  const signature = generateUploadSignature("aura/chat");

  res.status(200).json({
    status: "success",
    data: {
      signature,
    },
  });
});

/**
 * Start a new chat (Customer or Guest)
 */
exports.startChat = catchAsync(async (req, res, next) => {
  const { subject, metadata, guestEmail } = req.body;

  if (req.isAuthenticated) {
    // Authenticated user
    const chat = await ChatService.createChat(req.user._id, {
      subject,
      metadata,
    });

    res.status(201).json({
      status: "success",
      message: "Chat started successfully",
      data: { chat },
    });
  } else {
    // Guest user - create a new guest session or use existing
    let guestSessionId = getGuestSessionId(req);

    if (!guestSessionId) {
      // Create new guest session
      const guestSession = await GuestSession.create({
        sessionId: `guest_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`,
        email: guestEmail || null,
      });
      guestSessionId = guestSession._id;
    }

    const chat = await ChatService.createGuestChat(guestSessionId, {
      subject,
      metadata,
    });

    res.status(201).json({
      status: "success",
      message: "Chat started successfully",
      data: { 
        chat,
        guestSessionId: guestSessionId.toString(), // Return session ID so client can store it
      },
    });
  }
});

/**
 * Get customer's chats (Authenticated users only)
 */
exports.getMyChats = catchAsync(async (req, res, next) => {
  const { page = 1, limit = 20, status } = req.query;

  const result = await ChatService.getCustomerChats(req.user._id, {
    page: parseInt(page, 10),
    limit: parseInt(limit, 10),
    status,
  });

  res.status(200).json({
    status: "success",
    data: {
      chats: result.chats,
      pagination: result.pagination,
    },
  });
});

/**
 * Get chat details (Customer/Guest/Admin)
 */
exports.getChatDetails = catchAsync(async (req, res, next) => {
  const guestSessionId = getGuestSessionId(req);
  
  const chat = await ChatService.getChatById(
    req.params.id,
    req.user?._id,
    req.user?.role || 'guest',
    guestSessionId
  );

  res.status(200).json({
    status: "success",
    data: { chat },
  });
});

/**
 * Get chat messages (Customer/Guest/Admin)
 */
exports.getChatMessages = catchAsync(async (req, res, next) => {
  const { page = 1, limit = 50 } = req.query;
  const guestSessionId = getGuestSessionId(req);

  const result = await ChatService.getChatMessages(
    req.params.id,
    req.user?._id,
    req.user?.role || 'guest',
    guestSessionId,
    {
      page: parseInt(page, 10),
      limit: parseInt(limit, 10),
    }
  );

  res.status(200).json({
    status: "success",
    data: {
      messages: result.messages,
      pagination: result.pagination,
    },
  });
});

/**
 * Send message in chat (Customer/Guest/Admin)
 */
exports.sendMessage = catchAsync(async (req, res, next) => {
  const { content, attachments } = req.body;
  const guestSessionId = getGuestSessionId(req);

  // Attachments now come pre-processed from the frontend (Cloudinary URLs)
  // Just validate and pass through
  const processedAttachments = attachments && Array.isArray(attachments) 
    ? attachments.filter(att => att && att.fileUrl && att.fileName)
    : [];

  // Ensure either content or attachments is provided
  if ((!content || !content.trim()) && processedAttachments.length === 0) {
    return next(new AppError("Message content or attachments required", 400));
  }

  const message = await ChatService.sendMessage(
    req.params.id,
    req.user?._id,
    req.user?.role || 'customer',
    {
      content,
      attachments: processedAttachments,
    },
    guestSessionId
  );

  res.status(201).json({
    status: "success",
    message: "Message sent successfully",
    data: { message },
  });
});

/**
 * Mark messages as read (Customer/Guest/Admin)
 */
exports.markMessagesRead = catchAsync(async (req, res, next) => {
  const guestSessionId = getGuestSessionId(req);

  const result = await ChatService.markMessagesAsRead(
    req.params.id,
    req.user?._id,
    req.user?.role || 'customer',
    guestSessionId
  );

  res.status(200).json({
    status: "success",
    message: "Messages marked as read",
    data: { modifiedCount: result.modifiedCount },
  });
});

/**
 * Close chat (Customer/Guest/Admin)
 */
exports.closeChat = catchAsync(async (req, res, next) => {
  const guestSessionId = getGuestSessionId(req);

  const chat = await ChatService.closeChat(
    req.params.id,
    req.user?._id,
    req.user?.role || 'customer',
    guestSessionId
  );

  res.status(200).json({
    status: "success",
    message: "Chat closed successfully",
    data: { chat },
  });
});

// ==================== ADMIN OPERATIONS ====================

/**
 * Get all chats (Admin)
 */
exports.getAllChats = catchAsync(async (req, res, next) => {
  const { page = 1, limit = 20, status, priority, sortBy } = req.query;

  const result = await ChatService.getAllChats({
    page: parseInt(page, 10),
    limit: parseInt(limit, 10),
    status,
    priority,
    sortBy,
  });

  res.status(200).json({
    status: "success",
    data: {
      chats: result.chats,
      pagination: result.pagination,
    },
  });
});

/**
 * Get waiting queue (Admin)
 */
exports.getWaitingQueue = catchAsync(async (req, res, next) => {
  const chats = await ChatService.getWaitingQueue();

  res.status(200).json({
    status: "success",
    data: { chats },
  });
});

/**
 * Resolve chat (Admin)
 */
exports.resolveChat = catchAsync(async (req, res, next) => {
  const chat = await ChatService.resolveChat(req.params.id, req.user._id);

  res.status(200).json({
    status: "success",
    message: "Chat resolved successfully",
    data: { chat },
  });
});

/**
 * Get chat statistics (Admin)
 */
exports.getChatStats = catchAsync(async (req, res, next) => {
  const stats = await ChatService.getChatStats();

  res.status(200).json({
    status: "success",
    data: { stats },
  });
});

/**
 * Toggle AI Bot active state (Customer/Guest/Admin)
 */
exports.toggleBot = catchAsync(async (req, res, next) => {
  const { botActive } = req.body;
  const guestSessionId = getGuestSessionId(req);

  const chat = await ChatService.toggleBot(
    req.params.id,
    req.user?._id,
    req.user?.role || 'customer',
    guestSessionId,
    botActive
  );

  res.status(200).json({
    status: "success",
    message: `AI Bot ${botActive ? "enabled" : "disabled"} successfully`,
    data: { chat },
  });
});

/**
 * Update message attachments with real URLs after Cloudinary upload completes
 * Called after client-side upload succeeds to sync real URLs back to DB
 * (Customer/Guest/Admin)
 */
exports.updateMessageAttachments = catchAsync(async (req, res, next) => {
  const { messageId } = req.params;
  const { attachments } = req.body;
  const guestSessionId = getGuestSessionId(req);

  if (!messageId) {
    return next(new AppError("Message ID is required", 400));
  }

  if (!Array.isArray(attachments)) {
    return next(new AppError("Attachments must be an array", 400));
  }

  // Validate that each attachment has required fields
  const validAttachments = attachments.filter(att => 
    att && att.fileName && att.fileUrl && att.fileType && typeof att.fileSize === 'number'
  );

  if (validAttachments.length === 0) {
    return next(new AppError("No valid attachments provided", 400));
  }

  // Get the message to verify access
  const ChatMessage = require("../models/chatMessage.model");
  const message = await ChatMessage.findById(messageId).populate('chat');

  if (!message) {
    return next(new AppError("Message not found", 404));
  }

  // Verify user has access to this chat
  const chat = message.chat;
  const isCustomer = req.user && chat.customer?.toString() === req.user._id.toString();
  const isAdmin = req.user && req.user.role === 'admin';
  const isGuest = guestSessionId && chat.guestSession?.toString() === guestSessionId.toString();

  if (!isCustomer && !isAdmin && !isGuest) {
    return next(new AppError("You don't have permission to update this message", 403));
  }

  // Update message attachments with real URLs from Cloudinary
  const updatedMessage = await ChatMessage.findByIdAndUpdate(
    messageId,
    { attachments: validAttachments },
    { new: true, runValidators: true }
  ).populate('sender', 'firstName lastName email role avatar');

  // Broadcast update via socket (if socket service available)
  try {
    const socketService = require('../services/socketService');
    if (socketService && socketService.broadcastChatUpdate) {
      socketService.broadcastChatUpdate(chat._id.toString(), {
        type: 'message:attachments:updated',
        message: updatedMessage,
        messageId: messageId.toString(),
      });
    }
  } catch (error) {
    console.error("Failed to broadcast socket update:", error.message);
    // Don't fail the response if socket broadcast fails
  }

  res.status(200).json({
    status: "success",
    message: "Message attachments updated successfully",
    data: { message: updatedMessage },
  });
});

module.exports = exports;
