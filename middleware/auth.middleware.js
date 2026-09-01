const jwt = require("jsonwebtoken");
const User = require("../models/user.model");
const AppError = require("../utils/AppError");
const catchAsync = require("../utils/catchAsync");

exports.protect = catchAsync(async (req, res, next) => {
  let token;

  if (req.headers.authorization && req.headers.authorization.startsWith("Bearer")) {
    token = req.headers.authorization.split(" ")[1];
  } else if (req.cookies.jwt) {
    token = req.cookies.jwt;
  }

  if (!token) {
    return next(new AppError("You are not logged in. Please log in to get access.", 401));
  }

  const decoded = jwt.verify(token, process.env.JWT_SECRET);

  const user = await User.findById(decoded.id);
  if (!user) {
    return next(new AppError("The user belonging to this token no longer exists.", 401));
  }

  if (!user.isActive || user.deletedAt) {
    return next(new AppError("This account has been deactivated.", 401));
  }

  req.user = user;
  req.isAuthenticated = true;
  next();
});

/**
 * protectOptional middleware — allows both authenticated and unauthenticated requests
 * If valid token provided: attaches req.user and sets req.isAuthenticated = true
 * If no/invalid token: treats as guest, sets req.isAuthenticated = false, continues (does not 401)
 */
exports.protectOptional = catchAsync(async (req, res, next) => {
  let token;
  req.isAuthenticated = false;
  req.user = null;

  if (req.headers.authorization && req.headers.authorization.startsWith("Bearer")) {
    token = req.headers.authorization.split(" ")[1];
  } else if (req.cookies.jwt) {
    token = req.cookies.jwt;
  }

  if (token) {
    try {
      const decoded = jwt.verify(token, process.env.JWT_SECRET);
      const user = await User.findById(decoded.id);

      if (user && user.isActive && !user.deletedAt) {
        req.user = user;
        req.isAuthenticated = true;
      }
      // Invalid user record or deactivated — treat as guest
    } catch (error) {
      // Token verification failed (expired, invalid signature, etc.) — treat as guest
    }
  }

  next();
});

exports.restrictTo = (...roles) => {
  return (req, res, next) => {
    if (!roles.includes(req.user.role)) {
      return next(new AppError("You do not have permission to perform this action.", 403));
    }
    next();
  };
};
