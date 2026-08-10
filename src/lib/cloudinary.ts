/**
 * cloudinary.ts
 * ================================
 * Cloudinary client shared by the upload/download/delete helpers. PDFs are
 * stored as `raw` resources (delivered byte-for-byte, no image processing) and
 * their `public_id` keeps the `.pdf` extension so the delivery URL ends in
 * `.pdf`.
 *
 * Required env vars (see .env.example):
 *   CLOUDINARY_CLOUD_NAME, CLOUDINARY_API_KEY, CLOUDINARY_API_SECRET
 *   CLOUDINARY_FOLDER (optional)
 */

import { v2 as cloudinary } from "cloudinary";
import { env } from "../config/env";

cloudinary.config({
  cloud_name: env.CLOUDINARY_CLOUD_NAME,
  api_key: env.CLOUDINARY_API_KEY,
  api_secret: env.CLOUDINARY_API_SECRET,
  secure: true,
});

/** Resource type used for all PDF uploads (byte-for-byte delivery). */
export const RESOURCE_TYPE = "raw" as const;

/**
 * Resource type used for the *thumbnail source* copy of each PDF.
 *
 * Cloudinary keeps `raw` and `image` assets in separate namespaces and will only
 * apply image transformations to the latter: requesting
 * `/image/upload/<raw public_id>.jpg` answers `Resource not found`. So each PDF
 * is uploaded a second time under the same public_id as an `image`, purely so
 * Cloudinary can rasterise page 1 for link previews. The raw copy stays the one
 * we deliver and delete.
 */
export const THUMBNAIL_RESOURCE_TYPE = "image" as const;

/**
 * Open Graph preview dimensions. 1200x630 is the standard card size; cropping to
 * the top of a portrait page keeps the letterhead in frame, which is the part
 * that makes the document recognisable at thumbnail size.
 */
const OG_THUMBNAIL_TRANSFORM = "pg_1,w_1200,h_630,c_fill,g_north,q_auto";

/**
 * Build the Open Graph thumbnail URL for a PDF that has an `image`-type copy.
 * Returns "" when Cloudinary isn't configured or the id can't be resolved, so
 * callers can fall back to a static placeholder rather than emitting a broken
 * og:image.
 */
export function buildPdfThumbnailUrl(pdfUrlOrPublicId: string): string {
  if (!pdfUrlOrPublicId || !env.CLOUDINARY_CLOUD_NAME) return "";

  // Only Cloudinary-hosted PDFs have a thumbnail source; legacy local paths
  // (pre-migration notices) do not.
  if (/^https?:\/\//i.test(pdfUrlOrPublicId) && !pdfUrlOrPublicId.includes("res.cloudinary.com")) {
    return "";
  }
  if (pdfUrlOrPublicId.startsWith("/")) return "";

  const publicId = publicIdFromUrl(pdfUrlOrPublicId);
  if (!publicId) return "";

  // The output format is expressed by APPENDING `.jpg` to the public_id, which
  // itself ends in `.pdf`:
  //   .../image/upload/<transform>/notices/2026/notice_56.pdf.jpg
  // Using `f_jpg` with a bare `.pdf` instead does NOT work — Cloudinary reads the
  // trailing `.pdf` as the requested format and then looks for an extension-less
  // public_id that does not exist ("Resource not found - notices/2026/notice_56").
  return (
    `https://res.cloudinary.com/${env.CLOUDINARY_CLOUD_NAME}` +
    `/${THUMBNAIL_RESOURCE_TYPE}/upload/${OG_THUMBNAIL_TRANSFORM}/${publicId}.jpg`
  );
}

/**
 * True when the credentials needed to talk to Cloudinary are present. Used by
 * the generators to fail with a clear message instead of an obscure SDK error.
 */
export function isCloudinaryConfigured(): boolean {
  return Boolean(
    env.CLOUDINARY_CLOUD_NAME &&
      env.CLOUDINARY_API_KEY &&
      env.CLOUDINARY_API_SECRET,
  );
}

/**
 * Prefix a storage key with the optional CLOUDINARY_FOLDER.
 *   key "notices/2025/A-12.pdf" + folder "kkb4" → "kkb4/notices/2025/A-12.pdf"
 */
export function withFolder(key: string): string {
  const clean = key.replace(/^\/+/, "");
  const folder = env.CLOUDINARY_FOLDER.replace(/^\/+|\/+$/g, "");
  return folder ? `${folder}/${clean}` : clean;
}

/**
 * Recover the `raw` public_id from a Cloudinary delivery URL so the object can
 * be deleted. Accepts a full URL or an already-bare public_id.
 *
 *   https://res.cloudinary.com/<cloud>/raw/upload/v123/kkb4/notices/x.pdf
 *     → "kkb4/notices/x.pdf"
 */
export function publicIdFromUrl(urlOrId: string): string {
  if (!urlOrId) return "";
  if (!/^https?:\/\//i.test(urlOrId)) return urlOrId.replace(/^\/+/, "");

  try {
    const { pathname } = new URL(urlOrId);
    // .../<resource_type>/<type>/[v<version>/]<public_id>
    const marker = "/upload/";
    const idx = pathname.indexOf(marker);
    if (idx === -1) return "";
    let rest = pathname.slice(idx + marker.length);
    rest = rest.replace(/^v\d+\//, ""); // strip version segment
    return decodeURIComponent(rest);
  } catch {
    return "";
  }
}

export { cloudinary };
