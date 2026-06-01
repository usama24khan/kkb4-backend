import { Request, Response } from 'express';
import AuditLog from '../models/AuditLog';
import { sendError } from '../utils/responseHelper';

/**
 * GET /audit-log
 * Query: plot_id, entity, entity_id, admin_id, action, page, limit
 * Returns paginated audit entries. Filters compose with AND.
 */
export const getAuditLog = async (req: Request, res: Response): Promise<void> => {
  try {
    const page = parseInt(req.query.page as string) || 1;
    const limit = Math.min(parseInt(req.query.limit as string) || 50, 200);

    const filter: any = {};
    const plotId = req.query.plot_id as string;
    const entity = req.query.entity as string;
    const entityId = req.query.entity_id as string;
    const adminId = req.query.admin_id as string;
    const action = req.query.action as string;

    if (plotId) {
      filter.entityId = plotId;
      filter.entity = 'plot';
    }
    if (entity) filter.entity = entity;
    if (entityId) filter.entityId = entityId;
    if (adminId) filter.admin = adminId;
    if (action) filter.action = action;

    const [items, total] = await Promise.all([
      AuditLog.find(filter)
        .sort({ createdAt: -1 })
        .skip((page - 1) * limit)
        .limit(limit)
        .populate('admin', 'name email')
        .lean(),
      AuditLog.countDocuments(filter),
    ]);

    res.json({
      success: true,
      data: items,
      message: 'Audit log fetched',
      meta: { page, limit, total, totalPages: Math.ceil(total / limit) },
    });
  } catch (error: any) {
    sendError(res, 'Failed to fetch audit log', 500, error.message);
  }
};
