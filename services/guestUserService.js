const User = require("../models/user.model");

/**
 * GuestUserService
 * Manages a special system guest user placeholder for proper message attribution
 * This allows guest messages to have a valid sender reference while maintaining
 * data integrity and enabling proper avatar display
 */

class GuestUserService {
  /**
   * Get or create the system guest user placeholder
   * Returns the same guest user ID for all guest sessions
   */
  static async getOrCreateGuestUser() {
    const guestEmail = "guest@aura-interiors.local";

    // Try to find existing guest user
    let guestUser = await User.findOne({
      email: guestEmail,
    });

    // If doesn't exist, create it
    if (!guestUser) {
      try {
        guestUser = await User.create({
          email: guestEmail,
          firstName: "Guest",
          lastName: "User",
          role: "customer",
          isActive: true,
          isEmailVerified: false,
          password: null, // No password for guest user
          loginCount: 0,
        });
        console.log(`[GuestUserService] Created system guest user: ${guestUser._id}`);
      } catch (error) {
        // Handle unique constraint error - user might have been created by another request
        if (error.code === 11000) {
          guestUser = await User.findOne({ email: guestEmail });
        } else {
          throw error;
        }
      }
    }

    return guestUser;
  }

  /**
   * Get guest user ID (cached or fresh)
   */
  static async getGuestUserId() {
    const guestUser = await this.getOrCreateGuestUser();
    return guestUser._id;
  }

  /**
   * Check if a user is the system guest placeholder
   */
  static isGuestUser(userId) {
    if (!userId) return false;
    return userId.toString() === this.guestUserId?.toString();
  }
}

module.exports = GuestUserService;
