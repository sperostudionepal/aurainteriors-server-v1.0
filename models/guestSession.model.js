const mongoose = require("mongoose");

const guestSessionSchema = new mongoose.Schema(
  {
    sessionId: {
      type: String,
      unique: true,
      required: true,
      index: true,
    },
    email: {
      type: String,
      default: null,
    },
    chats: [
      {
        type: mongoose.Schema.Types.ObjectId,
        ref: "Chat",
      },
    ],
    createdAt: {
      type: Date,
      default: Date.now,
      index: true,
      // TTL index: documents expire 24 hours after creation
      expires: 86400,
    },
    lastActivityAt: {
      type: Date,
      default: Date.now,
    },
  },
  {
    timestamps: true,
  }
);

// Update lastActivityAt on any activity
guestSessionSchema.pre("save", function () {
  this.lastActivityAt = new Date();
});

module.exports = mongoose.model("GuestSession", guestSessionSchema);
