import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import type { Logger } from "pino";

/**
 * Ponte entre o `instanceId` do AZVCHAT (uuid da WhatsAppInstance) e o `sid`
 * do AstraCalls (gerado pelo servidor dele). O AZVCHAT raciocina em
 * instanceId; o AstraCalls, em sid — e o webhook volta identificando a
 * sessão pelo sid, então precisamos dos dois sentidos.
 *
 * Persistido como um JSON único em `sessionDir`, no mesmo espírito do
 * `sessionDir` que o provider Baileys já usa para as credenciais: o provider
 * não fala com o banco (é pacote puro), então a associação mora aqui, ao
 * lado das sessões, e sobrevive a restart.
 */
export class SessionMapping {
  private readonly file: string;
  private forward: Record<string, string> = {}; // instanceId -> sid
  private reverse: Record<string, string> = {}; // sid -> instanceId
  private loaded = false;

  constructor(
    private readonly sessionDir: string,
    private readonly logger?: Logger,
  ) {
    this.file = path.join(sessionDir, "astracalls-sessions.json");
  }

  private async ensureLoaded(): Promise<void> {
    if (this.loaded) return;
    try {
      const raw = await readFile(this.file, "utf8");
      const parsed = JSON.parse(raw) as Record<string, string>;
      this.forward = parsed;
      this.reverse = Object.fromEntries(Object.entries(parsed).map(([k, v]) => [v, k]));
    } catch (err) {
      // Arquivo ausente na primeira vez é o estado normal — nada de sessão ainda.
      const code = (err as NodeJS.ErrnoException).code;
      if (code !== "ENOENT") {
        this.logger?.warn({ event: "astracalls_mapping_read_failed", error: String(err) });
      }
      this.forward = {};
      this.reverse = {};
    }
    this.loaded = true;
  }

  private async persist(): Promise<void> {
    await mkdir(this.sessionDir, { recursive: true });
    await writeFile(this.file, JSON.stringify(this.forward, null, 2), "utf8");
  }

  async getSid(instanceId: string): Promise<string | null> {
    await this.ensureLoaded();
    return this.forward[instanceId] ?? null;
  }

  async getInstanceId(sid: string): Promise<string | null> {
    await this.ensureLoaded();
    return this.reverse[sid] ?? null;
  }

  /** Sincronamente, para o hot path do webhook (assume já carregado no boot). */
  getInstanceIdSync(sid: string): string | null {
    return this.reverse[sid] ?? null;
  }

  async set(instanceId: string, sid: string): Promise<void> {
    await this.ensureLoaded();
    // Se a instância trocou de sid, limpa o reverse antigo para não vazar.
    const previous = this.forward[instanceId];
    if (previous && previous !== sid) delete this.reverse[previous];
    this.forward[instanceId] = sid;
    this.reverse[sid] = instanceId;
    await this.persist();
  }

  async remove(instanceId: string): Promise<void> {
    await this.ensureLoaded();
    const sid = this.forward[instanceId];
    if (sid) delete this.reverse[sid];
    delete this.forward[instanceId];
    await this.persist();
  }

  /** Carrega o arquivo no boot para o webhook poder resolver sid→instanceId sem await. */
  async preload(): Promise<void> {
    await this.ensureLoaded();
  }
}
