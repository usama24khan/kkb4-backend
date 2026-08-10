import { Request, Response } from 'express';
import Receipt from '../models/Receipt';
import Notice from '../models/Notice';
import Plot from '../models/Plot';
import { sendSuccess, sendError } from '../utils/responseHelper';
import { buildPdfThumbnailUrl } from '../lib/cloudinary';
import { MONTH_NAMES } from '../config/constants';

/**
 * Public metadata for a notice or receipt, used by the resident-facing landing
 * page that WhatsApp scrapes for its link preview.
 *
 * PUBLIC BY NECESSITY: WhatsApp's crawler sends no cookies, and the resident
 * opens the link without logging in. Access is therefore capability-based — you
 * need the document's ObjectId, which is unguessable — exactly like the existing
 * public PDF download routes (`/notices/download/:fileName`, `/notices/:id/download`).
 *
 * Only what a preview card and viewer need is returned. Owner phone numbers and
 * CNICs are deliberately never included.
 */

export type DocumentKind = 'receipt' | 'notice';

interface PublicDocument {
  kind: DocumentKind;
  id: string;
  title: string;
  subtitle: string;
  /** Raw PDF URL, for the embedded viewer and the download link. */
  pdfUrl: string;
  /** Cloudinary page-1 thumbnail, or '' when unavailable (page falls back). */
  thumbnailUrl: string;
  /** False for pre-migration notices stored as local filesystem paths. */
  pdfAvailable: boolean;
  language: 'en' | 'ur';
  createdAt: string;
}

const isDeliverable = (path?: string | null): boolean =>
  !!path && /^https?:\/\//i.test(path);

async function buildReceipt(id: string): Promise<PublicDocument | null> {
  const receipt = await Receipt.findById(id)
    .select('receiptNumber year month ownerName blockNo plotNo amount language filePath createdAt')
    .lean();
  if (!receipt) return null;

  const period = [receipt.month, receipt.year].filter(Boolean).join(' ');
  const plot = [receipt.plotNo, receipt.blockNo].filter(Boolean).join(' ');

  return {
    kind: 'receipt',
    id: String(receipt._id),
    title: `Receipt ${receipt.receiptNumber || ''}`.trim(),
    subtitle: [receipt.ownerName, plot && `Plot ${plot}`, period]
      .filter(Boolean)
      .join(' · '),
    pdfUrl: isDeliverable(receipt.filePath) ? (receipt.filePath as string) : '',
    thumbnailUrl: buildPdfThumbnailUrl(receipt.filePath || ''),
    pdfAvailable: isDeliverable(receipt.filePath),
    language: receipt.language === 'ur' ? 'ur' : 'en',
    createdAt: new Date(receipt.createdAt).toISOString(),
  };
}

async function buildNotice(id: string): Promise<PublicDocument | null> {
  const notice = await Notice.findById(id)
    .select('type targetId targetLabel year yearFrom yearTo language totalDue pdfPath createdAt monthFrom monthTo')
    .lean();
  if (!notice) return null;

  // Resolve the owner for single-plot notices so the card names a person, and
  // pick up plotBlock as a readable label — pre-migration notices have no
  // targetLabel, and falling back to targetId would print a raw ObjectId.
  let ownerName = '';
  let resolvedLabel = '';
  if (notice.type === 'plot') {
    const ids = String(notice.targetId).split(',').map((s) => s.trim()).filter(Boolean);
    if (ids.length === 1 && /^[a-f\d]{24}$/i.test(ids[0])) {
      const plot = await Plot.findById(ids[0]).select('ownerName plotBlock').lean();
      ownerName = plot?.ownerName || '';
      resolvedLabel = plot?.plotBlock || '';
    }
  }

  const years =
    notice.yearFrom && notice.yearTo && notice.yearFrom !== notice.yearTo
      ? `${notice.yearFrom}–${notice.yearTo}`
      : String(notice.yearTo || notice.year || '');

  const rawTarget = notice.targetLabel || resolvedLabel || notice.targetId || '';
  // Never surface a bare ObjectId on a page residents see.
  const target = /^[a-f\d]{24}$/i.test(String(rawTarget)) ? '' : rawTarget;
  const scope =
    notice.type === 'block' ? `Block ${target}` :
    notice.type === 'phase' ? String(target) :
    target ? `Plot ${target}` : '';

  return {
    kind: 'notice',
    id: String(notice._id),
    title: `Maintenance Notice${years ? ` ${years}` : ''}`,
    subtitle: [ownerName, scope, notice.monthFrom ? MONTH_NAMES[notice.monthFrom] : '']
      .filter(Boolean)
      .join(' · '),
    pdfUrl: isDeliverable(notice.pdfPath) ? notice.pdfPath : '',
    thumbnailUrl: buildPdfThumbnailUrl(notice.pdfPath || ''),
    pdfAvailable: isDeliverable(notice.pdfPath),
    language: notice.language === 'ur' ? 'ur' : 'en',
    createdAt: new Date(notice.createdAt).toISOString(),
  };
}

/**
 * Look up a document's public metadata, or null when the kind/id is invalid or
 * no such document exists. Shared by the JSON endpoint and the HTML landing page.
 */
export async function getPublicDocumentData(
  kindRaw: string,
  id: string,
): Promise<PublicDocument | null> {
  const kind = String(kindRaw || '').toLowerCase();
  if (kind !== 'receipt' && kind !== 'notice') return null;
  // Reject anything that isn't an ObjectId before hitting the database.
  if (!/^[a-f\d]{24}$/i.test(id)) return null;
  return kind === 'receipt' ? buildReceipt(id) : buildNotice(id);
}

/**
 * GET /public/documents/:kind/:id — Metadata for the shareable landing page.
 */
export const getPublicDocument = async (req: Request, res: Response): Promise<void> => {
  try {
    const kind = String(req.params.kind || '').toLowerCase();
    const id = String(req.params.id || '');

    if (kind !== 'receipt' && kind !== 'notice') {
      sendError(res, 'Unknown document type', 404);
      return;
    }

    const doc = await getPublicDocumentData(kind, id);
    if (!doc) {
      sendError(res, 'Document not found', 404);
      return;
    }

    // Short public cache: link previews get scraped repeatedly, and these
    // documents don't change after generation.
    res.set('Cache-Control', 'public, max-age=300');
    sendSuccess(res, doc, 'Document fetched');
  } catch (error: any) {
    sendError(res, 'Failed to fetch document', 500, error.message);
  }
};
