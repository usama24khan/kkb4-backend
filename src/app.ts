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

// Ensure local scratch directories exist. Notices/receipts now stream to
// Cloudinary (generated via os.tmpdir()), so only `uploads` is needed for
// local dev. Wrapped in try/catch because the deployment FS is read-only on
// platforms like Vercel — a failure here must not crash startup.
const dirs = ["uploads"];
for (const dir of dirs) {
  const dirPath = path.join(__dirname, "..", dir);
  try {
    if (!fs.existsSync(dirPath)) fs.mkdirSync(dirPath, { recursive: true });
  } catch (err) {
    console.warn(`⚠️  Could not create '${dir}' dir (read-only FS?):`, (err as Error).message);
  }
}

// Middleware
app.use(cors({ origin: env.CORS_ORIGINS, credentials: true }));
app.use(express.json({ limit: "10mb" }));
app.use(express.urlencoded({ extended: true }));
app.use(generalLimiter);

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
