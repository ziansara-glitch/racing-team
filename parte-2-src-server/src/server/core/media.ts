import type { Actor } from "../authz/authorize.ts";
import { ValidationError } from "./errors.ts";
import { insert, type Conn } from "./sql.ts";

// Validazione dei file caricati. Il tipo dichiarato dal browser NON basta: si guardano i primi byte (magic number)
// e si accetta solo una lista chiusa. SVG e HTML non sono ammessi (potrebbero eseguire script se aperti).

export type MediaKind = "image" | "audio" | "video" | "document";
export type MediaRule = { mime: string; kind: MediaKind; maxMb: number; inline: boolean };

const RULES: Record<string, MediaRule> = {
  "image/jpeg": { mime: "image/jpeg", kind: "image", maxMb: 10, inline: true },
  "image/png": { mime: "image/png", kind: "image", maxMb: 10, inline: true },
  "image/gif": { mime: "image/gif", kind: "image", maxMb: 10, inline: true },
  "image/webp": { mime: "image/webp", kind: "image", maxMb: 10, inline: true },
  "audio/webm": { mime: "audio/webm", kind: "audio", maxMb: 20, inline: true },
  "audio/ogg": { mime: "audio/ogg", kind: "audio", maxMb: 20, inline: true },
  "audio/mpeg": { mime: "audio/mpeg", kind: "audio", maxMb: 20, inline: true },
  "audio/mp4": { mime: "audio/mp4", kind: "audio", maxMb: 20, inline: true },
  "audio/wav": { mime: "audio/wav", kind: "audio", maxMb: 20, inline: true },
  "video/mp4": { mime: "video/mp4", kind: "video", maxMb: 100, inline: true },
  "video/webm": { mime: "video/webm", kind: "video", maxMb: 100, inline: true },
  "application/pdf": { mime: "application/pdf", kind: "document", maxMb: 25, inline: true },
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document": { mime: "application/vnd.openxmlformats-officedocument.wordprocessingml.document", kind: "document", maxMb: 25, inline: false },
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet": { mime: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", kind: "document", maxMb: 25, inline: false },
  "application/vnd.openxmlformats-officedocument.presentationml.presentation": { mime: "application/vnd.openxmlformats-officedocument.presentationml.presentation", kind: "document", maxMb: 25, inline: false },
  "text/plain": { mime: "text/plain", kind: "document", maxMb: 5, inline: false },
  "text/csv": { mime: "text/csv", kind: "document", maxMb: 5, inline: false },
};
const OOXML: Record<string, string> = {
  docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  pptx: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
};

export const ruleFor = (mime: string): MediaRule | undefined => RULES[mime];

const ascii = (b: Uint8Array, from: number, len: number) => String.fromCharCode(...b.slice(from, from + len));
const startsWith = (b: Uint8Array, ...bytes: number[]) => bytes.every((v, i) => b[i] === v);

/** Riconosce il formato dai primi byte. `null` = formato non riconosciuto/ammesso. */
export function sniffMime(head: Uint8Array, fileName: string, declared = ""): string | null {
  const ext = fileName.toLowerCase().split(".").pop() ?? "";
  // MediaRecorder dichiara es. "audio/webm;codecs=opus": conta solo il tipo, senza parametri.
  declared = declared.split(";")[0].trim();
  if (startsWith(head, 0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a)) return "image/png";
  if (startsWith(head, 0xff, 0xd8, 0xff)) return "image/jpeg";
  if (ascii(head, 0, 6) === "GIF87a" || ascii(head, 0, 6) === "GIF89a") return "image/gif";
  if (ascii(head, 0, 4) === "RIFF" && ascii(head, 8, 4) === "WEBP") return "image/webp";
  if (ascii(head, 0, 4) === "RIFF" && ascii(head, 8, 4) === "WAVE") return "audio/wav";
  if (ascii(head, 0, 5) === "%PDF-") return "application/pdf";
  if (ascii(head, 0, 4) === "OggS") return "audio/ogg";
  if (ascii(head, 0, 3) === "ID3" || (head[0] === 0xff && (head[1] & 0xe0) === 0xe0)) return "audio/mpeg";
  if (startsWith(head, 0x1a, 0x45, 0xdf, 0xa3)) return declared === "audio/webm" || ext === "weba" ? "audio/webm" : "video/webm";
  if (ascii(head, 4, 4) === "ftyp") return ascii(head, 8, 4).startsWith("M4A") || declared === "audio/mp4" ? "audio/mp4" : "video/mp4";
  if (startsWith(head, 0x50, 0x4b, 0x03, 0x04)) return OOXML[ext] ?? null; // ZIP: ammesso solo come docx/xlsx/pptx
  // Testo: niente byte NUL, UTF-8 valido, estensione txt/csv/md e nessun markup (HTML/SVG/XML).
  if (["txt", "csv", "md"].includes(ext)) {
    if (head.includes(0)) return null;
    try {
      const text = new TextDecoder("utf-8", { fatal: true }).decode(head);
      if (/^\s*</.test(text)) return null;
    } catch {
      return null;
    }
    return ext === "csv" ? "text/csv" : "text/plain";
  }
  return null;
}

export function validateUpload(input: { fileName: string; declaredMime: string; size: number; head: Uint8Array; maxUploadMb: number }): MediaRule {
  if (input.size <= 0) throw new ValidationError("Il file è vuoto.");
  const mime = sniffMime(input.head, input.fileName, input.declaredMime);
  const rule = mime ? RULES[mime] : undefined;
  if (!rule) throw new ValidationError("Tipo di file non consentito: sono ammessi immagini (JPG, PNG, GIF, WebP), audio, video MP4/WebM, PDF, Word/Excel/PowerPoint, TXT e CSV.");
  // Il tipo dichiarato deve essere coerente con il contenuto reale (tranne il generico application/octet-stream).
  const d = input.declaredMime.split(";")[0].trim();
  if (d && d !== "application/octet-stream" && d !== rule.mime && !(d.startsWith("audio/") && rule.mime.startsWith("audio/")) && !(d.startsWith("video/") && rule.mime.startsWith("audio/")) && !(d === "text/markdown" && rule.mime === "text/plain")) {
    throw new ValidationError("Il contenuto del file non corrisponde al tipo dichiarato.");
  }
  const cap = Math.min(rule.maxMb, input.maxUploadMb) * 1024 * 1024;
  if (input.size > cap) throw new ValidationError(`Il file supera il limite di ${Math.min(rule.maxMb, input.maxUploadMb)} MB.`);
  return rule;
}

/** Nome sicuro da mostrare: niente percorsi né caratteri di controllo. */
export const cleanFileName = (name: string): string => name.replace(/[\u0000-\u001f\u007f/\\]/g, "").trim().replace(/^\.+/, "").trim().slice(0, 120) || "file";

export function registerAttachment(conn: Conn, actor: Actor, a: { storageKey: string; originalName: string; mime: string; size: number; sha256: string; width?: number | null; height?: number | null; durationMs?: number | null }): number {
  return insert(
    conn,
    `INSERT INTO attachments (org_id, uploader_membership_id, storage_key, original_name, mime, size_bytes, sha256, width, height, duration_ms) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    actor.orgId, actor.membershipId, a.storageKey, cleanFileName(a.originalName), a.mime, a.size, a.sha256, a.width ?? null, a.height ?? null, a.durationMs ?? null,
  );
}
