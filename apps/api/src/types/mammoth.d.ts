// A "mammoth" não publica tipos próprios nem tem @types oficial no npm.
// Declaramos aqui só o que a base de conhecimento usa (`extractRawText`) —
// nada além disso é chamado no código, então nada além disso é tipado.
declare module "mammoth" {
  export interface ExtractRawTextResult {
    value: string;
    messages: unknown[];
  }

  export function extractRawText(input: { buffer: Buffer }): Promise<ExtractRawTextResult>;
}
