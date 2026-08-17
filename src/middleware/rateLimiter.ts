import rateLimit from 'express-rate-limit';
import { env } from '../config/env';

/**
 * Blanket limit for every /api route.
 *
 * Raised from 100 when the Accounts pages landed. Those pages read the cash book
 * as several independent reports (month summary, year table, all-year history,
 * ledger, categories), so one visit costs ~6 requests and every month or year the
 * user clicks costs 4 more. At 100 per 15 minutes an admin reviewing a year of
 * accounts — or a household on a shared society IP, since the portal is one
 * account behind NAT — hit the wall during ordinary use and saw the page fail.
 *
 * 600 per 15 minutes still caps a runaway client at ~40 requests/second-average
 * while leaving normal browsing far below the ceiling. Login stays strict via
 * authLimiter.
 *
 * Override with RATE_LIMIT_MAX — useful when a local test run replays hundreds of
 * requests from one address and the limiter would otherwise mask the results.
 */
export const generalLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: env.RATE_LIMIT_MAX,
  message: { success: false, message: 'Too many requests, please try again later.' },
  standardHeaders: true,
  legacyHeaders: false,
});

export const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 10,
  message: { success: false, message: 'Too many login attempts, please try again later.' },
  standardHeaders: true,
  legacyHeaders: false,
});

/**
 * AI chat: a handful of admins asking occasional questions. Each request costs
 * two Groq calls, so this mostly protects the free-tier quota from a runaway
 * client rather than defending against abuse.
 */
export const aiQueryLimiter = rateLimit({
  windowMs: 5 * 60 * 1000, // 5 minutes
  max: 30,
  message: { success: false, message: 'Too many AI questions — please wait a minute and try again.' },
  standardHeaders: true,
  legacyHeaders: false,
});

export const importLimiter = rateLimit({
  windowMs: 60 * 60 * 1000, // 1 hour
  max: 5,
  message: { success: false, message: 'Import limit reached, please try again later.' },
  standardHeaders: true,
  legacyHeaders: false,
});
