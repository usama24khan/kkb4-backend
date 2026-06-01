import { Request, Response } from 'express';
import Plot, { IPlot } from '../models/Plot';
import Payment from '../models/Payment';
import Notice from '../models/Notice';
import { generatePlotNotice, generateBulkNotices, computeBreakdown, type PaymentRecordLike } from '../utils/pdfGenerator';
import { sendSuccess, sendError } from '../utils/responseHelper';
import { AuthRequest } from '../middleware/auth.middleware';
import { PHASE_BLOCK_MAP } from '../config/constants';
import path from 'path';
import fs from 'fs';

const CURRENT_YEAR = new Date().getFullYear();

/**
 * Pull year-range, language, min_dues, and payment-deadline from the request body
 * with safe defaults. Supports both `year_from`/`year_to` (spec) and legacy `year`.
 */
function readNoticeOptions(body: any) {
  const yearTo = parseInt(body?.year_to ?? body?.year ?? CURRENT_YEAR) || CURRENT_YEAR;
  const yearFromRaw = parseInt(body?.year_from ?? body?.year ?? yearTo);
  // Guarantee yearFrom <= yearTo.
  const yearFrom = isNaN(yearFromRaw) ? yearTo : Math.min(yearFromRaw, yearTo);
  const language: 'en' | 'ur' = body?.language === 'ur' ? 'ur' : 'en';
  const minDues = Math.max(0, parseInt(body?.min_dues ?? '0') || 0);
  const deadlineDays = parseInt(body?.payment_deadline_days ?? '0') || 0;
  const paymentDeadline = deadlineDays > 0
    ? new Date(Date.now() + deadlineDays * 24 * 60 * 60 * 1000)
    : null;
  return { yearFrom, yearTo, language, minDues, paymentDeadline };
}

/**
 * Compute outstanding dues for a plot over a year range. Used by both preview and generation.
 */
async function plotOutstanding(plotId: any, yearFrom: number, yearTo: number) {
  const payments = (await Payment.find({
    plot: plotId,
    year: { $gte: yearFrom, $lte: yearTo },
  }).lean()) as unknown as PaymentRecordLike[];
  const { grandTotal } = computeBreakdown(payments, yearFrom, yearTo);
  return { payments, outstanding: grandTotal };
}

/**
 * Resolve the list of plots covered by a request.
 *  - scope 'plot': single plot
 *  - scope 'block': all active plots in a block
 *  - scope 'phase': all active plots in the blocks of the phase
 */
async function resolvePlots(scope: 'plot' | 'block' | 'phase', target: string): Promise<IPlot[]> {
  if (scope === 'plot') {
    const p = await Plot.findById(target);
    return p ? [p] : [];
  }
  if (scope === 'block') {
    return Plot.find({ block: target.toUpperCase(), isActive: true });
  }
  // phase
  const blocks = PHASE_BLOCK_MAP[target];
  if (!blocks) return [];
  return Plot.find({ block: { $in: blocks }, isActive: true });
}

/**
 * POST /notices/preview
 * Body: { scope: 'plot'|'block'|'phase', target, year_from, year_to, min_dues }
 * Returns: { eligibleCount, totalPlots, grandTotal }
 *
 * Tells the admin how many notices will be generated before committing.
 */
export const previewNotices = async (req: Request, res: Response): Promise<void> => {
  try {
    const scope = (req.body?.scope || 'block') as 'plot' | 'block' | 'phase';
    const target = String(req.body?.target || '').trim();
    if (!target) {
      sendError(res, 'target is required', 400);
      return;
    }
    const { yearFrom, yearTo, minDues } = readNoticeOptions(req.body);

    const plots = await resolvePlots(scope, target);
    if (!plots.length) {
      sendSuccess(res, { eligibleCount: 0, totalPlots: 0, grandTotal: 0 }, 'No plots');
      return;
    }

    let eligibleCount = 0;
    let grandTotal = 0;

    for (const plot of plots) {
      const { outstanding } = await plotOutstanding(plot._id, yearFrom, yearTo);
      if (outstanding >= minDues && outstanding > 0) {
        eligibleCount++;
        grandTotal += outstanding;
      }
    }

    sendSuccess(res, {
      eligibleCount,
      totalPlots: plots.length,
      grandTotal,
      yearFrom,
      yearTo,
    }, 'Preview computed');
  } catch (error: any) {
    sendError(res, 'Failed to compute preview', 500, error.message);
  }
};

/**
 * Internal: generate notices for a resolved set of plots and persist a Notice record.
 * Filters out plots below the minDues threshold and plots with no outstanding dues.
 */
async function runGeneration(
  req: AuthRequest,
  res: Response,
  scope: 'plot' | 'block' | 'phase',
  target: string,
  plots: IPlot[],
): Promise<void> {
  const { yearFrom, yearTo, language, minDues, paymentDeadline } = readNoticeOptions(req.body);

  // Build per-plot bundles with payments and outstanding totals; drop ineligible.
  const eligible: Array<{ plot: IPlot; payments: PaymentRecordLike[]; outstanding: number }> = [];
  for (const plot of plots) {
    const { payments, outstanding } = await plotOutstanding(plot._id, yearFrom, yearTo);
    if (outstanding > 0 && outstanding >= minDues) {
      eligible.push({ plot, payments, outstanding });
    }
  }

  if (eligible.length === 0) {
    sendError(res, 'No plots have outstanding dues for the selected criteria', 404);
    return;
  }

  const startNumber = (await Notice.countDocuments()) + 1;
  const results = await generateBulkNotices(
    eligible.map((e) => ({ plot: e.plot, payments: e.payments })),
    yearFrom,
    yearTo,
    startNumber,
    language,
    paymentDeadline,
  );

  const totalDue = eligible.reduce((sum, e) => sum + e.outstanding, 0);
  const pdfPaths = results.map((r) => r.pdfPath);

  await Notice.create({
    type: scope,
    targetId: scope === 'plot' ? String(eligible[0].plot._id) : target,
    targetLabel: scope === 'plot' ? eligible[0].plot.plotBlock : target,
    year: yearTo,
    yearFrom,
    yearTo,
    language,
    paymentDeadline,
    minDuesThreshold: minDues,
    generatedBy: req.admin?.id,
    plotCount: eligible.length,
    totalDue,
    pdfPath: pdfPaths[0] || '',
    pdfPaths,
  });

  sendSuccess(res, {
    pdfPaths,
    count: pdfPaths.length,
    totalDue,
    yearFrom,
    yearTo,
  }, `${pdfPaths.length} notices generated`);
}

/**
 * POST /notices/generate
 * Body: { plot_ids: [...], year_from, year_to, language, min_dues, payment_deadline_days }
 *
 * Generates notices for an arbitrary list of plots (used for free-form
 * multi-plot selections from the admin UI).
 */
export const generateNotices = async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const { plot_ids } = req.body || {};
    if (!plot_ids || !Array.isArray(plot_ids) || plot_ids.length === 0) {
      sendError(res, 'plot_ids array is required', 400);
      return;
    }

    const plots = await Plot.find({ _id: { $in: plot_ids } });
    if (!plots.length) {
      sendError(res, 'No plots found', 404);
      return;
    }

    // Use 'plot' scope and a composite targetId so history reflects the selection.
    const targetId = plot_ids.join(',');
    await runGenerationWithTarget(req, res, 'plot', targetId, plots);
  } catch (error: any) {
    sendError(res, 'Failed to generate notices', 500, error.message);
  }
};

// Variant of runGeneration where the targetId may differ from a single plot's id
// (used by /generate which packs many plot ids into a comma-separated targetId).
async function runGenerationWithTarget(
  req: AuthRequest,
  res: Response,
  scope: 'plot' | 'block' | 'phase',
  targetId: string,
  plots: IPlot[],
): Promise<void> {
  const { yearFrom, yearTo, language, minDues, paymentDeadline } = readNoticeOptions(req.body);

  const eligible: Array<{ plot: IPlot; payments: PaymentRecordLike[]; outstanding: number }> = [];
  for (const plot of plots) {
    const { payments, outstanding } = await plotOutstanding(plot._id, yearFrom, yearTo);
    if (outstanding > 0 && outstanding >= minDues) {
      eligible.push({ plot, payments, outstanding });
    }
  }

  if (eligible.length === 0) {
    sendError(res, 'No plots have outstanding dues for the selected criteria', 404);
    return;
  }

  const startNumber = (await Notice.countDocuments()) + 1;
  const results = await generateBulkNotices(
    eligible.map((e) => ({ plot: e.plot, payments: e.payments })),
    yearFrom,
    yearTo,
    startNumber,
    language,
    paymentDeadline,
  );

  const totalDue = eligible.reduce((sum, e) => sum + e.outstanding, 0);
  const pdfPaths = results.map((r) => r.pdfPath);

  // For free-form multi-plot selections, show "374 A +N more" so history is
  // readable rather than a wall of ObjectIds.
  const firstLabel = eligible[0]?.plot.plotBlock || '';
  const targetLabel = eligible.length > 1
    ? `${firstLabel} +${eligible.length - 1} more`
    : firstLabel;

  await Notice.create({
    type: scope,
    targetId,
    targetLabel,
    year: yearTo,
    yearFrom,
    yearTo,
    language,
    paymentDeadline,
    minDuesThreshold: minDues,
    generatedBy: req.admin?.id,
    plotCount: eligible.length,
    totalDue,
    pdfPath: pdfPaths[0] || '',
    pdfPaths,
  });

  sendSuccess(res, {
    pdfPaths,
    count: pdfPaths.length,
    totalDue,
    yearFrom,
    yearTo,
  }, `${pdfPaths.length} notices generated`);
}

/**
 * POST /notices/plot/:plotId — Single-plot notice.
 */
export const generateForPlot = async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const { plotId } = req.params;
    const { yearFrom, yearTo, language, paymentDeadline } = readNoticeOptions(req.body);

    const plot = await Plot.findById(plotId);
    if (!plot) {
      sendError(res, 'Plot not found', 404);
      return;
    }

    const { payments, outstanding } = await plotOutstanding(plot._id, yearFrom, yearTo);

    const noticeNumber = (await Notice.countDocuments()) + 1;
    const result = await generatePlotNotice({
      plot,
      payments,
      yearFrom,
      yearTo,
      noticeNumber,
      language,
      paymentDeadline,
    });

    await Notice.create({
      type: 'plot',
      targetId: plotId,
      targetLabel: plot.plotBlock,
      year: yearTo,
      yearFrom,
      yearTo,
      language,
      paymentDeadline,
      generatedBy: req.admin?.id,
      plotCount: 1,
      totalDue: outstanding,
      pdfPath: result.pdfPath,
      pdfPaths: [result.pdfPath],
    });

    sendSuccess(res, {
      pdfPath: result.pdfPath,
      fileName: path.basename(result.pdfPath),
      totalDue: outstanding,
    }, 'Notice generated');
  } catch (error: any) {
    sendError(res, 'Failed to generate notice', 500, error.message);
  }
};

/**
 * POST /notices/block/:block — Notices for every defaulting plot in a block.
 */
export const generateForBlock = async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const { block } = req.params;
    const plots = await resolvePlots('block', block);
    if (!plots.length) {
      sendError(res, 'No plots found in block', 404);
      return;
    }
    await runGeneration(req, res, 'block', block.toUpperCase(), plots);
  } catch (error: any) {
    sendError(res, 'Failed to generate notices', 500, error.message);
  }
};

/**
 * POST /notices/phase/:phase — Notices for every defaulting plot in a phase.
 */
export const generateForPhase = async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const phase = req.params.phase;
    const plots = await resolvePlots('phase', phase);
    if (!plots.length) {
      sendError(res, 'Invalid phase or no plots found', 400);
      return;
    }
    await runGeneration(req, res, 'phase', phase, plots);
  } catch (error: any) {
    sendError(res, 'Failed to generate notices', 500, error.message);
  }
};

export const getNoticeHistory = async (req: Request, res: Response): Promise<void> => {
  try {
    const page = parseInt(req.query.page as string) || 1;
    const limit = parseInt(req.query.limit as string) || 20;
    const plotId = req.query.plot_id as string;

    const filter: any = {};
    if (plotId) {
      const plot = await Plot.findById(plotId).lean();
      filter.$or = [
        { type: 'plot', targetId: plotId },
        { type: 'plot', targetId: { $regex: new RegExp(`(^|,)${plotId}(,|$)`) } },
        { type: 'block', targetId: plot?.block },
        { type: 'phase', targetId: plot?.phase },
      ].filter((c) => c.targetId !== undefined);
    }

    const [notices, total] = await Promise.all([
      Notice.find(filter)
        .sort({ createdAt: -1 })
        .skip((page - 1) * limit)
        .limit(limit)
        .populate('generatedBy', 'name email')
        .lean(),
      Notice.countDocuments(filter),
    ]);

    // Backfill targetLabel for pre-migration notices where the field is empty.
    // For plot-scoped notices we resolve ObjectId → plotBlock; for the
    // comma-separated multi-plot case we resolve the first id and append "+N".
    // Block/phase notices already have human-readable targetId (e.g. "A").
    const idsToResolve = new Set<string>();
    for (const n of notices) {
      if (n.targetLabel) continue;
      if (n.type !== 'plot') continue;
      const ids = String(n.targetId).split(',').map((s) => s.trim()).filter(Boolean);
      // We only need the first id of each notice for the label.
      if (ids[0]) idsToResolve.add(ids[0]);
    }

    let plotLookup: Record<string, string> = {};
    if (idsToResolve.size > 0) {
      const plots = await Plot.find(
        { _id: { $in: Array.from(idsToResolve) } },
        { _id: 1, plotBlock: 1 },
      ).lean();
      plotLookup = Object.fromEntries(plots.map((p) => [String(p._id), p.plotBlock]));
    }

    const enriched = notices.map((n) => {
      if (n.targetLabel) return n;
      if (n.type === 'plot') {
        const ids = String(n.targetId).split(',').map((s) => s.trim()).filter(Boolean);
        const first = ids[0] ? plotLookup[ids[0]] : undefined;
        if (first) {
          const label = ids.length > 1 ? `${first} +${ids.length - 1} more` : first;
          return { ...n, targetLabel: label };
        }
      }
      return { ...n, targetLabel: n.targetId };
    });

    res.json({
      success: true,
      data: enriched,
      message: 'Notice history fetched',
      meta: { page, limit, total, totalPages: Math.ceil(total / limit) },
    });
  } catch (error: any) {
    sendError(res, 'Failed to fetch notice history', 500, error.message);
  }
};

export const downloadNotice = async (req: Request, res: Response): Promise<void> => {
  try {
    const { fileName } = req.params;
    const filePath = path.join(__dirname, '../../notices', fileName);
    if (!fs.existsSync(filePath)) {
      sendError(res, 'File not found', 404);
      return;
    }
    res.download(filePath);
  } catch (error: any) {
    sendError(res, 'Failed to download', 500, error.message);
  }
};
