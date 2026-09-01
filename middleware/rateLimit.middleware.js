const rateLimit = require("express-rate-limit");
const { ipKeyGenerator } = require("express-rate-limit");

/**
 * Rate limiting middleware for chat endpoints
 * Differentiates between authenticated and guest requests:
 * - Authenticated users: Higher limit per userId (100 requests / 15 minutes)
 * - Guest users: Lower limit per IP (30 requests / 15 minutes)
 */

// Key generator: uses userId for authenticated requests, IP for guests
// Note: This runs AFTER protectOptional, so req.user and req.isAuthenticated should be set
const keyGenerator = (req, res) => {
  try {
    if (req.user && req.user._id) {
      return `auth_${req.user._id}`;
    }
  } catch (error) {
    console.error("Error in rate limit keyGenerator:", error.message);
  }
  // Use ipKeyGenerator helper for IPv6 compatibility
  return ipKeyGenerator(req);
};

// Rate limiter for chat endpoints
exports.chatRateLimit = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: (req, res) => {
    // Authenticated users get higher limit
    try {
      if (req.user) {
        return 100; // 100 requests per 15 minutes for authenticated
      }
    } catch (error) {
      console.error("Error in rate limit max function:", error.message);
    }
    return 30; // 30 requests per 15 minutes for guests
  },
  keyGenerator: keyGenerator,
  standardHeaders: true, // Return rate limit info in `RateLimit-*` headers
  legacyHeaders: false, // Disable `X-RateLimit-*` headers
  skip: (req, res) => {
    // Don't rate limit admin operations
    try {
      return req.user && req.user.role === "admin";
    } catch (error) {
      return false;
    }
  },
  handler: (req, res, next, options) => {
    try {
      // Calculate seconds remaining until reset (not the absolute reset timestamp)
      const now = Date.now();
      const resetTime = req.rateLimit ? req.rateLimit.resetTime : now + 900000;
      const secondsRemaining = Math.max(0, Math.ceil((resetTime - now) / 1000));
      
      return res.status(429).json({
        status: "error",
        code: "RATE_LIMIT_EXCEEDED",
        message: "Too many requests. Please try again later.",
        retryAfter: secondsRemaining,
      });
    } catch (error) {
      console.error("Error in rate limit handler:", error.message);
      return next(error);
    }
  },
});

/**
 * Stricter rate limiter for message sending (POST /messages)
 * - Authenticated: 50 per 15 minutes
 * - Guest: 15 per 15 minutes
 */
exports.sendMessageRateLimit = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: (req, res) => {
    try {
      if (req.user) {
        return 50;
      }
    } catch (error) {
      console.error("Error in sendMessage rate limit:", error.message);
    }
    return 15;
  },
  keyGenerator: keyGenerator,
  standardHeaders: true,
  legacyHeaders: false,
  skip: (req, res) => {
    try {
      return req.user && req.user.role === "admin";
    } catch (error) {
      return false;
    }
  },
  handler: (req, res, next, options) => {
    try {
      // Calculate seconds remaining until reset
      const now = Date.now();
      const resetTime = req.rateLimit ? req.rateLimit.resetTime : now + 900000;
      const secondsRemaining = Math.max(0, Math.ceil((resetTime - now) / 1000));
      
      return res.status(429).json({
        status: "error",
        code: "RATE_LIMIT_EXCEEDED",
        message: "Message rate limit exceeded. Please slow down.",
        retryAfter: secondsRemaining,
      });
    } catch (error) {
      console.error("Error in sendMessage rate limit handler:", error.message);
      return next(error);
    }
  },
});

/**
 * Stricter rate limiter for chat initiation (POST /)
 * - Authenticated: 20 per 15 minutes
 * - Guest: 5 per 15 minutes
 */
exports.startChatRateLimit = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: (req, res) => {
    try {
      if (req.user) {
        return 20;
      }
    } catch (error) {
      console.error("Error in startChat rate limit:", error.message);
    }
    return 5;
  },
  keyGenerator: keyGenerator,
  standardHeaders: true,
  legacyHeaders: false,
  skip: (req, res) => {
    try {
      return req.user && req.user.role === "admin";
    } catch (error) {
      return false;
    }
  },
  handler: (req, res, next, options) => {
    try {
      // Calculate seconds remaining until reset
      const now = Date.now();
      const resetTime = req.rateLimit ? req.rateLimit.resetTime : now + 900000;
      const secondsRemaining = Math.max(0, Math.ceil((resetTime - now) / 1000));
      
      return res.status(429).json({
        status: "error",
        code: "RATE_LIMIT_EXCEEDED",
        message: "Too many chat sessions started. Please try again later.",
        retryAfter: secondsRemaining,
      });
    } catch (error) {
      console.error("Error in startChat rate limit handler:", error.message);
      return next(error);
    }
  },
});
