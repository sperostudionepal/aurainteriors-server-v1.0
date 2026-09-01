const Joi = require("joi");

const validStatuses = ["ai_handling", "escalated", "agent_handling", "resolved", "closed"];
const validPriorities = ["low", "normal", "high", "urgent"];

exports.startChatSchema = Joi.object({
  subject: Joi.string().max(200).trim().required().messages({
    "string.empty": "Chat subject is required",
    "string.max": "Subject cannot exceed 200 characters",
  }),
  metadata: Joi.object({
    userAgent: Joi.string().optional(),
    ipAddress: Joi.string().ip().optional(),
    referrer: Joi.string().uri().allow('').optional(),
  }).optional(),
  guestSessionId: Joi.string().optional(), // Allow guest session ID to pass through
});

exports.sendMessageSchema = Joi.object({
  content: Joi.string().max(5000).allow("", null).optional().messages({
    "string.max": "Message content cannot exceed 5000 characters",
  }),
  attachments: Joi.array()
    .items(
      Joi.object({
        fileName: Joi.string().required(),
        fileUrl: Joi.string().required(),
        fileType: Joi.string().required(),
        fileSize: Joi.number().integer().positive().required(),
      })
    )
    .max(3)
    .optional()
    .messages({
      "array.max": "Maximum of 3 attachments allowed per message",
    }),
  isInternalNote: Joi.boolean().optional().default(false),
  guestSessionId: Joi.string().optional(), // Allow guest session ID to pass through
});

exports.updateTypingSchema = Joi.object({
  isTyping: Joi.boolean().required().messages({
    "any.required": "isTyping field is required",
  }),
});

exports.closeChatSchema = Joi.object({}).optional();

exports.resolveChatSchema = Joi.object({}).optional();

exports.getChatsQuerySchema = Joi.object({
  page: Joi.number().integer().min(1).default(1),
  limit: Joi.number().integer().min(1).max(100).default(20),
  status: Joi.string()
    .valid(...validStatuses)
    .optional(),
  priority: Joi.string()
    .valid(...validPriorities)
    .optional(),
  sortBy: Joi.string()
    .valid("lastMessageAt", "createdAt", "priority")
    .default("lastMessageAt"),
  guestSessionId: Joi.string().optional(), // Allow guest session ID to pass through
});

exports.getMessagesQuerySchema = Joi.object({
  page: Joi.number().integer().min(1).default(1),
  limit: Joi.number().integer().min(1).max(100).default(50),
  guestSessionId: Joi.string().optional(), // Allow guest session ID to pass through
});
