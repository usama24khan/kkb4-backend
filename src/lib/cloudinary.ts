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

/** Resource type used for all PDF uploads. */
export const RESOURCE_TYPE = "raw" as const;

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
