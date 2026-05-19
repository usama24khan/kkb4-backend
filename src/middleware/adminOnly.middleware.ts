import { Response, NextFunction } from 'express';
import { AuthRequest } from './auth.middleware';

export const adminOnly = (req: AuthRequest, res: Response, next: NextFunction): void => {
  if (!req.admin) {
    res.status(401).json({ success: false, message: 'Authentication required' });
    return;
  }
  
  if (req.admin.role !== 'admin' && req.admin.role !== 'superadmin') {
    res.status(403).json({ success: false, message: 'Admin access required' });
    return;
  }
  
  next();
};

export const superAdminOnly = (req: AuthRequest, res: Response, next: NextFunction): void => {
  if (!req.admin) {
    res.status(401).json({ success: false, message: 'Authentication required' });
    return;
  }
  
  if (req.admin.role !== 'superadmin') {
    res.status(403).json({ success: false, message: 'Super admin access required' });
    return;
  }
  
  next();
};
