import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

/**
 * Armazenamento de mídia com driver local (disco).
 * A interface é propositalmente mínima para permitir trocar por um
 * driver S3/Supabase Storage sem alterar quem consome.
 */
export interface MediaStorage {
  /** Salva o buffer e retorna a chave relativa do arquivo. */
  save(data: Buffer, options: { instanceId: string; extension?: string }): Promise<string>;
  /** Lê o arquivo pela chave retornada em save(). */
  read(key: string): Promise<Buffer>;
}

export class LocalMediaStorage implements MediaStorage {
  constructor(private readonly baseDir: string) {}

  async save(data: Buffer, options: { instanceId: string; extension?: string }): Promise<string> {
    const hash = createHash("sha256").update(data).digest("hex").slice(0, 16);
    const ext = options.extension?.replace(/[^a-zA-Z0-9.]/g, "") ?? "";
    const name = `${Date.now()}-${hash}-${randomUUID().slice(0, 8)}${ext ? `.${ext}` : ""}`;
    const dir = path.join(this.baseDir, options.instanceId.replace(/[^a-zA-Z0-9_-]/g, ""));
    await mkdir(dir, { recursive: true });
    const filePath = path.join(dir, name);
    await writeFile(filePath, data);
    return path.relative(this.baseDir, filePath);
  }

  async read(key: string): Promise<Buffer> {
    const resolved = path.resolve(this.baseDir, key);
    // Proteção contra path traversal
    if (!resolved.startsWith(path.resolve(this.baseDir) + path.sep)) {
      throw new Error("Chave de mídia inválida");
    }
    return readFile(resolved);
  }
}

/** Deduz a extensão do arquivo a partir do mime type. */
export function extensionFromMime(mimeType: string | null | undefined): string | undefined {
  if (!mimeType) return undefined;
  const clean = mimeType.split(";")[0]?.trim() ?? "";
  const map: Record<string, string> = {
    "image/jpeg": "jpg",
    "image/png": "png",
    "image/webp": "webp",
    "image/gif": "gif",
    "audio/ogg": "ogg",
    "audio/mpeg": "mp3",
    "audio/mp4": "m4a",
    "audio/wav": "wav",
    "video/mp4": "mp4",
    "video/3gpp": "3gp",
    "application/pdf": "pdf",
  };
  return map[clean] ?? clean.split("/")[1]?.slice(0, 8);
}
