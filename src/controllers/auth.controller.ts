import { Request, Response } from 'express';
import Admin from '../models/Admin';
import { generateAccessToken, generateRefreshToken, verifyRefreshToken } from '../utils/jwt';
import { sendSuccess, sendError } from '../utils/responseHelper';
import { env } from '../config/env';

export const login = async (req: Request, res: Response): Promise<void> => {
  try {
    const { email, password } = req.body;

    if (!email || !password) {
      sendError(res, 'Email and password are required', 400);
      return;
    }

    const admin = await Admin.findOne({ email: email.toLowerCase() });
    if (!admin) {
      sendError(res, 'Invalid credentials', 401);
      return;
    }

    const isMatch = await admin.comparePassword(password);
    if (!isMatch) {
      sendError(res, 'Invalid credentials', 401);
      return;
    }

    const payload = { id: admin._id.toString(), email: admin.email, role: admin.role };
    const accessToken = generateAccessToken(payload);
    const refreshToken = generateRefreshToken(payload);

    sendSuccess(res, {
      admin: { id: admin._id, name: admin.name, email: admin.email, role: admin.role },
      accessToken,
      refreshToken,
    }, 'Login successful');
  } catch (error: any) {
    sendError(res, 'Login failed', 500, error.message);
  }
};

export const refresh = async (req: Request, res: Response): Promise<void> => {
  try {
    const { refreshToken } = req.body;
    if (!refreshToken) {
      sendError(res, 'Refresh token is required', 400);
      return;
    }

    const decoded = verifyRefreshToken(refreshToken);
    const admin = await Admin.findById(decoded.id);
    if (!admin) {
      sendError(res, 'Admin not found', 404);
      return;
    }

    const payload = { id: admin._id.toString(), email: admin.email, role: admin.role };
    const newAccessToken = generateAccessToken(payload);
    const newRefreshToken = generateRefreshToken(payload);

    sendSuccess(res, { accessToken: newAccessToken, refreshToken: newRefreshToken }, 'Token refreshed');
  } catch (error: any) {
    sendError(res, 'Invalid refresh token', 401, error.message);
  }
};

export const logout = async (_req: Request, res: Response): Promise<void> => {
  sendSuccess(res, null, 'Logged out successfully');
};

// Create default admin on startup
export const ensureDefaultAdmin = async (): Promise<void> => {
  try {
    const existing = await Admin.findOne({ email: env.ADMIN_EMAIL });
    if (!existing) {
      const admin = new Admin({
        name: 'KKB4 Admin',
        email: env.ADMIN_EMAIL,
        passwordHash: env.ADMIN_DEFAULT_PASSWORD,
        role: 'superadmin',
      });
      await admin.save();
      console.log(`✅ Default admin created: ${env.ADMIN_EMAIL}`);
    }
  } catch (error) {
    console.error('Error creating default admin:', error);
  }
};
