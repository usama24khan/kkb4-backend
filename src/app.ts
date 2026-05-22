import express from "express";
import cors from "cors";
import path from "path";
import fs from "fs";
import { connectDB } from "./config/db";
import { env } from "./config/env";
import routes from "./routes";
import { errorHandler } from "./middleware/errorHandler";
import { generalLimiter } from "./middleware/rateLimiter";
import { ensureDefaultAdmin } from "./controllers/auth.controller";

const app = express();

// Ensure directories exist
const dirs = ["uploads", "notices"];
for (const dir of dirs) {
  const dirPath = path.join(__dirname, "..", dir);
  if (!fs.existsSync(dirPath)) fs.mkdirSync(dirPath, { recursive: true });
}

// Middleware
app.use(cors({ origin: env.CORS_ORIGINS, credentials: true }));
app.use(express.json({ limit: "10mb" }));
app.use(express.urlencoded({ extended: true }));
app.use(generalLimiter);

// Static files for notices
app.use("/notices", express.static(path.join(__dirname, "..", "notices")));

// API Routes
app.use("/api", routes);

// Error handler
app.use(errorHandler);

// Start server
const startServer = async () => {
  await connectDB();
  await ensureDefaultAdmin();
  app.listen(env.PORT, () => {
    console.log(`🚀 KKB4 API running on http://localhost:${env.PORT}`);
    console.log(`📋 Environment: ${env.NODE_ENV}`);
  });
};

startServer().catch(console.error);

export default app;
