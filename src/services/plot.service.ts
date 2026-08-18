import Plot, { IPlot } from '../models/Plot';
import Payment from '../models/Payment';
import { BLOCK_PHASE_MAP, PHASE_BLOCK_MAP } from '../config/constants';
import { resolvePhaseForBlock } from '../utils/blockRegistry';

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
    // Resolve phase from the block registry (constants ∪ DB) unless one was
    // explicitly provided. The pre-save hook keeps this value for custom
    // (DB-backed) blocks and re-derives it for built-in constant blocks.
    const blockCode = (data.block || '').toString().toUpperCase();
    if (!data.phase && blockCode) {
      data.phase = await resolvePhaseForBlock(blockCode);
    }
    const plot = new Plot(data);
    return plot.save();
  }

  /**
   * Update a plot, keeping its derived fields honest.
   *
   * `plotBlock`, `plotCode` and `phase` are what the rest of the app reads — plot
   * lists, search, the block and phase pages, the payments grid, the AI answers —
   * so moving a plot to another block has to rewrite all three, or the plot keeps
   * showing under its old block everywhere.
   *
   * They are computed here rather than left to schema middleware: a flat update
   * object never reaches that middleware's rewrite, so a block change persisted
   * while `plotBlock` stayed one edit behind. Doing it in the open, from the merged
   * old and new values, is both correct and visible to whoever reads this next.
   *
   * Everything else about a plot refers to it by id — payments, ledger entries,
   * dues — so those follow a move on their own. Receipts and notices keep the block
   * they were issued with by design, being records of documents already sent.
   */
  static async update(id: string, data: Partial<IPlot>) {
    const changesIdentity = data.plotNumber !== undefined || data.block !== undefined;
    if (!changesIdentity) {
      return Plot.findByIdAndUpdate(id, data, { new: true, runValidators: true });
    }

    const current = await Plot.findById(id).select('plotNumber block phase').lean();
    if (!current) return null;

    const plotNumber = String(data.plotNumber ?? current.plotNumber ?? '').trim();
    const block = String(data.block ?? current.block ?? '').toUpperCase().trim();

    const next: Record<string, any> = {
      ...data,
      plotNumber,
      block,
      plotBlock: `${plotNumber} ${block}`.trim(),
      plotCode: `${plotNumber}-${block}`.trim(),
    };

    // Constant blocks have an authoritative phase; a custom block is resolved
    // through the registry, and only overwritten if that lookup finds something.
    const mappedPhase = BLOCK_PHASE_MAP[block];
    if (mappedPhase) {
      next.phase = mappedPhase;
    } else if (block && block !== current.block) {
      const resolved = await resolvePhaseForBlock(block);
      if (resolved) next.phase = resolved;
    }

    return Plot.findByIdAndUpdate(id, { $set: next }, { new: true, runValidators: true });
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
