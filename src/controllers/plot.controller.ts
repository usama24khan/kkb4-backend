import { Request, Response } from 'express';
import { PlotService } from '../services/plot.service';
import { createPlotSchema, updatePlotSchema } from '../validations/plot.validation';
import { sendSuccess, sendError, sendPaginated } from '../utils/responseHelper';
import AuditLog from '../models/AuditLog';
import { AuthRequest } from '../middleware/auth.middleware';

export const getPlots = async (req: Request, res: Response): Promise<void> => {
  try {
    const { block, phase, status, search, page, limit, sortBy, sortOrder } = req.query;

    const result = await PlotService.getAll({
      block: block as string,
      phase: phase as string,
      status: status as string,
      search: search as string,
      page: page ? parseInt(page as string) : 1,
      limit: limit ? parseInt(limit as string) : 50,
      sortBy: (sortBy as string) || 'plotNumber',
      sortOrder: (sortOrder as 'asc' | 'desc') || 'asc',
    });

    sendPaginated(res, result.items, result.total, result.page, result.limit, 'Plots fetched');
  } catch (error: any) {
    sendError(res, 'Failed to fetch plots', 500, error.message);
  }
};

export const getPlotById = async (req: Request, res: Response): Promise<void> => {
  try {
    const { plotId } = req.params;
    const plot = await PlotService.getPlotWithPayments(plotId);

    if (!plot) {
      sendError(res, 'Plot not found', 404);
      return;
    }

    sendSuccess(res, plot, 'Plot fetched');
  } catch (error: any) {
    sendError(res, 'Failed to fetch plot', 500, error.message);
  }
};

export const searchPlots = async (req: Request, res: Response): Promise<void> => {
  try {
    const q = req.query.q as string;
    if (!q || q.trim().length === 0) {
      sendSuccess(res, [], 'No search query provided');
      return;
    }

    const results = await PlotService.search(q.trim(), 20);
    sendSuccess(res, results, `Found ${results.length} plots`);
  } catch (error: any) {
    sendError(res, 'Search failed', 500, error.message);
  }
};

export const createPlot = async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const validation = createPlotSchema.safeParse(req.body);
    if (!validation.success) {
      sendError(res, 'Validation failed', 400, validation.error.message);
      return;
    }

    const plot = await PlotService.create(validation.data);

    // Audit log
    if (req.admin) {
      await AuditLog.create({
        admin: req.admin.id,
        action: 'create',
        entity: 'plot',
        entityId: plot._id.toString(),
        changes: validation.data,
      });
    }

    sendSuccess(res, plot, 'Plot created', 201);
  } catch (error: any) {
    if (error.code === 11000) {
      sendError(res, 'Plot already exists in this block', 409);
      return;
    }
    sendError(res, 'Failed to create plot', 500, error.message);
  }
};

export const updatePlot = async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const { plotId } = req.params;
    const validation = updatePlotSchema.safeParse(req.body);
    if (!validation.success) {
      sendError(res, 'Validation failed', 400, validation.error.message);
      return;
    }

    const plot = await PlotService.update(plotId, validation.data);
    if (!plot) {
      sendError(res, 'Plot not found', 404);
      return;
    }

    if (req.admin) {
      await AuditLog.create({
        admin: req.admin.id,
        action: 'update',
        entity: 'plot',
        entityId: plotId,
        changes: validation.data,
      });
    }

    sendSuccess(res, plot, 'Plot updated');
  } catch (error: any) {
    sendError(res, 'Failed to update plot', 500, error.message);
  }
};

export const deletePlot = async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const { plotId } = req.params;
    const plot = await PlotService.softDelete(plotId);

    if (!plot) {
      sendError(res, 'Plot not found', 404);
      return;
    }

    if (req.admin) {
      await AuditLog.create({
        admin: req.admin.id,
        action: 'delete',
        entity: 'plot',
        entityId: plotId,
        changes: { isActive: false },
      });
    }

    sendSuccess(res, plot, 'Plot deleted (soft)');
  } catch (error: any) {
    sendError(res, 'Failed to delete plot', 500, error.message);
  }
};
