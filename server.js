require("dotenv").config();

const express = require("express");
const helmet = require("helmet");
const morgan = require("morgan");
const cookieParser = require("cookie-parser");
const cors = require("cors");
const compression = require("compression");
const mongoose = require("mongoose");
const passport = require("./config/passport");
const http = require("http");
const os = require("os");

const { connectDatabase } = require("./config/database");
const globalErrorHandler = require("./middleware/error.middleware");
const AppError = require("./utils/AppError");
const NotificationGateway = require("./services/notificationGateway");
const {
  initializeQueues,
  closeQueues,
} = require("./services/notificationQueue");

const notificationEventEmitter = require("./services/notificationEventEmitter");
const {
  fetchAllFeeds,
  updateFeaturedArticles,
} = require("./services/rssFeedService");
const { initializeDatabaseIfEmpty } = require("./services/databaseSeeder");
const KeepAliveService = require("./services/keepAlive.service");

const PORT = process.env.PORT || 3001;
const NODE_ENV = process.env.NODE_ENV || "development";
const APP_VERSION = process.env.npm_package_version || "1.0.0";

// Validate required environment variables in production
if (NODE_ENV === "production") {
  if (!process.env.FRONTEND_URL) {
    throw new Error("FRONTEND_URL environment variable is required in production");
  }
  if (!process.env.ADMIN_URL) {
    throw new Error("ADMIN_URL environment variable is required in production");
  }
  if (!process.env.JWT_SECRET) {
    throw new Error("JWT_SECRET environment variable is required in production");
  }
  if (!process.env.MONGO_URI) {
    throw new Error("MONGO_URI environment variable is required in production");
  }
}

// Verify email configuration at startup
console.log("[startup] Email config verification:");
console.log("[startup] BREVO_API_KEY:", process.env.BREVO_API_KEY ? "✓ SET" : "✗ MISSING");
console.log("[startup] EMAIL_FROM:", process.env.EMAIL_FROM ? "✓ SET" : "✗ MISSING");

// Test email service at startup
const { verifyEmailConfig } = require("./services/email.service");
verifyEmailConfig()
  .then(isValid => {
    if (isValid) {
      console.log("[startup] ✓ Email service verified successfully");
    } else {
      console.error("[startup] ✗ Email service verification failed - check Brevo credentials");
    }
  })
  .catch(err => {
    console.error("[startup] ✗ Email service error:", err.message);
  });

const startTime = Date.now();

connectDatabase();

const app = express();

const allowedOrigins = [
  "http://localhost:5173", // customer dev
  "http://localhost:5174", // admin dev
  "https://aurainteriors.live", // customer prod
  "https://admin.aurainteriors.live", // admin prod
  "https://www.aurainteriors.live", // customer prod with www
  process.env.FRONTEND_URL,
  process.env.ADMIN_URL,
].filter(Boolean);

app.use(
  cors({
    origin: (origin, callback) => {
      // Allow requests with no origin (like mobile apps or curl requests)
      if (!origin) return callback(null, true);
      if (allowedOrigins.indexOf(origin) === -1) {
        const msg =
          "The CORS policy for this site does not allow access from the specified Origin.";
        return callback(new Error(msg), false);
      }
      return callback(null, true);
    },
    credentials: true,
    methods: ["GET", "POST", "PUT", "DELETE", "PATCH", "OPTIONS"],
    allowedHeaders: ["Content-Type", "Authorization"],
  }),
);

app.use(
  helmet({
    crossOriginResourcePolicy: { policy: "cross-origin" },
  }),
);

// Enable response compression (gzip/brotli) for all responses
// Reduces typical JSON payload by 5-8x (15KB → 3KB)
app.use(compression({ level: 6, threshold: 1024 }));

app.use(cookieParser());
app.use(express.json());
app.use(morgan("dev"));
app.use(passport.initialize());

// --------------------------------------------------------------------------
// Root & health check routes
// These are intentionally registered before the versioned API routes and are
// excluded from auth/rate-limiting middleware so load balancers, uptime
// monitors, and orchestrators (e.g. Docker, Kubernetes, Render, Railway) can
// reach them without credentials.
// --------------------------------------------------------------------------

app.get("/", (req, res) => {
  res.status(200).json({
    success: true,
    message: "API is running",
    version: APP_VERSION,
    environment: NODE_ENV,
    docs: "/api/v1",
  });
});

// Lightweight liveness probe: confirms the process is up and responding.
// Should stay fast and dependency-free so orchestrators don't restart the
// pod/container due to a slow downstream dependency.
app.get("/health", (req, res) => {
  res.status(200).json({
    success: true,
    status: "ok",
    uptime: process.uptime(),
    timestamp: new Date().toISOString(),
  });
});

// Deeper readiness probe: confirms the app and its critical dependencies
// (e.g. database) are actually ready to serve traffic.
app.get("/health/ready", async (req, res) => {
  const dbStateMap = {
    0: "disconnected",
    1: "connected",
    2: "connecting",
    3: "disconnecting",
  };
  const dbState = dbStateMap[mongoose.connection.readyState] || "unknown";
  const isDbReady = mongoose.connection.readyState === 1;

  const health = {
    success: isDbReady,
    status: isDbReady ? "ok" : "degraded",
    timestamp: new Date().toISOString(),
    uptime: process.uptime(),
    environment: NODE_ENV,
    version: APP_VERSION,
    host: os.hostname(),
    dependencies: {
      database: dbState,
      notificationGateway: global.notificationGateway ? "up" : "down",
    },
    memory: {
      rssMB: Math.round(process.memoryUsage().rss / 1024 / 1024),
      heapUsedMB: Math.round(process.memoryUsage().heapUsed / 1024 / 1024),
    },
  };

  res.status(isDbReady ? 200 : 503).json(health);
});

app.use("/api/v1/users", require("./routes/user.routes"));
app.use("/api/v1/auth", require("./routes/auth.routes"));
app.use("/api/v1/addresses", require("./routes/address.routes"));
app.use("/api/v1/profile", require("./routes/profile.routes"));
app.use("/api/v1/categories", require("./routes/category.routes"));
app.use("/api/v1/products", require("./routes/product.routes"));
app.use("/api/v1/wishlist", require("./routes/wishlist.routes"));
app.use("/api/v1/cart", require("./routes/cart.routes"));
app.use("/api/v1/discounts", require("./routes/discount.routes"));
app.use("/api/v1/orders", require("./routes/order.routes"));
app.use("/api/v1/notifications", require("./routes/notification.routes"));
app.use("/api/v1/promotions", require("./routes/promotion.routes"));
app.use("/api/v1/reviews", require("./routes/admin.review.routes"));
app.use("/api/v1/announcements", require("./routes/announcement.routes"));
app.use("/api/v1/chats", require("./routes/chat.routes"));
app.use("/api/v1/documents", require("./routes/document.routes"));
app.use("/api/v1/blogs", require("./routes/blog.routes"));
app.use("/api/v1/contacts", require("./routes/contact.routes"));
app.use("/api/v1/analytics", require("./routes/analytics.routes"));
app.use("/api/v1/newsletter", require("./routes/newsletter.routes"));
app.use("/api/v1/system", require("./routes/system.routes"));

app.use((req, res, next) => {
  next(new AppError(`Cannot find ${req.originalUrl} on this server`, 404));
});

app.use(globalErrorHandler);

const httpServer = http.createServer(app);

let notificationGateway;
let keepAliveService;

const startServer = async () => {
  try {
    console.log("Starting server initialization...");
    
    // Initialize database if empty
    await initializeDatabaseIfEmpty();
    
    await initializeQueues();
    console.log("✓ Queues initialized");

    console.log("Initializing notification gateway...");
    notificationGateway = new NotificationGateway(httpServer);
    console.log("✓ Notification gateway initialized");

    const heartbeatInterval = setInterval(() => {
      notificationGateway.broadcastHeartbeat();
    }, 60000);

    const cleanupInterval = setInterval(
      () => {
        notificationGateway.cleanupStaleConnections();
      },
      5 * 60 * 1000,
    );

    // RSS Feed Scheduler - fetch every 6 hours
    const RSS_FETCH_INTERVAL = 6 * 60 * 60 * 1000; // 6 hours
    const rssFeedInterval = setInterval(async () => {
      console.log("⏰ Running scheduled RSS feed fetch...");
      try {
        await fetchAllFeeds();
        await updateFeaturedArticles(5);
        console.log("✓ Scheduled RSS feed fetch completed");
      } catch (error) {
        console.error("✗ Scheduled RSS feed fetch failed:", error.message);
      }
    }, RSS_FETCH_INTERVAL);

    // Initial RSS feed fetch on startup (after 30 seconds to allow DB connection)
    setTimeout(async () => {
      console.log("📰 Running initial RSS feed fetch...");
      try {
        await fetchAllFeeds();
        await updateFeaturedArticles(5);
        console.log("✓ Initial RSS feed fetch completed");
      } catch (error) {
        console.error("✗ Initial RSS feed fetch failed:", error.message);
      }
    }, 30000);

    // Initialize Keep-Alive Service (prevents idle shutdown on Render)
    keepAliveService = new KeepAliveService();
    keepAliveService.start();

    global.notificationGateway = notificationGateway;
    global.notificationEventEmitter = notificationEventEmitter;
    global.keepAliveService = keepAliveService;

    httpServer.listen(PORT, "0.0.0.0", () => {
      console.log(`✓ Server running on PORT ${PORT} [${NODE_ENV}]`);
      console.log(
        `✓ Active users: ${notificationGateway.getActiveUserCount()}`,
      );
      console.log(
        `✓ Boot time: ${((Date.now() - startTime) / 1000).toFixed(2)}s`,
      );
    });

    const shutdown = async () => {
      console.log("\nShutting down gracefully...");
      clearInterval(heartbeatInterval);
      clearInterval(cleanupInterval);
      clearInterval(rssFeedInterval);
      keepAliveService.stop();
      await notificationGateway.close();
      await closeQueues();
      process.exit(0);
    };

    process.on("SIGINT", shutdown);
    process.on("SIGTERM", shutdown);
  } catch (error) {
    console.error("Failed to start server:", error);
    process.exit(1);
  }
};

startServer();