/**
 * getFromCloudinary.ts
 * ================================
 * Fetch a stored PDF from Cloudinary for streaming back to a client. Cloudinary
 * `raw` resources are served from a public delivery URL, so we simply GET that
 * URL and hand back the response stream. Accepts a full URL or a bare
 * public_id (which is resolved to a delivery URL).
 */

import http from "http";
import https from "https";
import type { Readable } from "stream";
import {
  cloudinary,
  RESOURCE_TYPE,
  isCloudinaryConfigured,
  publicIdFromUrl,
} from "./cloudinary";

export interface CloudinaryObject {
  body: Readable;
  contentType: string;
  contentLength?: number;
}

/** Resolve the input to an absolute https delivery URL. */
function toDeliveryUrl(urlOrId: string): string {
  if (/^https?:\/\//i.test(urlOrId)) return urlOrId;
  const publicId = publicIdFromUrl(urlOrId);
  return cloudinary.url(publicId, { resource_type: RESOURCE_TYPE, secure: true });
}

/** GET a URL, following up to `maxRedirects` 3xx redirects. */
function getStream(url: string, maxRedirects = 3): Promise<CloudinaryObject> {
  return new Promise((resolve, reject) => {
    const client = url.startsWith("http://") ? http : https;
    const req = client.get(url, (res) => {
      const status = res.statusCode || 0;

      if (status >= 300 && status < 400 && res.headers.location && maxRedirects > 0) {
        res.resume(); // drain
        const next = new URL(res.headers.location, url).toString();
        resolve(getStream(next, maxRedirects - 1));
        return;
      }

      if (status !== 200) {
        res.resume();
        const err = new Error(`Cloudinary fetch failed with status ${status}`) as Error & {
          statusCode?: number;
        };
        err.statusCode = status;
        reject(err);
        return;
      }

      const len = res.headers["content-length"];
      resolve({
        body: res,
        contentType: res.headers["content-type"] || "application/pdf",
        contentLength: len ? parseInt(len, 10) : undefined,
      });
    });
    req.on("error", reject);
  });
}

/**
 * Stream a stored PDF out of Cloudinary. Throws if Cloudinary isn't configured
 * or the input is empty; rejects with `statusCode` 404 when the object is gone.
 */
export async function getFromCloudinary(urlOrId: string): Promise<CloudinaryObject> {
  if (!isCloudinaryConfigured()) {
    throw new Error("Cloudinary is not configured; cannot read object.");
  }
  if (!urlOrId) throw new Error("Empty Cloudinary key");
  return getStream(toDeliveryUrl(urlOrId));
}

export default getFromCloudinary;
