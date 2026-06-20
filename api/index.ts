/**
 * Vercel Serverless Entry Point
 * =============================
 * Re-exports the Express app as a Vercel serverless function.
 * @vercel/node handles the HTTP listener automatically — no app.listen() needed.
 *
 * When running locally (`npm run dev`), the standard app.ts entry point is used
 * instead, which calls app.listen().
 */

import app from "../src/app";

export default app;
