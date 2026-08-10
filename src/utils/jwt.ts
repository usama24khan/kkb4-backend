import jwt from 'jsonwebtoken';
import { env } from '../config/env';

interface TokenPayload {
  id: string;
  email: string;
  role: string;
}

/**
 * Sign an access token. `expiresIn` overrides the default TTL — used by the
 * shared user portal, whose read-only session shouldn't expire every 15 minutes.
 */
export const generateAccessToken = (payload: TokenPayload, expiresIn?: string): string => {
  return jwt.sign(payload, env.JWT_SECRET, {
    expiresIn: (expiresIn || env.JWT_EXPIRES_IN) as any,
  });
};

export const generateRefreshToken = (payload: TokenPayload): string => {
  return jwt.sign(payload, env.JWT_REFRESH_SECRET, { expiresIn: env.JWT_REFRESH_EXPIRES_IN as any });
};

export const verifyAccessToken = (token: string): TokenPayload => {
  return jwt.verify(token, env.JWT_SECRET) as TokenPayload;
};

export const verifyRefreshToken = (token: string): TokenPayload => {
  return jwt.verify(token, env.JWT_REFRESH_SECRET) as TokenPayload;
};
