import { Request, Response, NextFunction } from 'express';
import { verifyAccessToken } from '../utils/jwt';

export interface ResidentAuthRequest extends Request {
  resident?: {
    plotId: string;
    role: string;
  };
}

/**
 * Authenticates a resident bearer token. The token must have role='resident'
 * and a plotId. Sets req.resident on success.
 */
export const residentAuthMiddleware = (
  req: ResidentAuthRequest,
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

    if (decoded.role !== 'resident' || !decoded.plotId) {
      res.status(403).json({ success: false, message: 'Resident token required' });
      return;
    }

    req.resident = { plotId: decoded.plotId, role: decoded.role };
    next();
  } catch {
    res.status(401).json({ success: false, message: 'Invalid or expired token' });
  }
};
