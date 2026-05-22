import { Request, Response } from 'express';
import multer from 'multer';
import path from 'path';
import { parseExcelFile } from '../utils/excelParser';
import { PlotService } from '../services/plot.service';
import { PaymentService } from '../services/payment.service';
import { sendSuccess, sendError } from '../utils/responseHelper';
import { AuthRequest } from '../middleware/auth.middleware';
import { BLOCK_PHASE_MAP } from '../config/constants';

const uploadsDir = path.join(__dirname, '../../uploads');

const storage = multer.diskStorage({
  destination: (_req, _file, cb) => cb(null, uploadsDir),
  filename: (_req, file, cb) => cb(null, `import_${Date.now()}${path.extname(file.originalname)}`),
});

export const upload = multer({
  storage,
  fileFilter: (_req, file, cb) => {
    const ext = path.extname(file.originalname).toLowerCase();
    if (ext === '.xlsx' || ext === '.xls') cb(null, true);
    else cb(new Error('Only .xlsx and .xls files are allowed'));
  },
  limits: { fileSize: 10 * 1024 * 1024 },
});

let lastImportStatus: any = null;

export const importExcel = async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    if (!req.file) { sendError(res, 'No file uploaded', 400); return; }

    const filePath = req.file.path;
    const parsedData = parseExcelFile(filePath);
    let plotsCreated = 0, plotsUpdated = 0, paymentsCreated = 0, errors: string[] = [];

    for (const entry of parsedData) {
      try {
        const plot = await PlotService.upsert(entry.plotNumber, entry.block, {
          srNo: entry.srNo,
          ownerName: entry.ownerName,
          plotNumber: entry.plotNumber,
          block: entry.block,
          phase: BLOCK_PHASE_MAP[entry.block] || '',
          plotBlock: entry.plotBlock,
          allotmentStatus: entry.allotmentStatus as any,
        });

        if ((plot as any).wasNew !== false) plotsCreated++; else plotsUpdated++;

        await PaymentService.upsert(plot._id.toString(), entry.year, {
          mcRate: entry.mcRate,
          payments: entry.payments as any,
        });
        paymentsCreated++;
      } catch (err: any) {
        errors.push(`${entry.plotBlock} (${entry.year}): ${err.message}`);
      }
    }

    lastImportStatus = {
      timestamp: new Date(),
      file: req.file.originalname,
      totalParsed: parsedData.length,
      plotsCreated, plotsUpdated, paymentsCreated,
      errors: errors.slice(0, 50),
      errorCount: errors.length,
    };

    sendSuccess(res, lastImportStatus, 'Import completed');
  } catch (error: any) { sendError(res, 'Import failed', 500, error.message); }
};

export const getImportStatus = async (_req: Request, res: Response): Promise<void> => {
  sendSuccess(res, lastImportStatus, lastImportStatus ? 'Last import status' : 'No imports yet');
};
