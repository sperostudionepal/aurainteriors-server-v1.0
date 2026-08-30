const mongoose = require("mongoose");
const crypto = require("crypto");
const bcrypt = require("bcrypt");


const userSchema = new mongoose.Schema(
  {
    email: {
      type: String,
      required: [true, "Email is required"],
      unique: true,
      lowercase: true,
      trim: true,
      match: [/^\S+@\S+\.\S+$/, "Please enter a valid email"],
    },



    firstName: {
      type: String,
      trim: true,
      maxlength: 50,
    },

    lastName: {
      type: String,
      trim: true,
      maxlength: 50,
    },

    phone: {
      type: String,
      trim: true,
      match: [/^[0-9]{7,15}$/, "Please enter a valid phone number"],
    },

    avatar: { type: String, default: null },
    avatarPublicId: { type: String, default: null },

    dateOfBirth: Date,

    gender: {
      type: String,
      enum: ["male", "female", "other", "prefer_not_to_say"],
    },

    role: {
      type: String,
      enum: ["customer", "admin"],
      default: "customer",
    },

    isActive: { type: Boolean, default: true },
    isEmailVerified: { type: Boolean, default: false },

    password: {
      type: String,
      select: false,
    },

    loginOtp: {
      type: String,
      select: false,
    },

    loginOtpExpires: {
      type: Date,
      select: false,
    },

    // Magic link (used for both signup and passwordless login)
    magicLinkToken: { type: String, select: false },
    magicLinkExpires: { type: Date, select: false },

    preferences: {
      newsletter: { type: Boolean, default: false },
      smsNotifications: { type: Boolean, default: false },
      orderUpdates: { type: Boolean, default: true },
      promotionalEmails: { type: Boolean, default: false },
      preferredCategories: [
        {
          type: String,
          enum: ["living_room", "bedroom", "dining", "office", "outdoor", "storage", "decor"],
        },
      ],
    },

    googleId: { type: String, sparse: true },

    lastLogin: Date,
    loginCount: { type: Number, default: 0 },

    deactivatedAt: { type: Date, default: null },
    deactivationReason: { type: String, default: null },
    deletedAt: { type: Date, default: null },
  },
  {
    timestamps: true,
    toJSON: { virtuals: true },
    toObject: { virtuals: true },
  }
);

userSchema.index({ role: 1 });
userSchema.index({ phone: 1 });
userSchema.index({ createdAt: -1 });

userSchema.virtual("fullName").get(function () {
  if (this.firstName && this.lastName) return `${this.firstName} ${this.lastName}`;
  return this.firstName || null;
});

// Hash password before saving
userSchema.pre("save", async function () {
  if (!this.isModified("password") || !this.password) return;
  this.password = await bcrypt.hash(this.password, 12);
});

// Compare password
userSchema.methods.comparePassword = async function (candidatePassword, userPassword) {
  return await bcrypt.compare(candidatePassword, userPassword);
};

// Create OTP
userSchema.methods.createOtp = function () {
  const otp = Math.floor(100000 + Math.random() * 900000).toString(); // 6 digit string
  this.loginOtp = crypto.createHash("sha256").update(otp).digest("hex");
  this.loginOtpExpires = Date.now() + 5 * 60 * 1000; // 5 minutes
  return otp;
};

userSchema.methods.createMagicLinkToken = function () {
  const rawToken = crypto.randomBytes(32).toString("hex");
  this.magicLinkToken = crypto.createHash("sha256").update(rawToken).digest("hex");
  this.magicLinkExpires = Date.now() + 15 * 60 * 1000;
  return rawToken;
};



userSchema.methods.updateLoginActivity = function () {
  this.lastLogin = Date.now();
  this.loginCount += 1;
};

userSchema.statics.findActive = function () {
  return this.find({ isActive: true, deletedAt: null });
};

const User = mongoose.model("User", userSchema);
module.exports = User;