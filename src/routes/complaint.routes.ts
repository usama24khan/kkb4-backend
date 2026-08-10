import { Router } from 'express';
import {
  createComplaint,
  getComplaints,
  updateComplaintStatus,
  deleteComplaint,
  trackComplaint,
} from '../controllers/complaint.controller';
import { authMiddleware } from '../middleware/auth.middleware';
import { adminOnly } from '../middleware/adminOnly.middleware';
import { generalLimiter } from '../middleware/rateLimiter';

const router = Router();

// Submitted from the user portal — rate-limited rather than admin-gated.
router.post('/', generalLimiter, createComplaint);

// Status lookup by tracking number. Public but rate-limited, and the response
// omits the complainant's mobile number since tracking numbers are sequential.
// Declared before the admin routes so it can't be shadowed by '/:id'.
router.get('/track/:trackingNumber', generalLimiter, trackComplaint);

// Admin queue.
router.get('/', authMiddleware, adminOnly, getComplaints);
router.patch('/:id/status', authMiddleware, adminOnly, updateComplaintStatus);
router.delete('/:id', authMiddleware, adminOnly, deleteComplaint);

export default router;
