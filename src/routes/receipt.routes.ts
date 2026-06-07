import { Router } from "express";
import {
  getReceipts,
  createReceipt,
  getReceipt,
  generatePDF,
  deleteReceipt,
} from "../controllers/receipt.controller";
import { authMiddleware } from "../middleware/auth.middleware";
import { adminOnly } from "../middleware/adminOnly.middleware";

const router = Router();

// Public — PDF stream (window.open can't attach a bearer token). Declared
// before the bare /:id route so "pdf" isn't parsed as part of an id.
router.get("/:id/pdf", generatePDF);

// Admin-only — list / create / view / delete.
router.get("/", authMiddleware, adminOnly, getReceipts);
router.post("/", authMiddleware, adminOnly, createReceipt);
router.get("/:id", authMiddleware, adminOnly, getReceipt);
router.delete("/:id", authMiddleware, adminOnly, deleteReceipt);

export default router;
