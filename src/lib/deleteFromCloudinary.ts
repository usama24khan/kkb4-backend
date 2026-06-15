/**
 * deleteFromCloudinary.ts
 * ================================
 * Delete a `raw` PDF from Cloudinary by its public_id (or its delivery URL).
 */

import {
  cloudinary,
  RESOURCE_TYPE,
  isCloudinaryConfigured,
  publicIdFromUrl,
} from "./cloudinary";

/**
 * Delete the object identified by `urlOrId`. Accepts a full Cloudinary URL or a
 * bare public_id. Deleting a missing object is a no-op (Cloudinary returns
 * "not found" rather than throwing for destroy).
 */
export async function deleteFromCloudinary(urlOrId: string): Promise<void> {
  if (!isCloudinaryConfigured()) {
    throw new Error("Cloudinary is not configured; cannot delete object.");
  }
  const publicId = publicIdFromUrl(urlOrId);
  if (!publicId) return;

  await cloudinary.uploader.destroy(publicId, { resource_type: RESOURCE_TYPE });
}

export default deleteFromCloudinary;
