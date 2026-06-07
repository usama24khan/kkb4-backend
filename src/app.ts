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
import { urduPipelineHealth } from "./utils/pdfGenerator";

const app = express();

// Ensure directories exist
const dirs = ["uploads", "notices", "receipts"];
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
  // Fire-and-log Urdu pipeline check (non-blocking). The admin sees the result
  // in the server log so a misconfigured Urdu setup is obvious on boot rather
  // than only at the moment they try to generate a notice.
  urduPipelineHealth()
    .then(({ ok, status }) => {
      const tag = ok ? "✅" : "⚠️";
      console.log(`${tag} Urdu PDF pipeline: ${ok ? "ready" : "NOT READY"} — ${status}`);
      if (!ok) {
        console.log("   Run: pip install reportlab arabic-reshaper python-bidi");
        console.log("   And place NotoNastaliqUrdu-Regular.ttf in backend/scripts/");
      }
    })
    .catch((err) => console.warn("⚠️  Urdu pipeline check failed:", err));
};

startServer().catch(console.error);

export default app;
