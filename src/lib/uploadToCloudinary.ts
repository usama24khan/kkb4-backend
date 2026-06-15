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

  return result.secure_url;
}

export default uploadToCloudinary;
