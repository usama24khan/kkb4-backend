import { Router } from 'express';
import {
  createComplaint,
  getComplaints,
  updateComplaintStatus,
  deleteComplaint,
} from '../controllers/complaint.controller';
import { authMiddleware } from '../middleware/auth.middleware';
import { adminOnly } from '../middleware/adminOnly.middleware';
import { generalLimiter } from '../middleware/rateLimiter';

const router = Router();

// Submitted from the user portal — rate-limited rather than admin-gated.
router.post('/', generalLimiter, createComplaint);

// Admin queue.
router.get('/', authMiddleware, adminOnly, getComplaints);
router.patch('/:id/status', authMiddleware, adminOnly, updateComplaintStatus);
router.delete('/:id', authMiddleware, adminOnly, deleteComplaint);

export default router;
