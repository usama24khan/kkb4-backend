import { Request, Response } from 'express';
import { getPublicDocumentData } from './publicDocument.controller';

/**
 * Server-rendered landing page for a notice or receipt — the URL we put in
 * WhatsApp messages.
 *
 * WHY THIS LIVES ON THE BACKEND rather than in the Next.js portal:
 * link-preview crawlers arrive with no cookies, and Vercel's Deployment
 * Protection answers cookie-less requests to a protected deployment with a 302
 * to its SSO page. On a protected preview deployment the crawler therefore
 * previews Vercel's login screen instead of the document — measured as
 * `302` for the portal versus `200` for this backend, which is public in every
 * environment. Serving the page here means previews work identically on preview
 * and production, so testing on preview is a valid proof of production.
 *
 * Plain string templating, no view engine: the whole page is a handful of tags
 * and adding a template dependency for it would be heavier than the page itself.
 */

const SITE_NAME = 'KKB4 Housing Society';

/**
 * Fallback og:image. Hosted on the production portal, which is public in every
 * environment, so the card still renders when a document has no thumbnail.
 */
const PLACEHOLDER_IMAGE = 'https://frontend-user-kappa.vercel.app/icons/icon-512.png';

/** Escape text for interpolation into HTML/attributes. */
const esc = (v: unknown): string =>
  String(v ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');

/** Absolute URL of this request, used for og:url. */
function selfUrl(req: Request): string {
  const proto = (req.headers['x-forwarded-proto'] as string) || req.protocol || 'https';
  const host = (req.headers['x-forwarded-host'] as string) || req.headers.host || '';
  return `${proto}://${host}${req.originalUrl.split('?')[0]}`;
}

const STYLES = `
  *{box-sizing:border-box}
  body{margin:0;background:#f4f6f9;color:#0f172a;
    font-family:'Plus Jakarta Sans',-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif}
  .wrap{max-width:900px;margin:0 auto;padding:20px 16px 40px}
  .head{display:flex;align-items:center;gap:13px;background:#fff;
    border:1px solid rgba(0,0,0,.07);border-radius:14px;padding:16px 18px;margin-bottom:14px;
    box-shadow:0 1px 2px rgba(15,23,42,.04)}
  .logo{width:44px;height:44px;border-radius:12px;object-fit:contain;flex-shrink:0}
  .eyebrow{font-size:10.5px;font-weight:700;letter-spacing:.11em;text-transform:uppercase;
    color:#059669;margin:0 0 3px}
  h1{font-size:18px;font-weight:700;margin:0;letter-spacing:-.2px}
  .sub{font-size:12.5px;color:#64748b;margin:3px 0 0;font-weight:500}
  .card{background:#fff;border:1px solid rgba(0,0,0,.07);border-radius:14px;
    box-shadow:0 1px 2px rgba(15,23,42,.04);overflow:hidden}
  iframe{display:block;width:100%;height:78vh;min-height:420px;border:none;background:#f8fafc}
  @media(max-width:640px){iframe{height:68vh;min-height:340px}}
  .actions{display:flex;gap:10px;flex-wrap:wrap;margin-top:14px}
  .btn{display:inline-flex;align-items:center;justify-content:center;height:44px;padding:0 20px;
    border-radius:12px;font-size:14px;font-weight:700;text-decoration:none}
  .primary{background:linear-gradient(135deg,#10b981,#059669);color:#fff;flex:1 1 200px;
    box-shadow:0 4px 12px rgba(5,150,105,.25)}
  .ghost{background:#fff;color:#334155;border:1.5px solid #e2e8f0}
  .note{font-size:11.5px;color:#94a3b8;margin:10px 2px 0;text-align:center}
  .empty{padding:44px 24px;text-align:center}
  .empty h2{font-size:16px;font-weight:700;margin:0 0 7px}
  .empty p{font-size:13.5px;color:#64748b;margin:0;line-height:1.6;max-width:420px;
    margin-left:auto;margin-right:auto}
`;

interface PageContent {
  title: string;
  description: string;
  image: string;
  body: string;
}

function renderHtml(pageUrl: string, c: PageContent): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(c.title)} — ${esc(SITE_NAME)}</title>
<meta name="description" content="${esc(c.description)}">
<meta property="og:type" content="article">
<meta property="og:site_name" content="${esc(SITE_NAME)}">
<meta property="og:title" content="${esc(c.title)}">
<meta property="og:description" content="${esc(c.description)}">
<meta property="og:url" content="${esc(pageUrl)}">
<meta property="og:image" content="${esc(c.image)}">
<meta property="og:image:width" content="1200">
<meta property="og:image:height" content="630">
<meta property="og:image:alt" content="${esc(c.title)}">
<meta name="twitter:card" content="summary_large_image">
<meta name="twitter:title" content="${esc(c.title)}">
<meta name="twitter:description" content="${esc(c.description)}">
<meta name="twitter:image" content="${esc(c.image)}">
<link rel="icon" href="${esc(PLACEHOLDER_IMAGE)}">
<style>${STYLES}</style>
</head>
<body>
<div class="wrap">
  <div class="head">
    <img class="logo" src="${esc(PLACEHOLDER_IMAGE)}" alt="">
    <div>
      <p class="eyebrow">${esc(SITE_NAME)}</p>
      <h1>${esc(c.title)}</h1>
      ${c.description ? `<p class="sub">${esc(c.description)}</p>` : ''}
    </div>
  </div>
  ${c.body}
</div>
</body>
</html>`;
}

/**
 * GET /view/:kind/:id — the shareable page. Always answers 200 with valid Open
 * Graph tags, even when the document is missing: a crawler that receives an
 * error page renders a broken card, and the resident sees a dead link.
 */
export const renderDocumentPage = async (req: Request, res: Response): Promise<void> => {
  const pageUrl = selfUrl(req);

  try {
    const doc = await getPublicDocumentData(
      String(req.params.kind || ''),
      String(req.params.id || ''),
    );

    res.set('Content-Type', 'text/html; charset=utf-8');
    // Crawlers refetch these repeatedly; documents never change once generated.
    res.set('Cache-Control', 'public, max-age=300');

    if (!doc) {
      res.status(200).send(
        renderHtml(pageUrl, {
          title: 'Document unavailable',
          description: 'This document could not be found.',
          image: PLACEHOLDER_IMAGE,
          body: `<div class="card empty">
            <h2>We couldn&rsquo;t find this document</h2>
            <p>The link may be incorrect or the document may have been removed.
               Please contact the society office.</p>
          </div>`,
        }),
      );
      return;
    }

    if (!doc.pdfAvailable) {
      res.status(200).send(
        renderHtml(pageUrl, {
          title: doc.title,
          description: doc.subtitle,
          image: doc.thumbnailUrl || PLACEHOLDER_IMAGE,
          body: `<div class="card empty">
            <h2>This document isn&rsquo;t available online</h2>
            <p>It was issued before documents were stored online.
               Please contact the society office for a copy.</p>
          </div>`,
        }),
      );
      return;
    }

    const pdf = esc(doc.pdfUrl);
    res.status(200).send(
      renderHtml(pageUrl, {
        title: doc.title,
        description: doc.subtitle,
        image: doc.thumbnailUrl || PLACEHOLDER_IMAGE,
        body: `<div class="card">
            <iframe src="${pdf}" title="${esc(doc.title)}" loading="lazy"></iframe>
          </div>
          <div class="actions">
            <a class="btn primary" href="${pdf}" target="_blank" rel="noopener noreferrer">Open PDF</a>
            <a class="btn ghost" href="${pdf}" download>Download</a>
          </div>
          <p class="note">If the document doesn&rsquo;t appear above, tap &ldquo;Open PDF&rdquo;.</p>`,
      }),
    );
  } catch {
    // Even a server-side failure returns a valid, previewable page.
    res.set('Content-Type', 'text/html; charset=utf-8');
    res.status(200).send(
      renderHtml(pageUrl, {
        title: 'Document unavailable',
        description: 'This document could not be loaded.',
        image: PLACEHOLDER_IMAGE,
        body: `<div class="card empty">
          <h2>Something went wrong</h2>
          <p>Please try again in a moment, or contact the society office.</p>
        </div>`,
      }),
    );
  }
};
