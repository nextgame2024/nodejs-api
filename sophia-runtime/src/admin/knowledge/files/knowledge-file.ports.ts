export const KNOWLEDGE_OBJECT_STORAGE = Symbol("KNOWLEDGE_OBJECT_STORAGE");
export const KNOWLEDGE_MALWARE_SCANNER = Symbol("KNOWLEDGE_MALWARE_SCANNER");
export const KNOWLEDGE_TEXT_PARSER = Symbol("KNOWLEDGE_TEXT_PARSER");

export interface KnowledgeObjectStorage {
  readiness(): Promise<{ ready: boolean; reason?: string }>;
  createUpload(input: {
    objectKey: string;
    mediaType: "text/plain" | "text/markdown";
    contentLength: number;
    checksumSha256Base64: string;
  }): Promise<{ uploadUrl: string; expiresIn: number; requiredHeaders: Record<string, string> }>;
  inspect(objectKey: string): Promise<{ contentLength: number; mediaType?: string; checksumSha256Base64?: string }>;
  readBounded(objectKey: string, maxBytes: number): Promise<Uint8Array>;
  delete(objectKey: string): Promise<void>;
}

export interface KnowledgeMalwareScanner {
  readiness(): Promise<{ ready: boolean; reason?: string }>;
  scan(input: { bytes: Uint8Array; filename: string; mediaType: string }): Promise<{
    status: "clean" | "infected";
    engine: string;
    signature?: string;
  }>;
}

export interface KnowledgeTextParser {
  parse(input: { bytes: Uint8Array; mediaType: "text/plain" | "text/markdown"; maxOutputBytes: number }): Promise<{
    text: string;
    parserVersion: string;
  }>;
}
