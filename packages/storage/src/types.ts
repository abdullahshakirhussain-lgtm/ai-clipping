/**
 * Object storage abstraction. Production driver is Cloudflare R2 (S3-compatible);
 * the local driver keeps files on disk and serves them through the API's /files route.
 */
export interface ObjectStorage {
  /** Upload a local file. */
  putFile(key: string, localPath: string, contentType?: string): Promise<void>;
  /** Upload an in-memory buffer. */
  putBuffer(key: string, data: Buffer, contentType?: string): Promise<void>;
  /** Download an object to a local file path (parent dir must exist). */
  getToFile(key: string, localPath: string): Promise<void>;
  exists(key: string): Promise<boolean>;
  delete(key: string): Promise<void>;
  /** Browser-consumable URL (presigned for R2, API route for local). */
  getUrl(key: string): Promise<string>;
}
