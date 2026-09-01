const socketIo = require("socket.io");
const jwt = require("jsonwebtoken");

class NotificationGateway {
  constructor(server) {
    this.io = socketIo(server, {
      cors: {
        origin: process.env.FRONTEND_URL || "http://localhost:5173",
        methods: ["GET", "POST"],
        credentials: true,
      },
    });

    global.io = this.io;

    this.io.use(async (socket, next) => {
      try {
        const token = socket.handshake.auth.token;
        const guestSessionId = socket.handshake.auth.guestSessionId;

        if (token) {
          // Authenticated user
          const decoded = jwt.verify(token, process.env.JWT_SECRET);
          socket.userId = decoded.id;
          socket.role = decoded.role;
          socket.isGuest = false;
        } else if (guestSessionId) {
          // Guest user
          socket.guestSessionId = guestSessionId;
          socket.userId = null; // No user ID for guests
          socket.role = "customer";
          socket.isGuest = true;
        } else {
          return next(new Error("Authentication error"));
        }

        next();
      } catch (err) {
        next(new Error("Authentication error"));
      }
    });

    this.io.on("connection", (socket) => {
      // Join user to personal room
      if (socket.userId) {
        socket.join(socket.userId); // Authenticated users join by ID
      } else if (socket.guestSessionId) {
        socket.join(`guest:${socket.guestSessionId}`); // Guests join by session ID
      }

      if (socket.role === "admin") {
        socket.join("admin:notifications");
      }

      socket.on("chat:join", ({ chatId }) => {
        const room = `chat:${chatId}`;
        socket.join(room);
        console.log(`Socket ${socket.id} (${socket.isGuest ? 'Guest' : 'User'}: ${socket.userId || socket.guestSessionId}) joined room ${room}`);
      });

      socket.on("chat:leave", ({ chatId }) => {
        const room = `chat:${chatId}`;
        socket.leave(room);
        console.log(`Socket ${socket.id} (${socket.isGuest ? 'Guest' : 'User'}: ${socket.userId || socket.guestSessionId}) left room ${room}`);
      });

      socket.on("chat:typing", ({ chatId, isTyping }) => {
        socket.to(`chat:${chatId}`).emit("chat:typing:status", {
          chatId,
          isTyping,
          userId: socket.userId,
          userRole: socket.role,
        });
      });

      socket.on("chat:read", ({ chatId }) => {
        socket.to(`chat:${chatId}`).emit("chat:messages:read", {
          chatId,
          readerId: socket.userId,
          readerRole: socket.role,
        });
      });

      socket.on("disconnect", () => { });
    });
  }

  getActiveUserCount() {
    return this.io.engine.clientsCount;
  }

  broadcastHeartbeat() {
    this.io.emit("heartbeat", { timestamp: new Date() });
  }

  cleanupStaleConnections() {
  }

  async close() {
    await this.io.close();
  }
}

module.exports = NotificationGateway;
