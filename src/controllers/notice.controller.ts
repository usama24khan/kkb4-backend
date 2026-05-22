import { Request, Response } from 'express';
import Plot from '../models/Plot';
import Payment from '../models/Payment';
import Notice from '../models/Notice';
import { generatePlotNotice, generateBulkNotices } from '../utils/pdfGenerator';
import { sendSuccess, sendError } from '../utils/responseHelper';
import { AuthRequest } from '../middleware/auth.middleware';
import { PHASE_BLOCK_MAP } from '../config/constants';
import path from 'path';
import fs from 'fs';

/**
 * POST /notices/generate — Generate notices for one or multiple plots
 * Body: { plot_ids: [id1, id2, ...], year, month_from, month_to, custom_message? }
 */
export const generateNotices = async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const { plot_ids, year: yearParam, month_from, month_to, custom_message } = req.body;
    const year = parseInt(yearParam) || new Date().getFullYear();

    if (!plot_ids || !Array.isArray(plot_ids) || plot_ids.length === 0) {
      sendError(res, 'plot_ids array is required', 400);
      return;
    }

    const plots = await Plot.find({ _id: { $in: plot_ids } });
    if (!plots.length) { sendError(res, 'No plots found', 404); return; }

    const plotsWithPayments = [];
    let totalDue = 0;

    for (const plot of plots) {
      const payments = await Payment.find({ plot: plot._id }).lean();
      plotsWithPayments.push({ plot: plot as any, payments: payments as any });
      const yp = payments.find(p => p.year === year);
      if (yp) totalDue += yp.remaining;
    }

    const startNumber = (await Notice.countDocuments()) + 1;
    const pdfPaths = await generateBulkNotices(plotsWithPayments, year, startNumber);

    await Notice.create({
      type: 'plot',
      targetId: plot_ids.join(','),
      year,
      monthFrom: month_from || 'jan',
      monthTo: month_to || 'dec',
      generatedBy: req.admin?.id,
      plotCount: plots.length,
      totalDue,
      pdfPath: pdfPaths[0] || '',
    });

    sendSuccess(res, { pdfPaths, count: pdfPaths.length }, `${pdfPaths.length} notices generated`);
  } catch (error: any) {
    sendError(res, 'Failed to generate notices', 500, error.message);
  }
};

export const generateForPlot = async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const { plotId } = req.params;
    const year = parseInt(req.body.year) || new Date().getFullYear();
    const plot = await Plot.findById(plotId);
    if (!plot) { sendError(res, 'Plot not found', 404); return; }
    const payments = await Payment.find({ plot: plotId }).lean();
    const noticeNumber = (await Notice.countDocuments()) + 1;
    const pdfPath = await generatePlotNotice({ plot: plot as any, payments: payments as any, year, noticeNumber });
    await Notice.create({ type: 'plot', targetId: plotId, year, generatedBy: req.admin?.id, plotCount: 1, totalDue: payments.find(p => p.year === year)?.remaining || 0, pdfPath });
    sendSuccess(res, { pdfPath, fileName: path.basename(pdfPath) }, 'Notice generated');
  } catch (error: any) { sendError(res, 'Failed to generate notice', 500, error.message); }
};

export const generateForBlock = async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const { block } = req.params;
    const year = parseInt(req.body.year) || new Date().getFullYear();
    const plots = await Plot.find({ block: block.toUpperCase(), isActive: true });
    if (!plots.length) { sendError(res, 'No plots found', 404); return; }
    const plotsWithPayments = [];
    let totalDue = 0;
    for (const plot of plots) {
      const payments = await Payment.find({ plot: plot._id }).lean();
      plotsWithPayments.push({ plot: plot as any, payments: payments as any });
      const yp = payments.find(p => p.year === year);
      if (yp) totalDue += yp.remaining;
    }
    const startNumber = (await Notice.countDocuments()) + 1;
    const pdfPaths = await generateBulkNotices(plotsWithPayments, year, startNumber);
    await Notice.create({ type: 'block', targetId: block.toUpperCase(), year, generatedBy: req.admin?.id, plotCount: plots.length, totalDue, pdfPath: pdfPaths[0] || '' });
    sendSuccess(res, { pdfPaths, count: pdfPaths.length }, `${pdfPaths.length} notices generated`);
  } catch (error: any) { sendError(res, 'Failed to generate notices', 500, error.message); }
};

export const generateForPhase = async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const phase = req.params.phase;
    const year = parseInt(req.body.year) || new Date().getFullYear();
    const blocks = PHASE_BLOCK_MAP[phase];
    if (!blocks) { sendError(res, 'Invalid phase', 400); return; }
    const plots = await Plot.find({ block: { $in: blocks }, isActive: true });
    const plotsWithPayments = [];
    let totalDue = 0;
    for (const plot of plots) {
      const payments = await Payment.find({ plot: plot._id }).lean();
      plotsWithPayments.push({ plot: plot as any, payments: payments as any });
      const yp = payments.find(p => p.year === year);
      if (yp) totalDue += yp.remaining;
    }
    const startNumber = (await Notice.countDocuments()) + 1;
    const pdfPaths = await generateBulkNotices(plotsWithPayments, year, startNumber);
    await Notice.create({ type: 'phase', targetId: phase, year, generatedBy: req.admin?.id, plotCount: plots.length, totalDue, pdfPath: pdfPaths[0] || '' });
    sendSuccess(res, { pdfPaths, count: pdfPaths.length }, `${pdfPaths.length} notices generated`);
  } catch (error: any) { sendError(res, 'Failed to generate notices', 500, error.message); }
};

export const getNoticeHistory = async (req: Request, res: Response): Promise<void> => {
  try {
    const page = parseInt(req.query.page as string) || 1;
    const limit = parseInt(req.query.limit as string) || 20;
    const [notices, total] = await Promise.all([
      Notice.find().sort({ createdAt: -1 }).skip((page - 1) * limit).limit(limit).populate('generatedBy', 'name email').lean(),
      Notice.countDocuments(),
    ]);
    res.json({ success: true, data: notices, message: 'Notice history fetched', meta: { page, limit, total, totalPages: Math.ceil(total / limit) } });
  } catch (error: any) { sendError(res, 'Failed to fetch notice history', 500, error.message); }
};

export const downloadNotice = async (req: Request, res: Response): Promise<void> => {
  try {
    const { fileName } = req.params;
    const filePath = path.join(__dirname, '../../notices', fileName);
    if (!fs.existsSync(filePath)) { sendError(res, 'File not found', 404); return; }
    res.download(filePath);
  } catch (error: any) { sendError(res, 'Failed to download', 500, error.message); }
};
