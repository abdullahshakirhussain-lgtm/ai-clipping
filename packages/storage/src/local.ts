import { promises as fs } from "node:fs";
import { dirname, join, normalize, resolve } from "node:path";
import type { ObjectStorage } from "./types.js";

export interface LocalStorageOptions {
  /** Root directory for stored objects. */
  rootDir: string;
  /** Base URL of the API that serves /api/v1/files/:key. */
  publicBaseUrl: string;
}

/** Dev/offline driver: objects live under rootDir, served by the API files route. */
export class LocalStorage implements ObjectStorage {
  private readonly root: string;

  constructor(private readonly opts: LocalStorageOptions) {
    this.root = resolve(opts.rootDir);
  }

  /** Resolve a key to an absolute path, refusing traversal outside the root. */
  resolveKey(key: string): string {
    const abs = resolve(join(this.root, normalize(key)));
    if (!abs.startsWith(this.root)) {
      throw new Error(`Storage key escapes root: ${key}`);
    }
    return abs;
  }

  async putFile(key: string, localPath: string): Promise<void> {
    const dest = this.resolveKey(key);
    await fs.mkdir(dirname(dest), { recursive: true });
    await fs.copyFile(localPath, dest);
  }

  async putBuffer(key: string, data: Buffer): Promise<void> {
    const dest = this.resolveKey(key);
    await fs.mkdir(dirname(dest), { recursive: true });
    await fs.writeFile(dest, data);
  }

  async getToFile(key: string, localPath: string): Promise<void> {
    await fs.copyFile(this.resolveKey(key), localPath);
  }

  async exists(key: string): Promise<boolean> {
    try {
      await fs.access(this.resolveKey(key));
      return true;
    } catch {
      return false;
    }
  }

  async delete(key: string): Promise<void> {
    await fs.rm(this.resolveKey(key), { force: true });
  }

  async getUrl(key: string): Promise<string> {
    return `${this.opts.publicBaseUrl}/api/v1/files/${encodeURIComponent(key)}`;
  }
}
