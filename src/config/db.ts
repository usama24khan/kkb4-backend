import mongoose from "mongoose";
import { env } from "./env";

// Module-level flag — Vercel reuses warm instances, so we skip re-connecting
// when Mongoose already has a live connection.
let isConnected = false;

const OPTS: mongoose.ConnectOptions = {
  // Fail fast on cold starts — don't block Vercel for 30 s (the default)
  serverSelectionTimeoutMS: 10_000,
  connectTimeoutMS: 10_000,
  socketTimeoutMS: 45_000,
  // Serverless-safe pool: allow up to 10 connections but start at 0
  maxPoolSize: 10,
  minPoolSize: 0,
  heartbeatFrequencyMS: 30_000,
  // Do NOT buffer Mongoose ops while disconnected — surface errors immediately
  bufferCommands: false,
};

export const connectDB = async (retries = 3): Promise<void> => {
  // Reuse existing connection on warm Vercel invocations
  if (isConnected && mongoose.connection.readyState === 1) {
    return;
  }

  // Attach a persistent error listener so Mongoose network blips after the
  // initial connect don't emit an unhandled 'error' event and crash Node 15+.
  if (!mongoose.connection.listenerCount("error")) {
    mongoose.connection.on("error", (err) => {
      console.error("⚠️  MongoDB runtime error:", err.message);
      isConnected = false;
    });
    mongoose.connection.on("disconnected", () => {
      console.warn("⚠️  MongoDB disconnected");
      isConnected = false;
    });
  }

  for (let attempt = 1; attempt <= retries; attempt++) {
    try {
      const conn = await mongoose.connect(env.MONGODB_URI, OPTS);
      isConnected = true;
      console.log(
        `✅ MongoDB connected (attempt ${attempt}): ${conn.connection.host}`,
      );
      return;
    } catch (err: any) {
      const msg = err?.message ?? String(err);
      console.error(
        `❌ MongoDB connection attempt ${attempt}/${retries} failed: ${msg}`,
      );
      if (attempt === retries) throw err;
      // Exponential back-off: 1 s, 2 s before the final attempt
      await new Promise((r) => setTimeout(r, attempt * 1_000));
    }
  }
};
