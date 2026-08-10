import { Response } from 'express';
import { AuthRequest } from '../middleware/auth.middleware';
import { sendSuccess, sendError } from '../utils/responseHelper';
import { answerQuestion, AiQueryError } from '../services/aiQuery.service';
import { CAPABILITIES } from '../services/aiQuery.schema';
import { env } from '../config/env';

const MIN_QUESTION_LENGTH = 3;
const MAX_QUESTION_LENGTH = 500;

/**
 * POST /ai/query — Answer an admin's natural-language question about the
 * database. Read-only; see aiQuery.schema.ts for the safety boundaries.
 *
 * Body: { question: string }
 */
export const aiQuery = async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const raw = req.body?.question;

    if (typeof raw !== 'string') {
      sendError(res, 'A "question" string is required', 400);
      return;
    }

    const question = raw.trim().replace(/\s+/g, ' ');

    if (question.length < MIN_QUESTION_LENGTH) {
      sendError(res, 'Please ask a longer question', 400);
      return;
    }
    if (question.length > MAX_QUESTION_LENGTH) {
      sendError(res, `Questions are limited to ${MAX_QUESTION_LENGTH} characters`, 400);
      return;
    }

    const result = await answerQuestion(question);
    sendSuccess(res, result, 'Query answered');
  } catch (error: any) {
    if (error instanceof AiQueryError) {
      sendError(res, error.message, error.status);
      return;
    }
    sendError(res, 'Failed to answer that question', 500, error?.message);
  }
};

/**
 * GET /ai/capabilities — What the chat can query, plus whether it's configured.
 * Lets the UI show a disabled state instead of failing on the first question.
 */
export const aiCapabilities = async (_req: AuthRequest, res: Response): Promise<void> => {
  sendSuccess(
    res,
    { ...CAPABILITIES, configured: !!env.GROQ_API_KEY, model: env.GROQ_MODEL },
    'Capabilities fetched',
  );
};
