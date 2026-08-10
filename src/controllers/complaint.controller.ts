import { Request, Response } from 'express';
import Complaint, { ComplaintStatus } from '../models/Complaint';
import AuditLog from '../models/AuditLog';
import { AuthRequest } from '../middleware/auth.middleware';
import { sendSuccess, sendError } from '../utils/responseHelper';

const STATUSES: ComplaintStatus[] = ['pending', 'in_progress', 'resolved'];

/** Escape user input before dropping it into a RegExp for search. */
const escapeRegex = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * POST /complaints — Submit a complaint from the user portal.
 *
 * Body: { name, mobile, message }
 *
 * Open to any portal visitor: the portal is a single shared account, so the
 * name and mobile typed here are the only identity a complaint carries.
 */
export const createComplaint = async (req: Request, res: Response): Promise<void> => {
  try {
    const { name, mobile, message } = req.body || {};

    const cleanName = String(name || '').trim();
    const cleanMobile = String(mobile || '').trim();
    const cleanMessage = String(message || '').trim();

    if (!cleanName || !cleanMobile || !cleanMessage) {
      sendError(res, 'Name, mobile number, and complaint details are required', 400);
      return;
    }

    // 10–15 digits covers local (03001234567) and +92-prefixed formats.
    const digits = cleanMobile.replace(/[^\d]/g, '');
    if (digits.length < 10 || digits.length > 15) {
      sendError(res, 'Please enter a valid mobile number', 400);
      return;
    }

    if (cleanMessage.length < 5) {
      sendError(res, 'Please describe your complaint in a little more detail', 400);
      return;
    }

    // Numbering is allocated atomically (see models/Counter.ts), so collisions
    // shouldn't happen. This retry stays purely as a backstop in case the unique
    // index is hit some other way — e.g. a counter reset by hand.
    let complaint = null;
    for (let attempt = 0; attempt < 4 && !complaint; attempt++) {
      try {
        complaint = await Complaint.create({
          name: cleanName,
          mobile: cleanMobile,
          message: cleanMessage,
          status: 'pending',
          statusHistory: [{ status: 'pending', at: new Date() }],
        });
      } catch (err: any) {
        const isDuplicate = err?.code === 11000;
        if (!isDuplicate || attempt === 3) throw err;
      }
    }

    sendSuccess(
      res,
      {
        id: complaint!._id,
        trackingNumber: complaint!.trackingNumber,
        status: complaint!.status,
        createdAt: complaint!.createdAt,
      },
      'Complaint submitted',
      201,
    );
  } catch (error: any) {
    sendError(res, 'Failed to submit complaint', 500, error.message);
  }
};

/**
 * GET /complaints/track/:trackingNumber — Public status lookup for residents.
 *
 * Tracking numbers are sequential and therefore guessable, so this deliberately
 * omits the complainant's mobile number: walking CMP-2026-0001, -0002, … must
 * not turn into a harvest of residents' phone numbers. Status, dates, and the
 * complaint text are returned so the resident can confirm it's theirs.
 */
export const trackComplaint = async (req: Request, res: Response): Promise<void> => {
  try {
    const raw = String(req.params.trackingNumber || '').trim().toUpperCase();
    if (!raw) {
      sendError(res, 'A tracking number is required', 400);
      return;
    }

    // Accept "CMP-2026-0001", "cmp 2026 0001", or a bare "1" for the current year.
    let trackingNumber = raw.replace(/\s+/g, '-');
    if (/^\d+$/.test(trackingNumber)) {
      trackingNumber = `CMP-${new Date().getFullYear()}-${trackingNumber.padStart(4, '0')}`;
    }

    const complaint = await Complaint.findOne({ trackingNumber })
      .select('trackingNumber name message status statusHistory resolvedAt createdAt updatedAt')
      .lean();

    if (!complaint) {
      sendError(res, `No complaint found with tracking number ${trackingNumber}`, 404);
      return;
    }

    sendSuccess(res, complaint, 'Complaint found');
  } catch (error: any) {
    sendError(res, 'Failed to look up that complaint', 500, error.message);
  }
};

/**
 * GET /complaints — Admin list, newest first.
 * Query: page, limit, status, search (name / mobile / message)
 */
export const getComplaints = async (req: Request, res: Response): Promise<void> => {
  try {
    const page = parseInt((req.query.page as string) || '1') || 1;
    const limit = Math.min(parseInt((req.query.limit as string) || '20') || 20, 100);
    const status = req.query.status as string | undefined;
    const search = (req.query.search as string | undefined)?.trim();

    const filter: any = {};
    if (status && STATUSES.includes(status as ComplaintStatus)) filter.status = status;
    if (search) {
      const rx = { $regex: escapeRegex(search), $options: 'i' };
      filter.$or = [{ name: rx }, { mobile: rx }, { message: rx }, { trackingNumber: rx }];
    }

    const [items, total, counts] = await Promise.all([
      Complaint.find(filter)
        .sort({ createdAt: -1 })
        .skip((page - 1) * limit)
        .limit(limit)
        .lean(),
      Complaint.countDocuments(filter),
      Complaint.aggregate<{ _id: ComplaintStatus; count: number }>([
        { $group: { _id: '$status', count: { $sum: 1 } } },
      ]),
    ]);

    // Status tallies ignore the current filter so the tabs always show totals.
    const statusCounts = STATUSES.reduce(
      (acc, s) => ({ ...acc, [s]: counts.find((c) => c._id === s)?.count || 0 }),
      {} as Record<ComplaintStatus, number>,
    );

    res.status(200).json({
      success: true,
      data: items,
      message: 'Complaints fetched',
      meta: {
        page,
        limit,
        total,
        totalPages: Math.ceil(total / limit),
        statusCounts,
      },
    });
  } catch (error: any) {
    sendError(res, 'Failed to fetch complaints', 500, error.message);
  }
};

/**
 * PATCH /complaints/:id/status — Admin moves a complaint through the queue.
 * Body: { status: 'pending' | 'in_progress' | 'resolved' }
 */
export const updateComplaintStatus = async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const { status } = req.body || {};
    if (!STATUSES.includes(status)) {
      sendError(res, `status must be one of: ${STATUSES.join(', ')}`, 400);
      return;
    }

    // Append to statusHistory so the resident's tracking view shows progress
    // rather than just the latest state.
    const complaint = await Complaint.findByIdAndUpdate(
      req.params.id,
      {
        status,
        resolvedAt: status === 'resolved' ? new Date() : null,
        $push: { statusHistory: { status, at: new Date() } },
      },
      { new: true },
    );

    if (!complaint) {
      sendError(res, 'Complaint not found', 404);
      return;
    }

    if (req.admin) {
      await AuditLog.create({
        admin: req.admin.id,
        action: 'update',
        entity: 'complaint',
        entityId: complaint._id.toString(),
        changes: { status },
      });
    }

    sendSuccess(res, complaint, 'Complaint updated');
  } catch (error: any) {
    sendError(res, 'Failed to update complaint', 500, error.message);
  }
};

/** DELETE /complaints/:id — Admin removes a complaint permanently. */
export const deleteComplaint = async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const complaint = await Complaint.findByIdAndDelete(req.params.id);
    if (!complaint) {
      sendError(res, 'Complaint not found', 404);
      return;
    }

    if (req.admin) {
      await AuditLog.create({
        admin: req.admin.id,
        action: 'delete',
        entity: 'complaint',
        entityId: complaint._id.toString(),
        changes: { name: complaint.name, mobile: complaint.mobile },
      });
    }

    sendSuccess(res, { id: complaint._id }, 'Complaint deleted');
  } catch (error: any) {
    sendError(res, 'Failed to delete complaint', 500, error.message);
  }
};
