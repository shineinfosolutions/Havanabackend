const express = require("express");
const mongoose = require("mongoose");
const cors = require("cors");

require("dotenv").config();

const authRoutes = require("./src/routes/authRoutes.js");
const userRoutes = require("./src/routes/userRoutes.js");
const categoryRoutes = require("./src/routes/category.js");
const roomRoutes = require("./src/routes/roomRoutes.js");
const bookingRoutes = require("./src/routes/booking.js");
const searchRoutes = require("./src/routes/searchRoutes");
const checkoutRoutes = require("./src/routes/checkoutRoutes.js");
const banquetMenuRoutes = require("./src/routes/banquetMenuRoutes.js");
const banquetBookingRoutes = require("./src/routes/banquetBookingRoutes.js");
const banquetCategoryRoutes = require("./src/routes/banquetCategoryRoutes.js");
const restaurantCategoryRoutes = require("./src/routes/restaurantCategoryRoutes.js");
const restaurantOrderRoutes = require("./src/routes/restaurantOrderRoutes.js");
const kotRoutes = require("./src/routes/kotRoutes.js");

const planLimitRoutes = require("./src/routes/planLimitRoutes.js");
const roomInventoryChecklistRoutes = require("./src/routes/roomInventoryChecklistRoutes.js");
const menuItemRoutes = require("./src/routes/menuItemRoutes.js");
const inventoryRoutes = require("./src/routes/inventoryRoutes.js");
const inventoryCategoryRoutes = require("./src/routes/inventoryCategoryRoutes.js");
const vendorRoutes = require("./src/routes/vendorRoutes.js");
const laundryRoutes = require("./src/routes/laundryRoutes.js");
const laundryCategoryRoutes = require("./src/routes/laundryCategoryRoutes.js");
const laundryItemRoutes = require("./src/routes/laundryItemRoutes.js");
const roomServiceRoutes = require("./src/routes/roomServiceRoutes.js");
const invoiceRoutes = require("./src/routes/invoiceRoutes.js");
const auditRoutes = require("./src/routes/auditRoutes.js");
const dashboardRoutes = require("./src/routes/dashboardRoutes.js");
const cashTransactionRoutes = require("./src/routes/CashTransactionRoutes.js");
const nightAuditRoutes = require("./src/routes/nightAuditRoutes.js");
const subReportsRoutes = require("./src/routes/subReportsRoutes.js");
const reportRoutes = require("./src/routes/reportRoutes.js");
const housekeepingRoutes = require("./src/routes/housekeepingRoutes.js");

const { connectAuditDB } = require("./src/config/auditDatabase.js");
const { optimizeDatabase } = require("./src/utils/dbOptimization.js");
const {
  performanceMonitor,
} = require("./src/middleware/performanceMonitor.js");
const path = require("path");

// Initialize express app
const app = express();

// Middleware
const allowedOrigins = [
  "http://localhost:5173",
  "http://localhost:4000",
  "https://havana-f-seven.vercel.app",
];

app.use(
  cors({
    origin: allowedOrigins,
    credentials: true,
    optionsSuccessStatus: 204,
  }),
);
app.use(express.json({ limit: "50mb" }));
app.use(performanceMonitor);

// Block ALL socket.io requests silently without logging
app.use((req, res, next) => {
  if (req.url.includes("socket.io")) {
    res.writeHead(404);
    res.end();
    return;
  }
  next();
});

// Serve uploaded files for fallback method
app.use("/uploads", express.static(path.join(__dirname, "uploads")));

// Database connection
let isConnected = false;

// Simplified MongoDB connection for serverless
const connectToMongoDB = async () => {
  if (isConnected && mongoose.connection.readyState === 1) {
    return;
  }

  try {
    if (!process.env.MONGO_URI) {
      throw new Error("MONGO_URI not found in environment variables");
    }

    const connectionOptions = {
      serverSelectionTimeoutMS: 3000,
      connectTimeoutMS: 3000,
      maxPoolSize: 1,
      minPoolSize: 0,
      maxIdleTimeMS: 10000,
      retryWrites: true,
      w: "majority",
    };

    await mongoose.connect(process.env.MONGO_URI, connectionOptions);
    isConnected = true;
    console.log("MongoDB connected successfully");

    // Optimize database with indexes (run once after connection is stable)
    setTimeout(async () => {
      if (mongoose.connection.readyState === 1) {
        await optimizeDatabase();
      }
    }, 1000);
  } catch (error) {
    console.error("Database connection failed:", error.message);
    isConnected = false;
    throw error;
  }
};

// Middleware to ensure DB connection
app.use(async (req, res, next) => {
  try {
    await connectToMongoDB();
    req.dbConnected = isConnected;
    next();
  } catch (error) {
    req.dbConnected = false;
    next();
  }
});

// Routes
app.use("/api/auth", authRoutes);
app.use("/api/users", userRoutes);
app.use("/api/categories", categoryRoutes);
app.use("/api/rooms", roomRoutes);
app.use("/api/bookings", bookingRoutes);
app.use("/api/search", searchRoutes);
app.use("/api/checkout", checkoutRoutes);
app.use("/api/banquet-menus", banquetMenuRoutes);
app.use("/api/banquet-bookings", banquetBookingRoutes);
app.use("/api/banquet-categories", banquetCategoryRoutes);
app.use("/api/restaurant-categories", restaurantCategoryRoutes);
app.use("/api/restaurant-orders", restaurantOrderRoutes);
app.use("/api/kot", kotRoutes);
app.use("/api/plan-limits", planLimitRoutes);
app.use("/api/room-inventory-checklists", roomInventoryChecklistRoutes);
app.use("/api/menu-items", menuItemRoutes);
app.use("/api/inventory", inventoryRoutes);
app.use("/api/inventory-categories", inventoryCategoryRoutes);
app.use("/api/vendors", vendorRoutes);
app.use("/api/laundry", laundryRoutes);
app.use("/api/laundry-categories", laundryCategoryRoutes);
app.use("/api/laundry-items", laundryItemRoutes);
app.use("/api/room-service", roomServiceRoutes);
app.use("/api/invoices", invoiceRoutes);
app.use("/api/audit", auditRoutes);
app.use("/api/dashboard", dashboardRoutes);
app.use("/api/cash-transactions", cashTransactionRoutes);
app.use("/api/night-audit", nightAuditRoutes);
app.use("/api/sub-reports", subReportsRoutes);
app.use("/api/reports", reportRoutes);
app.use("/api/housekeeping", housekeepingRoutes);

// Health check endpoint
app.get("/health", async (req, res) => {
  try {
    await connectToMongoDB();
    res.json({
      status: "ok",
      dbConnected: isConnected,
      connectionState: mongoose.connection.readyState,
    });
  } catch (error) {
    res.json({
      status: "error",
      dbConnected: false,
      error: error.message,
    });
  }
});

// Database test endpoint
app.get("/test-db", async (req, res) => {
  try {
    await connectToMongoDB();
    const testConnection = await mongoose.connection.db.admin().ping();
    res.json({
      success: true,
      message: "Database connection successful",
      dbName: mongoose.connection.name,
      readyState: mongoose.connection.readyState,
      ping: testConnection,
    });
  } catch (error) {
    res.status(500).json({
      error: "Database test failed",
      message: error.message,
      readyState: mongoose.connection.readyState,
    });
  }
});

app.get("/", (req, res) => {
  res.send("API is running");
});

// Error handling middleware
app.use((err, req, res, next) => {
  console.error("Server error:", err);
  res.status(500).json({ error: "Server error", message: err.message });
});

const PORT = process.env.PORT || 5000;

// Start server for local development
if (!process.env.VERCEL) {
  app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
}

// Export for serverless
module.exports = app;
