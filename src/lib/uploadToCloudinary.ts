/**
 * uploadToCloudinary.ts
 * ================================
 * Upload a buffer or a file on disk (e.g. a freshly generated PDF in
 * os.tmpdir()) to Cloudinary as a `raw` resource under the given key, and
 * return its public delivery URL.
 */

import fs from "fs";
import type { UploadApiResponse } from "cloudinary";
import {
  cloudinary,
  RESOURCE_TYPE,
  THUMBNAIL_RESOURCE_TYPE,
  isCloudinaryConfigured,
  withFolder,
} from "./cloudinary";

export interface UploadOptions {
  /** Ignored for raw resources (kept for call-site compatibility). */
  contentType?: string;
}

/**
 * Upload `source` (a Buffer or an absolute path to a temp file) to Cloudinary
 * at `key` (used as the public_id, extension included) and return the secure
 * delivery URL.
 *
 * @param key  Destination key, e.g. "notices/2025/A-12.pdf".
 */
export async function uploadToCloudinary(
  source: Buffer | string,
  key: string,
  _opts: UploadOptions = {},
): Promise<string> {
  if (!isCloudinaryConfigured()) {
    throw new Error(
      "Cloudinary is not configured. Set CLOUDINARY_CLOUD_NAME, " +
        "CLOUDINARY_API_KEY and CLOUDINARY_API_SECRET in your environment.",
    );
  }

  const publicId = withFolder(key);
  const options = {
    resource_type: RESOURCE_TYPE,
    public_id: publicId, // keep the full path + .pdf extension verbatim
    use_filename: false,
    unique_filename: false,
    overwrite: true,
  } as const;

  const result: UploadApiResponse = await new Promise((resolve, reject) => {
    if (Buffer.isBuffer(source)) {
      const stream = cloudinary.uploader.upload_stream(options, (err, res) => {
        if (err || !res) return reject(err || new Error("Cloudinary upload failed"));
        resolve(res);
      });
      stream.end(source);
    } else {
      // Path on disk — let the SDK read it directly.
      const buf = fs.readFileSync(source);
      const stream = cloudinary.uploader.upload_stream(options, (err, res) => {
        if (err || !res) return reject(err || new Error("Cloudinary upload failed"));
        resolve(res);
      });
      stream.end(buf);
    }
  });

  // Best-effort second copy so link previews can show page 1. Never allowed to
  // fail the caller: a missing thumbnail degrades the preview card, whereas a
  // thrown error here would lose the notice/receipt the admin just generated.
  void uploadPdfThumbnailSource(source, publicId);

  return result.secure_url;
}

/**
 * Upload the same PDF bytes again as an `image` resource under the identical
 * public_id, which is what lets Cloudinary rasterise page 1 for `og:image`
 * (see THUMBNAIL_RESOURCE_TYPE for why a second copy is required).
 *
 * Resolves to true on success. Swallows every error by design — the caller
 * treats the thumbnail as optional.
 */
export async function uploadPdfThumbnailSource(
  source: Buffer | string,
  publicId: string,
): Promise<boolean> {
  if (!isCloudinaryConfigured()) return false;

  try {
    const buf = Buffer.isBuffer(source) ? source : fs.readFileSync(source);
    await new Promise<void>((resolve, reject) => {
      const stream = cloudinary.uploader.upload_stream(
        {
          resource_type: THUMBNAIL_RESOURCE_TYPE,
          public_id: publicId,
          use_filename: false,
          unique_filename: false,
          overwrite: true,
        },
        (err, res) => (err || !res ? reject(err || new Error("thumbnail upload failed")) : resolve()),
      );
      stream.end(buf);
    });
    return true;
  } catch (err) {
    console.warn(
      `Thumbnail source upload failed for ${publicId} — link previews will use the ` +
        `placeholder image. ${err instanceof Error ? err.message : err}`,
    );
    return false;
  }
}

export default uploadToCloudinary;
