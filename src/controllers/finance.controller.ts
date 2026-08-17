import { Request, Response } from 'express';
import { Types } from 'mongoose';
import Collection from '../models/Collection';
import Expense from '../models/Expense';
import ExpenseCategory from '../models/ExpenseCategory';
import FinanceSettings from '../models/FinanceSettings';
import AuditLog from '../models/AuditLog';
import { AuthRequest } from '../middleware/auth.middleware';
import { ViewerRequest } from '../middleware/anyAuth.middleware';
import { sendSuccess, sendError } from '../utils/responseHelper';
import { currentBookPeriod, parseMonthParam, toBookPeriod } from '../utils/financePeriod';
import * as finance from '../services/finance.service';

/**
 * finance.controller.ts
 * =====================
 * HTTP surface for the society cash book.
 *
 * Read endpoints are shared between the admin app and the resident portal — the
 * committee and the residents look at the same numbers by design. Resident
 * requests get the same figures with admin-only fields stripped (who recorded an
 * entry, and the uploaded bill images).
 *
 * Write endpoints are admin-only and every one of them leaves an AuditLog row.
 */

/** Fields a resident should not see on an expense row. */
function forResident(expense: any) {
  const { attachmentUrl, recordedBy, ...rest } = expense || {};
  return rest;
}

/** Resolve `?year=&month=` with a fallback to the current society month. */
function resolvePeriod(req: Request): { year: number; month: number } | null {
  const now = currentBookPeriod();
  const yearRaw = req.query.year;
  const year = yearRaw === undefined || yearRaw === '' ? now.bookYear : parseInt(String(yearRaw), 10);
  if (!Number.isInteger(year) || year < 2000 || year > 2100) return null;

  const monthRaw = req.query.month;
  const month = monthRaw === undefined || monthRaw === '' ? now.bookMonth : parseMonthParam(monthRaw);
  if (!month) return null;

  return { year, month };
}

// ── Reports (admin + resident) ───────────────────────────────────────────────

/**
 * GET /finance/overview — headline tiles: this month's income, spend and
 * surplus, plus the savings pool.
 */
export const getOverview = async (_req: Request, res: Response): Promise<void> => {
  try {
    const overview = await finance.getFinanceOverview();
    sendSuccess(res, overview, 'Finance overview fetched');
  } catch (error: any) {
    sendError(res, 'Failed to fetch finance overview', 500, error.message);
  }
};

/**
 * GET /finance/summary?year&month — one month in full: income split, expense
 * lines, the month's saving, and the savings balance before and after it.
 */
export const getMonthSummary = async (req: ViewerRequest, res: Response): Promise<void> => {
  try {
    const period = resolvePeriod(req);
    if (!period) {
      sendError(res, 'Invalid year or month', 400);
      return;
    }

    const report = await finance.getMonthReport(period.year, period.month);
    if (!req.viewer?.isAdmin) {
      report.expenses = report.expenses.map(forResident);
    }
    sendSuccess(res, report, 'Month summary fetched');
  } catch (error: any) {
    sendError(res, 'Failed to fetch month summary', 500, error.message);
  }
};

/** GET /finance/year?year — the twelve-month table for one year. */
export const getYearSummary = async (req: Request, res: Response): Promise<void> => {
  try {
    const now = currentBookPeriod();
    const year = req.query.year ? parseInt(String(req.query.year), 10) : now.bookYear;
    if (!Number.isInteger(year) || year < 2000 || year > 2100) {
      sendError(res, 'Invalid year', 400);
      return;
    }
    sendSuccess(res, await finance.getYearReport(year), 'Year summary fetched');
  } catch (error: any) {
    sendError(res, 'Failed to fetch year summary', 500, error.message);
  }
};

/** GET /finance/yearly — every year with activity, plus the all-time totals. */
export const getYearlySummary = async (_req: Request, res: Response): Promise<void> => {
  try {
    sendSuccess(res, await finance.getYearlyReport(), 'Yearly summary fetched');
  } catch (error: any) {
    sendError(res, 'Failed to fetch yearly summary', 500, error.message);
  }
};

/**
 * GET /finance/collections — the money-in ledger.
 * Query: year, month, plotId, entryType, includeArchival, includeVoided, page, limit
 */
export const listCollections = async (req: ViewerRequest, res: Response): Promise<void> => {
  try {
    const now = currentBookPeriod();
    const year = req.query.year === 'all' ? undefined
      : req.query.year ? parseInt(String(req.query.year), 10) : now.bookYear;
    const month = req.query.month === 'all' ? undefined : parseMonthParam(req.query.month) ?? undefined;

    const isAdmin = !!req.viewer?.isAdmin;
    const result = await finance.listCollections({
      year,
      month,
      plotId: req.query.plotId ? String(req.query.plotId) : undefined,
      entryType: req.query.entryType === 'historical' ? 'historical'
        : req.query.entryType === 'live' ? 'live' : undefined,
      // Archival and voided rows are bookkeeping detail; residents only ever see
      // the live ledger.
      includeArchival: isAdmin && req.query.includeArchival === 'true',
      includeVoided: isAdmin && req.query.includeVoided === 'true',
      page: req.query.page ? parseInt(String(req.query.page), 10) : 1,
      limit: req.query.limit ? parseInt(String(req.query.limit), 10) : 25,
    });

    const items = isAdmin
      ? result.items
      : result.items.map(({ recordedBy, note, ...rest }: any) => rest);

    sendSuccess(res, items, 'Collections fetched', 200, {
      page: result.page,
      limit: result.limit,
      total: result.total,
      totalPages: result.totalPages,
    });
  } catch (error: any) {
    sendError(res, 'Failed to fetch collections', 500, error.message);
  }
};

// ── Recording money in (admin) ───────────────────────────────────────────────

/**
 * GET /finance/dues/:plotId — the plot's unpaid months oldest-first plus the
 * future months it can pay into. Drives the allocation editor.
 */
export const getPlotDues = async (req: Request, res: Response): Promise<void> => {
  try {
    const { plotId } = req.params;
    if (!Types.ObjectId.isValid(plotId)) {
      sendError(res, 'Invalid plot id', 400);
      return;
    }
    const fromYear = req.query.fromYear ? parseInt(String(req.query.fromYear), 10) : undefined;
    const ladder = await finance.getDuesLadder(plotId, { fromYear });
    const outstanding = ladder.arrears.reduce((sum, d) => sum + d.owed, 0);
    sendSuccess(res, { ...ladder, outstanding }, 'Dues fetched');
  } catch (error: any) {
    sendError(res, 'Failed to fetch dues', 500, error.message);
  }
};

/**
 * POST /finance/allocation-preview — what would this amount clear, without
 * writing anything. Body: { plotId, amount, receivedDate?, allocateFromYear? }
 */
export const previewAllocation = async (req: Request, res: Response): Promise<void> => {
  try {
    const { plotId, amount, receivedDate, allocateFromYear } = req.body || {};
    if (!Types.ObjectId.isValid(String(plotId))) {
      sendError(res, 'Invalid plot id', 400);
      return;
    }
    const value = Number(amount);
    if (!Number.isFinite(value) || value <= 0) {
      sendError(res, 'A valid amount greater than zero is required', 400);
      return;
    }

    const period = receivedDate ? toBookPeriod(new Date(receivedDate)) : currentBookPeriod();
    const allocations = await finance.autoAllocate(String(plotId), value, {
      fromYear: allocateFromYear ? Number(allocateFromYear) : undefined,
      throughOrdinal: period.bookYear * 12 + period.bookMonth,
    });
    const allocated = allocations.reduce((sum, a) => sum + a.amount, 0);

    sendSuccess(
      res,
      { allocations, allocated, unallocated: Math.max(0, value - allocated) },
      'Allocation preview'
    );
  } catch (error: any) {
    sendError(res, 'Failed to preview allocation', 500, error.message);
  }
};

/**
 * POST /finance/collections — record money received from a plot owner.
 *
 * Clears the dues months, writes the ledger entry, and issues a receipt in one
 * step. `entryType: 'historical'` records past years without touching the
 * current month's cash book.
 */
export const createCollection = async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const b = req.body || {};
    if (!b.plotId) {
      sendError(res, 'Please select a plot', 400);
      return;
    }

    const { collection, receipt } = await finance.recordCollection(
      {
        plotId: String(b.plotId),
        amount: Number(b.amount),
        method: b.method,
        receivedDate: b.receivedDate,
        allocations: Array.isArray(b.allocations) ? b.allocations : undefined,
        entryType: b.entryType === 'historical' ? 'historical' : 'live',
        note: b.note,
        generateReceipt: b.generateReceipt,
        language: b.language,
        societyName: b.societyName,
        allocateFromYear: b.allocateFromYear ? Number(b.allocateFromYear) : undefined,
      },
      req.admin?.id
    );

    if (req.admin) {
      await AuditLog.create({
        admin: req.admin.id,
        action: 'create',
        entity: 'collection',
        entityId: collection._id.toString(),
        changes: {
          plot: String(b.plotId),
          amount: collection.amount,
          entryType: collection.entryType,
          bookPeriod: `${collection.bookYear}-${collection.bookMonth}`,
          allocations: collection.allocations,
          receiptNumber: receipt?.receiptNumber || null,
        },
      });
    }

    sendSuccess(res, { collection, receipt }, 'Payment recorded', 201);
  } catch (error: any) {
    sendError(res, error.message || 'Failed to record payment', error.status || 500, error.message);
  }
};

/**
 * POST /finance/collections/:id/void — reverse a recorded payment: dues months
 * are credited back, the entry leaves every total, and its receipt is invalidated.
 */
export const voidCollectionEntry = async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const collection = await finance.voidCollection(req.params.id, req.admin?.id, req.body?.reason);
    if (!collection) {
      sendError(res, 'Collection not found', 404);
      return;
    }

    if (req.admin) {
      await AuditLog.create({
        admin: req.admin.id,
        action: 'void',
        entity: 'collection',
        entityId: collection._id.toString(),
        changes: { amount: collection.amount, reason: req.body?.reason || '' },
      });
    }

    sendSuccess(res, collection, 'Payment voided');
  } catch (error: any) {
    sendError(res, 'Failed to void payment', 500, error.message);
  }
};

// ── Expenses (admin write, resident read) ────────────────────────────────────

/**
 * GET /finance/expenses — expense rows for a period.
 * Query: year, month (or `all`), category, page, limit
 */
export const listExpenses = async (req: ViewerRequest, res: Response): Promise<void> => {
  try {
    const now = currentBookPeriod();
    const page = Math.max(1, parseInt(String(req.query.page || 1), 10));
    const limit = Math.min(200, Math.max(1, parseInt(String(req.query.limit || 50), 10)));

    const filter: any = { isVoided: false };
    if (req.query.year !== 'all') {
      const year = req.query.year ? parseInt(String(req.query.year), 10) : now.bookYear;
      const month = req.query.month === 'all' ? null : parseMonthParam(req.query.month) ?? now.bookMonth;
      filter.bookYear = year;
      if (month) filter.bookMonth = month;
    }
    if (req.query.category && Types.ObjectId.isValid(String(req.query.category))) {
      filter.category = req.query.category;
    }

    const [items, total] = await Promise.all([
      Expense.find(filter)
        .sort({ expenseDate: -1, createdAt: -1 })
        .skip((page - 1) * limit)
        .limit(limit)
        .populate('recordedBy', 'name email')
        .lean(),
      Expense.countDocuments(filter),
    ]);

    const payload = req.viewer?.isAdmin ? items : items.map(forResident);
    sendSuccess(res, payload, 'Expenses fetched', 200, {
      page,
      limit,
      total,
      totalPages: Math.ceil(total / limit),
    });
  } catch (error: any) {
    sendError(res, 'Failed to fetch expenses', 500, error.message);
  }
};

/**
 * POST /finance/expenses — record money paid out.
 * Body: { title, amount, category?, expenseDate?, paidTo?, method?, note?, attachmentUrl? }
 */
export const createExpense = async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const b = req.body || {};
    const title = String(b.title || '').trim();
    const amount = Number(b.amount);

    if (!title) {
      sendError(res, 'A title is required', 400);
      return;
    }
    if (!Number.isFinite(amount) || amount <= 0) {
      sendError(res, 'A valid amount greater than zero is required', 400);
      return;
    }

    const expenseDate = b.expenseDate ? new Date(b.expenseDate) : new Date();
    if (isNaN(expenseDate.getTime())) {
      sendError(res, 'Invalid expense date', 400);
      return;
    }

    // Snapshot the category name so renaming a heading never rewrites history.
    let category = null;
    let categoryName = String(b.categoryName || '').trim();
    if (b.category && Types.ObjectId.isValid(String(b.category))) {
      const doc = await ExpenseCategory.findById(b.category).lean();
      if (doc) {
        category = doc._id;
        categoryName = doc.name;
      }
    }

    const expense = await Expense.create({
      title,
      category,
      categoryName,
      amount,
      expenseDate,
      paidTo: b.paidTo || '',
      method: b.method || 'cash',
      note: b.note || '',
      attachmentUrl: b.attachmentUrl || '',
      recordedBy: req.admin?.id || null,
    });

    if (req.admin) {
      await AuditLog.create({
        admin: req.admin.id,
        action: 'create',
        entity: 'expense',
        entityId: expense._id.toString(),
        changes: { title, amount, categoryName, bookPeriod: `${expense.bookYear}-${expense.bookMonth}` },
      });
    }

    sendSuccess(res, expense, 'Expense recorded', 201);
  } catch (error: any) {
    sendError(res, 'Failed to record expense', 500, error.message);
  }
};

/** PUT /finance/expenses/:id — edit an expense (the book period follows the date). */
export const updateExpense = async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const expense = await Expense.findById(req.params.id);
    if (!expense) {
      sendError(res, 'Expense not found', 404);
      return;
    }

    const b = req.body || {};
    if (b.title !== undefined) expense.title = String(b.title).trim();
    if (b.amount !== undefined) {
      const amount = Number(b.amount);
      if (!Number.isFinite(amount) || amount <= 0) {
        sendError(res, 'A valid amount greater than zero is required', 400);
        return;
      }
      expense.amount = amount;
    }
    if (b.expenseDate !== undefined) {
      const date = new Date(b.expenseDate);
      if (isNaN(date.getTime())) {
        sendError(res, 'Invalid expense date', 400);
        return;
      }
      expense.expenseDate = date;
    }
    if (b.category !== undefined) {
      if (b.category && Types.ObjectId.isValid(String(b.category))) {
        const doc = await ExpenseCategory.findById(b.category).lean();
        if (doc) {
          expense.category = doc._id as any;
          expense.categoryName = doc.name;
        }
      } else {
        expense.category = null;
        expense.categoryName = String(b.categoryName || '').trim();
      }
    }
    if (b.paidTo !== undefined) expense.paidTo = String(b.paidTo);
    if (b.method !== undefined) expense.method = b.method;
    if (b.note !== undefined) expense.note = String(b.note);
    if (b.attachmentUrl !== undefined) expense.attachmentUrl = String(b.attachmentUrl);

    await expense.save();

    if (req.admin) {
      await AuditLog.create({
        admin: req.admin.id,
        action: 'update',
        entity: 'expense',
        entityId: expense._id.toString(),
        changes: req.body,
      });
    }

    sendSuccess(res, expense, 'Expense updated');
  } catch (error: any) {
    sendError(res, 'Failed to update expense', 500, error.message);
  }
};

/**
 * POST /finance/expenses/:id/void — remove an expense from the books while
 * keeping the row, so a month residents have already seen can be corrected
 * without the record disappearing.
 */
export const voidExpense = async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const expense = await Expense.findById(req.params.id);
    if (!expense) {
      sendError(res, 'Expense not found', 404);
      return;
    }
    if (!expense.isVoided) {
      expense.isVoided = true;
      expense.voidedAt = new Date();
      expense.voidedBy = req.admin?.id ? new Types.ObjectId(req.admin.id) : null;
      expense.voidReason = req.body?.reason || '';
      await expense.save();
    }

    if (req.admin) {
      await AuditLog.create({
        admin: req.admin.id,
        action: 'void',
        entity: 'expense',
        entityId: expense._id.toString(),
        changes: { amount: expense.amount, reason: req.body?.reason || '' },
      });
    }

    sendSuccess(res, expense, 'Expense voided');
  } catch (error: any) {
    sendError(res, 'Failed to void expense', 500, error.message);
  }
};

/**
 * POST /finance/expenses/copy-month — duplicate a month's expenses into another
 * month. Body: { fromYear, fromMonth, toYear, toMonth }
 *
 * Recurring costs (salaries, fuel) barely change month to month; this saves
 * re-typing them every time.
 */
export const copyMonthExpenses = async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const b = req.body || {};
    const fromYear = parseInt(String(b.fromYear), 10);
    const toYear = parseInt(String(b.toYear), 10);
    const fromMonth = parseMonthParam(b.fromMonth);
    const toMonth = parseMonthParam(b.toMonth);

    if (!Number.isInteger(fromYear) || !Number.isInteger(toYear) || !fromMonth || !toMonth) {
      sendError(res, 'fromYear, fromMonth, toYear and toMonth are required', 400);
      return;
    }
    if (fromYear === toYear && fromMonth === toMonth) {
      sendError(res, 'Source and target month are the same', 400);
      return;
    }

    const source = await Expense.find({ bookYear: fromYear, bookMonth: fromMonth, isVoided: false }).lean();
    if (source.length === 0) {
      sendError(res, 'No expenses to copy from that month', 404);
      return;
    }

    // Skip anything the target month already has. Without this, a second click
    // (or a double-tap) silently doubles the month's expenditure, and the
    // duplicate is easy to miss because both rows look legitimate.
    const existing = await Expense.find({ bookYear: toYear, bookMonth: toMonth, isVoided: false })
      .select('title amount')
      .lean();
    const alreadyThere = new Set(existing.map((e) => `${e.title.trim().toLowerCase()}|${e.amount}`));

    const pending = source.filter(
      (e) => !alreadyThere.has(`${e.title.trim().toLowerCase()}|${e.amount}`),
    );
    const skipped = source.length - pending.length;

    if (pending.length === 0) {
      sendError(res, 'Those expenses are already recorded in that month', 409);
      return;
    }

    // Land each copy on the same day-of-month where possible; day 28 is the
    // safest clamp so February never rolls into March.
    const created = await Expense.insertMany(
      pending.map((e) => {
        const day = Math.min(new Date(e.expenseDate).getUTCDate(), 28);
        return {
          title: e.title,
          category: e.category,
          categoryName: e.categoryName,
          amount: e.amount,
          expenseDate: new Date(Date.UTC(toYear, toMonth - 1, day, 12, 0, 0)),
          paidTo: e.paidTo,
          method: e.method,
          note: e.note,
          recordedBy: req.admin?.id || null,
        };
      })
    );

    if (req.admin) {
      await AuditLog.create({
        admin: req.admin.id,
        action: 'create',
        entity: 'expense',
        entityId: `copy_${fromYear}-${fromMonth}_to_${toYear}-${toMonth}`,
        changes: { count: created.length, skipped },
      });
    }

    sendSuccess(
      res,
      created,
      skipped > 0
        ? `${created.length} expenses copied, ${skipped} already present`
        : `${created.length} expenses copied`,
      201,
    );
  } catch (error: any) {
    sendError(res, 'Failed to copy expenses', 500, error.message);
  }
};

// ── Categories ───────────────────────────────────────────────────────────────

/** GET /finance/categories — spending headings (seeded on first call). */
export const listCategories = async (_req: Request, res: Response): Promise<void> => {
  try {
    sendSuccess(res, await finance.ensureCategories(), 'Categories fetched');
  } catch (error: any) {
    sendError(res, 'Failed to fetch categories', 500, error.message);
  }
};

/** POST /finance/categories — add a spending heading. */
export const createCategory = async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const name = String(req.body?.name || '').trim();
    if (!name) {
      sendError(res, 'A category name is required', 400);
      return;
    }

    const category = await ExpenseCategory.create({
      name,
      nameUr: String(req.body?.nameUr || '').trim(),
      monthlyBudget: req.body?.monthlyBudget === undefined || req.body.monthlyBudget === null
        ? null
        : Number(req.body.monthlyBudget),
      sortOrder: req.body?.sortOrder === undefined ? 100 : Number(req.body.sortOrder),
    });

    sendSuccess(res, category, 'Category created', 201);
  } catch (error: any) {
    if (error?.code === 11000) {
      sendError(res, 'That category already exists', 409);
      return;
    }
    sendError(res, 'Failed to create category', 500, error.message);
  }
};

/**
 * PUT /finance/categories/:id — rename a heading, set its budget, or retire it
 * with `isActive: false`. Headings are never deleted because historic expenses
 * still point at them.
 */
export const updateCategory = async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const update: any = {};
    if (req.body?.name !== undefined) update.name = String(req.body.name).trim();
    if (req.body?.nameUr !== undefined) update.nameUr = String(req.body.nameUr).trim();
    if (req.body?.isActive !== undefined) update.isActive = !!req.body.isActive;
    if (req.body?.sortOrder !== undefined) update.sortOrder = Number(req.body.sortOrder);
    if (req.body?.monthlyBudget !== undefined) {
      update.monthlyBudget = req.body.monthlyBudget === null ? null : Number(req.body.monthlyBudget);
    }

    const category = await ExpenseCategory.findByIdAndUpdate(req.params.id, update, { new: true });
    if (!category) {
      sendError(res, 'Category not found', 404);
      return;
    }
    sendSuccess(res, category, 'Category updated');
  } catch (error: any) {
    if (error?.code === 11000) {
      sendError(res, 'That category name is already in use', 409);
      return;
    }
    sendError(res, 'Failed to update category', 500, error.message);
  }
};

// ── Settings ─────────────────────────────────────────────────────────────────

/** GET /finance/settings — opening balance and the date it is stated at. */
export const getFinanceSettings = async (_req: Request, res: Response): Promise<void> => {
  try {
    const settings = await finance.getSettings();
    sendSuccess(res, settings, 'Finance settings fetched');
  } catch (error: any) {
    sendError(res, 'Failed to fetch finance settings', 500, error.message);
  }
};

/**
 * PUT /finance/settings — set the opening balance: the cash that carried forward
 * from before the system started tracking, since backfilled historical records
 * deliberately never count as income.
 */
export const updateFinanceSettings = async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const update: any = { updatedBy: req.admin?.id || null };

    if (req.body?.openingBalance !== undefined) {
      const value = Number(req.body.openingBalance);
      if (!Number.isFinite(value)) {
        sendError(res, 'openingBalance must be a number', 400);
        return;
      }
      update.openingBalance = value;
    }
    if (req.body?.openingAsOf !== undefined) {
      const date = new Date(req.body.openingAsOf);
      if (isNaN(date.getTime())) {
        sendError(res, 'Invalid openingAsOf date', 400);
        return;
      }
      update.openingAsOf = date;
    }
    if (req.body?.note !== undefined) update.note = String(req.body.note);

    const settings = await FinanceSettings.findOneAndUpdate(
      { key: 'default' },
      { $set: update, $setOnInsert: { key: 'default' } },
      { new: true, upsert: true }
    );

    if (req.admin) {
      await AuditLog.create({
        admin: req.admin.id,
        action: 'update',
        entity: 'financeSettings',
        entityId: settings._id.toString(),
        changes: update,
      });
    }

    sendSuccess(res, settings, 'Finance settings updated');
  } catch (error: any) {
    sendError(res, 'Failed to update finance settings', 500, error.message);
  }
};

/**
 * GET /finance/plot/:plotId/ledger — every payment recorded against one plot,
 * newest first. Used by the plot detail page on both apps.
 */
export const getPlotLedger = async (req: ViewerRequest, res: Response): Promise<void> => {
  try {
    const { plotId } = req.params;
    if (!Types.ObjectId.isValid(plotId)) {
      sendError(res, 'Invalid plot id', 400);
      return;
    }

    const filter: any = { plot: plotId, isVoided: false };
    const items = await Collection.find(filter)
      .sort({ receivedDate: -1 })
      .limit(200)
      .populate('receiptRef', 'receiptNumber filePath')
      .lean();

    const payload = req.viewer?.isAdmin
      ? items
      : items.map(({ recordedBy, note, ...rest }: any) => rest);

    sendSuccess(res, payload, 'Plot ledger fetched');
  } catch (error: any) {
    sendError(res, 'Failed to fetch plot ledger', 500, error.message);
  }
};
