import Plot, { IPlot } from '../models/Plot';
import Payment from '../models/Payment';
import { BLOCK_PHASE_MAP, PHASE_BLOCK_MAP } from '../config/constants';

interface PlotQuery {
  block?: string;
  phase?: string;
  status?: string;
  search?: string;
  isActive?: boolean;
  page?: number;
  limit?: number;
  sortBy?: string;
  sortOrder?: 'asc' | 'desc';
}

export class PlotService {
  static async getAll(query: PlotQuery) {
    const {
      block, phase, status, search, isActive = true,
      page = 1, limit = 50, sortBy = 'plotNumber', sortOrder = 'asc'
    } = query;

    const filter: any = {};
    if (isActive !== undefined) filter.isActive = isActive;
    if (block) filter.block = block.toUpperCase();
    if (phase) {
      // Phase is now a string like "Phase 1"
      const blocks = PHASE_BLOCK_MAP[phase];
      if (blocks) {
        filter.block = { $in: blocks };
      }
    }
    if (status) filter.allotmentStatus = status;
    if (search) {
      filter.$or = [
        { ownerName: { $regex: search, $options: 'i' } },
        { plotNumber: { $regex: search, $options: 'i' } },
        { plotBlock: { $regex: search, $options: 'i' } },
        { plotCode: { $regex: search, $options: 'i' } },
      ];
    }

    const sort: any = {};
    sort[sortBy] = sortOrder === 'desc' ? -1 : 1;

    const skip = (page - 1) * limit;
    const [items, total] = await Promise.all([
      Plot.find(filter).sort(sort).skip(skip).limit(limit).lean(),
      Plot.countDocuments(filter),
    ]);

    return { items, total, page, limit };
  }

  static async getById(id: string) {
    return Plot.findById(id).lean();
  }

  static async getByPlotBlock(plotNumber: string, block: string) {
    return Plot.findOne({ plotNumber, block: block.toUpperCase() }).lean();
  }

  static async create(data: Partial<IPlot>) {
    const plot = new Plot(data);
    return plot.save();
  }

  static async update(id: string, data: Partial<IPlot>) {
    return Plot.findByIdAndUpdate(id, data, { new: true, runValidators: true });
  }

  static async softDelete(id: string) {
    return Plot.findByIdAndUpdate(id, { isActive: false }, { new: true });
  }

  static async getPlotWithPayments(id: string): Promise<any> {
    const plot = await Plot.findById(id).lean();
    if (!plot) return null;

    const payments = await Payment.find({ plot: id }).sort({ year: 1 }).lean();
    return { ...plot, plotCode: `${plot.plotNumber}-${plot.block}`, payments };
  }

  static async getPlotsByBlock(block: string) {
    return Plot.find({ block: block.toUpperCase(), isActive: true })
      .sort({ plotNumber: 1 })
      .lean();
  }

  static async getPlotsByPhase(phase: string) {
    const blocks = PHASE_BLOCK_MAP[phase] || [];
    return Plot.find({ block: { $in: blocks }, isActive: true })
      .sort({ block: 1, plotNumber: 1 })
      .lean();
  }

  static async getPlotCount(filter: any = {}) {
    return Plot.countDocuments({ ...filter, isActive: true });
  }

  static async upsert(plotNumber: string, block: string, data: Partial<IPlot>) {
    return Plot.findOneAndUpdate(
      { plotNumber, block: block.toUpperCase() },
      { $set: data },
      { upsert: true, new: true, runValidators: true, setDefaultsOnInsert: true }
    );
  }

  /**
   * Search plots by plot_code or owner_name
   */
  static async search(q: string, limit: number = 20) {
    const filter = {
      isActive: true,
      $or: [
        { ownerName: { $regex: q, $options: 'i' } },
        { plotCode: { $regex: q, $options: 'i' } },
        { plotBlock: { $regex: q, $options: 'i' } },
        { plotNumber: { $regex: q, $options: 'i' } },
      ],
    };
    return Plot.find(filter).sort({ block: 1, plotNumber: 1 }).limit(limit).lean();
  }
}
