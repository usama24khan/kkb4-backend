import { Request, Response, NextFunction } from 'express';
import { verifyAccessToken } from '../utils/jwt';

export interface UserAuthRequest extends Request {
  portalUser?: {
    email: string;
    role: string;
  };
}

/**
 * Authenticates a user-portal bearer token — the single shared account every
 * resident signs in with. Tokens carry role='user'; admin tokens are rejected
 * here so the two audiences stay clearly separated.
 */
export const userAuthMiddleware = (
  req: UserAuthRequest,
  res: Response,
  next: NextFunction,
): void => {
  try {
    const authHeader = req.headers.authorization;
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      res.status(401).json({ success: false, message: 'No token provided' });
      return;
    }

    const token = authHeader.split(' ')[1];
    const decoded = verifyAccessToken(token);

    if (decoded.role !== 'user') {
      res.status(403).json({ success: false, message: 'User portal token required' });
      return;
    }

    req.portalUser = { email: decoded.email, role: decoded.role };
    next();
  } catch {
    res.status(401).json({ success: false, message: 'Invalid or expired token' });
  }
};
