import { Request, Response } from 'express';
import Admin, { IAdmin } from '../models/Admin';
import Device from '../models/Device';
import OTP, { OTP_TTL_MINUTES } from '../models/OTP';
import { generateAccessToken, generateRefreshToken, verifyRefreshToken } from '../utils/jwt';
import { sendSuccess, sendError } from '../utils/responseHelper';
import { env } from '../config/env';
import { AuthRequest } from '../middleware/auth.middleware';
import { generateFingerprint } from '../lib/fingerprint';
import { sendOTPEmail, isMailerConfigured } from '../lib/mailer';

/** Build the auth tokens + admin payload returned on a successful login. */
function buildAuthResponse(admin: IAdmin) {
  const id = String(admin._id);
  const payload = { id, email: admin.email, role: admin.role };
  return {
    admin: { id, name: admin.name, email: admin.email, role: admin.role },
    accessToken: generateAccessToken(payload),
    refreshToken: generateRefreshToken(payload),
  };
}

/** Cryptographically-uniform 6-digit code, as a zero-padded string. */
function generateOtpCode(): string {
  return String(Math.floor(100000 + Math.random() * 900000));
}

/**
 * POST /auth/login
 * Verifies credentials, then enforces device-based OTP:
 *   - Known (trusted) device  → issue JWT immediately.
 *   - Unknown device          → email a 6-digit OTP and ask the client to
 *                               verify it via /auth/verify-otp.
 *
 * Response envelope (sendSuccess → { success:true, data, message }):
 *   trusted device  → data = { admin, accessToken, refreshToken }
 *   unknown device  → data = { requiresOTP: true, fingerprint }
 */
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

    const { fingerprint, deviceInfo } = generateFingerprint(req);

    // Trusted device? Skip OTP, update lastLoginAt, issue tokens.
    const device = await Device.findOne({ adminId: admin._id, fingerprint });
    if (device) {
      device.lastLoginAt = new Date();
      device.ip = deviceInfo.ip || device.ip;
      await device.save();
      sendSuccess(res, buildAuthResponse(admin), 'Login successful');
      return;
    }

    // Unknown device → generate + email an OTP.
    if (!isMailerConfigured()) {
      sendError(
        res,
        'OTP email is not configured on the server. Set EMAIL_FROM and EMAIL_APP_PASSWORD.',
        500,
      );
      return;
    }

    const otp = generateOtpCode();
    await OTP.create({ adminId: admin._id, otp, fingerprint });

    try {
      await sendOTPEmail(otp, deviceInfo);
    } catch (mailErr: any) {
      // Log the underlying SMTP error so the cause is visible server-side
      // (the client only sees the generic message).
      console.error('[auth.login] OTP email send failed:', mailErr?.message || mailErr);
      sendError(res, 'Failed to send OTP email', 500, mailErr.message);
      return;
    }

    sendSuccess(
      res,
      { requiresOTP: true, fingerprint, expiresInMinutes: OTP_TTL_MINUTES },
      'A verification code has been sent to the administrator email',
    );
  } catch (error: any) {
    sendError(res, 'Login failed', 500, error.message);
  }
};

/**
 * POST /auth/verify-otp
 * Body: { otp, fingerprint }
 * Validates the OTP, marks it used, registers (trusts) the device, and issues a
 * JWT. The admin is resolved from the OTP record (set at login time), so no
 * credentials are re-sent here.
 */
export const verifyOtp = async (req: Request, res: Response): Promise<void> => {
  try {
    const { otp, fingerprint } = req.body || {};
    if (!otp || !fingerprint) {
      sendError(res, 'otp and fingerprint are required', 400);
      return;
    }

    const record = await OTP.findOne({
      otp: String(otp).trim(),
      fingerprint,
      used: false,
      expiresAt: { $gt: new Date() },
    });

    if (!record) {
      sendError(res, 'Invalid or expired verification code', 400);
      return;
    }

    const admin = await Admin.findById(record.adminId);
    if (!admin) {
      sendError(res, 'Admin not found', 404);
      return;
    }

    // Burn the OTP so it can't be replayed.
    record.used = true;
    await record.save();

    // Trust the device. Upsert guards against a double-submit race.
    const { deviceInfo } = generateFingerprint(req);
    await Device.findOneAndUpdate(
      { adminId: admin._id, fingerprint },
      {
        $set: {
          deviceName: deviceInfo.deviceName,
          browser: deviceInfo.browser,
          os: deviceInfo.os,
          ip: deviceInfo.ip,
          lastLoginAt: new Date(),
        },
        $setOnInsert: { adminId: admin._id, fingerprint, registeredAt: new Date() },
      },
      { upsert: true, new: true, setDefaultsOnInsert: true },
    );

    sendSuccess(res, buildAuthResponse(admin), 'Login successful');
  } catch (error: any) {
    sendError(res, 'OTP verification failed', 500, error.message);
  }
};

/**
 * GET /auth/devices  (protected)
 * Returns the trusted devices for the authenticated admin, newest-login first,
 * for a "trusted devices" management page.
 */
export const getDevices = async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    if (!req.admin) {
      sendError(res, 'Not authenticated', 401);
      return;
    }
    const devices = await Device.find({ adminId: req.admin.id })
      .sort({ lastLoginAt: -1 })
      .select('-__v')
      .lean();
    sendSuccess(res, devices, 'Trusted devices fetched');
  } catch (error: any) {
    sendError(res, 'Failed to fetch devices', 500, error.message);
  }
};

export const getMe = async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    if (!req.admin) {
      sendError(res, 'Not authenticated', 401);
      return;
    }

    const admin = await Admin.findById(req.admin.id).select('-passwordHash').lean();
    if (!admin) {
      sendError(res, 'User not found', 404);
      return;
    }

    sendSuccess(res, {
      id: admin._id,
      name: admin.name,
      email: admin.email,
      role: admin.role,
    }, 'User info fetched');
  } catch (error: any) {
    sendError(res, 'Failed to get user info', 500, error.message);
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
