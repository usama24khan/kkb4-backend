import { Request, Response } from 'express';
import Plot from '../models/Plot';
import Payment from '../models/Payment';
import Notice from '../models/Notice';
import { generateAccessToken, generateRefreshToken } from '../utils/jwt';
import { sendSuccess, sendError } from '../utils/responseHelper';
import { ResidentAuthRequest } from '../middleware/residentAuth.middleware';

/**
 * Normalize a phone or CNIC string for comparison: keep digits only.
 */
const normalizeDigits = (s: string | undefined | null): string =>
  (s || '').toString().replace(/[^\d]/g, '');

/**
 * POST /resident-auth/login
 * Body: { plotNumber, block, credential }
 * credential: a CNIC or phone number (matched against either field).
 *
 * Returns: { plot: {...}, accessToken, refreshToken }
 */
export const residentLogin = async (req: Request, res: Response): Promise<void> => {
  try {
    const { plotNumber, block, credential } = req.body || {};

    if (!plotNumber || !block || !credential) {
      sendError(res, 'plotNumber, block, and credential are required', 400);
      return;
    }

    const blockUpper = String(block).trim().toUpperCase();
    const plot = await Plot.findOne({
      plotNumber: String(plotNumber).trim(),
      block: blockUpper,
      isActive: true,
    });

    if (!plot) {
      sendError(res, 'Plot not found', 404);
      return;
    }

    const normCred = normalizeDigits(credential);
    if (!normCred) {
      sendError(res, 'Invalid credential format', 400);
      return;
    }

    const phoneDigits = normalizeDigits(plot.ownerPhone);
    const cnicDigits = normalizeDigits(plot.ownerCnic);

    const phoneMatches = phoneDigits && phoneDigits === normCred;
    const cnicMatches = cnicDigits && cnicDigits === normCred;

    if (!phoneMatches && !cnicMatches) {
      // Do not reveal which field is the matching one.
      sendError(res, 'Credentials do not match plot records', 401);
      return;
    }

    const payload = {
      id: plot._id.toString(),
      email: '',
      role: 'resident',
      plotId: plot._id.toString(),
    };
    const accessToken = generateAccessToken(payload);
    const refreshToken = generateRefreshToken(payload);

    sendSuccess(res, {
      plot: {
        id: plot._id,
        plotNumber: plot.plotNumber,
        block: plot.block,
        phase: plot.phase,
        plotBlock: plot.plotBlock,
        plotCode: plot.plotCode,
        ownerName: plot.ownerName,
      },
      accessToken,
      refreshToken,
    }, 'Login successful');
  } catch (error: any) {
    sendError(res, 'Login failed', 500, error.message);
  }
};

/**
 * GET /resident-auth/notices — Returns notices that apply to the authenticated
 * resident's plot. Includes:
 *   - plot-scoped notices targeting this plot (single or in a comma list)
 *   - block-scoped notices for this plot's block
 *   - phase-scoped notices for this plot's phase
 *
 * Same filter logic as the admin notice-history endpoint, but locked to the
 * resident's own plot — they cannot pass `plot_id` to view others'.
 */
export const residentNotices = async (
  req: ResidentAuthRequest,
  res: Response,
): Promise<void> => {
  try {
    if (!req.resident) {
      sendError(res, 'Not authenticated', 401);
      return;
    }
    const plotId = req.resident.plotId;
    const plot = await Plot.findById(plotId).lean();
    if (!plot) {
      sendError(res, 'Plot not found', 404);
      return;
    }

    const limit = Math.min(parseInt((req.query.limit as string) || '50'), 100);
    const page = parseInt((req.query.page as string) || '1') || 1;

    const filter = {
      $or: [
        { type: 'plot', targetId: plotId },
        { type: 'plot', targetId: { $regex: new RegExp(`(^|,)${plotId}(,|$)`) } },
        { type: 'block', targetId: plot.block },
        { type: 'phase', targetId: plot.phase },
      ],
    };

    const [items, total] = await Promise.all([
      Notice.find(filter)
        .sort({ createdAt: -1 })
        .skip((page - 1) * limit)
        .limit(limit)
        .lean(),
      Notice.countDocuments(filter),
    ]);

    res.json({
      success: true,
      data: items,
      message: 'Notices fetched',
      meta: { page, limit, total, totalPages: Math.ceil(total / limit) },
    });
  } catch (error: any) {
    sendError(res, 'Failed to fetch notices', 500, error.message);
  }
};

/**
 * GET /resident-auth/me — Returns plot + all-years payment history for the
 * currently authenticated resident.
 */
export const residentMe = async (req: ResidentAuthRequest, res: Response): Promise<void> => {
  try {
    if (!req.resident) {
      sendError(res, 'Not authenticated', 401);
      return;
    }

    const plot = await Plot.findById(req.resident.plotId).lean();
    if (!plot || !plot.isActive) {
      sendError(res, 'Plot not found', 404);
      return;
    }

    const payments = await Payment.find({ plot: req.resident.plotId })
      .sort({ year: 1 })
      .lean();

    sendSuccess(res, { ...plot, payments }, 'Resident info fetched');
  } catch (error: any) {
    sendError(res, 'Failed to get resident info', 500, error.message);
  }
};
