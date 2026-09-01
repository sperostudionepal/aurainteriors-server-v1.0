const AppError = require("./AppError");

/**
 * AuthRequiredError — structured error for auth-required features
 * Used when guests attempt to use features requiring authentication
 */
class AuthRequiredError extends AppError {
  constructor(message, suggestion, actions = []) {
    super(message, 401);
    this.code = "AUTH_REQUIRED";
    this.suggestion = suggestion;
    this.actions = actions; // Array of suggested actions: ["sign_in", "create_account", "continue_browsing"]
    this.isAuthRequired = true;
  }
}

/**
 * RateLimitError — structured error for rate limiting
 */
class RateLimitError extends AppError {
  constructor(message, retryAfter = 900) {
    super(message, 429);
    this.code = "RATE_LIMIT_EXCEEDED";
    this.retryAfter = retryAfter;
  }
}

module.exports = {
  AuthRequiredError,
  RateLimitError,
};
