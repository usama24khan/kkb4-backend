import { Request, Response } from 'express';
import Notice from '../models/Notice';
import { env } from '../config/env';
import { generateAccessToken, generateRefreshToken } from '../utils/jwt';
import { sendSuccess, sendError } from '../utils/responseHelper';
import { UserAuthRequest } from '../middleware/userAuth.middleware';

/** Read-only shared session — long-lived so residents aren't bounced hourly. */
const PORTAL_TOKEN_TTL = '30d';

/**
 * POST /user-auth/login
 * Body: { email, password }
 *
 * The user portal has ONE shared account (USER_PORTAL_EMAIL /
 * USER_PORTAL_PASSWORD). It grants read-only access to every plot record —
 * there is no per-resident identity, so nothing here is plot-scoped.
 */
export const userLogin = async (req: Request, res: Response): Promise<void> => {
  try {
    const { email, password } = req.body || {};

    if (!email || !password) {
      sendError(res, 'Email and password are required', 400);
      return;
    }

    const emailMatches =
      String(email).trim().toLowerCase() === env.USER_PORTAL_EMAIL.trim().toLowerCase();
    const passwordMatches = String(password) === env.USER_PORTAL_PASSWORD;

    if (!emailMatches || !passwordMatches) {
      sendError(res, 'Invalid email or password', 401);
      return;
    }

    const payload = {
      id: 'user-portal',
      email: env.USER_PORTAL_EMAIL,
      role: 'user',
    };

    sendSuccess(
      res,
      {
        user: { email: env.USER_PORTAL_EMAIL },
        accessToken: generateAccessToken(payload, PORTAL_TOKEN_TTL),
        refreshToken: generateRefreshToken(payload),
      },
      'Login successful',
    );
  } catch (error: any) {
    sendError(res, 'Login failed', 500, error.message);
  }
};

/**
 * GET /user-auth/me — Echoes the signed-in portal identity. Kept so the client
 * can validate a stored token without needing a plot id.
 */
export const userMe = async (req: UserAuthRequest, res: Response): Promise<void> => {
  if (!req.portalUser) {
    sendError(res, 'Not authenticated', 401);
    return;
  }
  sendSuccess(res, { email: req.portalUser.email }, 'User info fetched');
};

/**
 * GET /user-auth/notices — Society-wide notice list for the portal.
 *
 * The portal is a shared account, so notices can't be scoped to one plot the
 * way they were for per-resident logins: everything the admin generated is
 * listed, newest first.
 */
export const userNotices = async (req: UserAuthRequest, res: Response): Promise<void> => {
  try {
    const limit = Math.min(parseInt((req.query.limit as string) || '50'), 100);
    const page = parseInt((req.query.page as string) || '1') || 1;

    const [items, total] = await Promise.all([
      Notice.find({})
        .sort({ createdAt: -1 })
        .skip((page - 1) * limit)
        .limit(limit)
        .lean(),
      Notice.countDocuments({}),
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
