import { Request, Response, NextFunction } from 'express';
import { verifyAccessToken } from '../utils/jwt';

/**
 * Accepts either an admin token or a user-portal token.
 *
 * The finance reports are shown to both audiences — the committee needs to
 * manage them, residents need to see where their money went — so read routes
 * authenticate through here instead of picking one of the two audience-specific
 * middlewares. `req.viewer.isAdmin` lets a handler trim admin-only fields (bill
 * attachments, who recorded an entry) for resident requests.
 */
export interface ViewerRequest extends Request {
  viewer?: {
    id?: string;
    email: string;
    role: string;
    isAdmin: boolean;
  };
}

export const anyAuthMiddleware = (req: ViewerRequest, res: Response, next: NextFunction): void => {
  try {
    const authHeader = req.headers.authorization;
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      res.status(401).json({ success: false, message: 'No token provided' });
      return;
    }

    const decoded = verifyAccessToken(authHeader.split(' ')[1]);
    req.viewer = {
      id: decoded.id,
      email: decoded.email,
      role: decoded.role,
      isAdmin: decoded.role === 'admin' || decoded.role === 'superadmin',
    };
    next();
  } catch {
    res.status(401).json({ success: false, message: 'Invalid or expired token' });
  }
};
