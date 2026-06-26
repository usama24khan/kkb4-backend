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
import { ensureDefaultRates, ensureTestData } from "./controllers/seed.controller";
import { urduPipelineHealth } from "./utils/pdfGenerator";

const app = express();

// Required for Vercel/proxied environments — rate limiter reads X-Forwarded-For
app.set("trust proxy", 1);

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
app.use(cors({
  origin: (origin, callback) => {
    if (!origin) return callback(null, true);
    if (origin.endsWith(".vercel.app")) return callback(null, true);
    if (env.CORS_ORIGINS.includes(origin)) return callback(null, true);
    callback(new Error("Not allowed by CORS"));
  },
  credentials: true,
}));
app.use(express.json({ limit: "10mb" }));
app.use(express.urlencoded({ extended: true }));
app.use(generalLimiter);

// Ensure DB is connected before processing any API request.
// connectDB() is idempotent — warm invocations return immediately.
// This eliminates the race condition on Vercel cold starts where bootstrap()
// fires async but the first request arrives before the connection is ready.
app.use("/api", async (req, res, next) => {
  try {
    await connectDB();
    next();
  } catch (err) {
    next(err);
  }
});

// API Routes
app.use("/api", routes);

// Error handler
app.use(errorHandler);

// ── Bootstrap (connect DB + seed admin) ────────────────────────────────────
let bootstrapped = false;
const bootstrap = async () => {
  if (bootstrapped) return;
  await connectDB();
  await ensureDefaultAdmin();
  await ensureDefaultRates();
  await ensureTestData();
  bootstrapped = true;
};

// When running locally (`npm run dev`), start the HTTP server.
// On Vercel, the serverless adapter in api/index.ts handles requests.
if (!process.env.VERCEL) {
  const startServer = async () => {
    await bootstrap();
    app.listen(env.PORT, () => {
      console.log(`🚀 KKB4 API running on http://localhost:${env.PORT}`);
      console.log(`📋 Environment: ${env.NODE_ENV}`);
    });
    // Fire-and-log Urdu pipeline check (non-blocking)
    urduPipelineHealth()
      .then(({ ok, status }) => {
        const tag = ok ? "✅" : "⚠️";
        console.log(`${tag} Urdu PDF pipeline: ${ok ? "ready" : "NOT READY"} — ${status}`);
        if (!ok) {
          console.log("   Place NotoNastaliqUrdu-Regular.ttf in backend/scripts/");
        }
      })
      .catch((err) => console.warn("⚠️  Urdu pipeline check failed:", err));
  };
  startServer().catch(console.error);
} else {
  // Serverless cold-start: connect + seed.
  // Log failures but DO NOT crash the process — a transient Atlas blip
  // should not take down the entire Vercel function; individual request
  // handlers will surface DB errors if the connection is unavailable.
  bootstrap().catch((err: Error) => {
    console.error("⚠️  Bootstrap failed (non-fatal):", err.message);
  });
}

export default app;

