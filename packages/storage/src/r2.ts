import { createReadStream } from "node:fs";
import { promises as fs } from "node:fs";
import {
  DeleteObjectCommand,
  GetObjectCommand,
  HeadObjectCommand,
  PutObjectCommand,
  S3Client,
} from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import type { ObjectStorage } from "./types.js";

export interface R2StorageOptions {
  accountId: string;
  accessKeyId: string;
  secretAccessKey: string;
  bucket: string;
  /** Optional CDN/public base URL; presigned URLs are issued when absent. */
  publicBaseUrl?: string;
}

/** Cloudflare R2 driver (S3-compatible API, zero egress fees). */
export class R2Storage implements ObjectStorage {
  private readonly client: S3Client;

  constructor(private readonly opts: R2StorageOptions) {
    this.client = new S3Client({
      region: "auto",
      endpoint: `https://${opts.accountId}.r2.cloudflarestorage.com`,
      credentials: {
        accessKeyId: opts.accessKeyId,
        secretAccessKey: opts.secretAccessKey,
      },
    });
  }

  async putFile(key: string, localPath: string, contentType?: string): Promise<void> {
    const { size } = await fs.stat(localPath);
    await this.client.send(
      new PutObjectCommand({
        Bucket: this.opts.bucket,
        Key: key,
        Body: createReadStream(localPath),
        ContentLength: size,
        ContentType: contentType,
      }),
    );
  }

  async putBuffer(key: string, data: Buffer, contentType?: string): Promise<void> {
    await this.client.send(
      new PutObjectCommand({
        Bucket: this.opts.bucket,
        Key: key,
        Body: data,
        ContentType: contentType,
      }),
    );
  }

  async getToFile(key: string, localPath: string): Promise<void> {
    const res = await this.client.send(
      new GetObjectCommand({ Bucket: this.opts.bucket, Key: key }),
    );
    const bytes = await res.Body!.transformToByteArray();
    await fs.writeFile(localPath, Buffer.from(bytes));
  }

  async exists(key: string): Promise<boolean> {
    try {
      await this.client.send(new HeadObjectCommand({ Bucket: this.opts.bucket, Key: key }));
      return true;
    } catch {
      return false;
    }
  }

  async delete(key: string): Promise<void> {
    await this.client.send(new DeleteObjectCommand({ Bucket: this.opts.bucket, Key: key }));
  }

  async getUrl(key: string): Promise<string> {
    if (this.opts.publicBaseUrl) {
      return `${this.opts.publicBaseUrl}/${key}`;
    }
    // Quantize the signing time to a fixed window so repeated calls for the same
    // key return a BYTE-IDENTICAL URL. The clip list polls every few seconds and
    // re-derives previewUrl each time; without this the signature changed on
    // every poll, so the <video> src kept changing and playback snapped back to
    // the start mid-play. A 10-min bucket keeps the URL stable and still valid
    // (expiresIn is measured from the quantized time, so 50-60 min of validity).
    const bucketMs = 10 * 60 * 1000;
    const signingDate = new Date(Math.floor(Date.now() / bucketMs) * bucketMs);
    return getSignedUrl(
      this.client,
      new GetObjectCommand({ Bucket: this.opts.bucket, Key: key }),
      { expiresIn: 3600, signingDate },
    );
  }
}
