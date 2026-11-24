/// <reference lib="dom" />
import { MAX_WORK_IMAGE_BYTES, MAX_WORK_IMAGES_BYTES, type WorkImage } from "../shared/operations";

type PhotoType = WorkImage["mimeType"];
export type ShrinkAttempt = { mimeType: PhotoType; width: number; height: number; quality?: number };
/** What the browser can do for this image. Safari has no WebP encoder; JPEG cannot keep transparency. */
export type ShrinkEncoders = { webp: boolean; opaque: boolean };
export type ShrinkSource = { mimeType: PhotoType; width: number; height: number; size: number } & Partial<ShrinkEncoders>;
export type ShrinkNote = {
  fromBytes: number; toBytes: number; fromWidth: number; fromHeight: number; toWidth: number; toHeight: number; firstFrameOnly?: boolean;
};
export type ShrunkPhoto = { blob: Blob; fromWidth: number; fromHeight: number; toWidth: number; toHeight: number };
export type ImageHeader = { width: number; height: number; animated: boolean };

const MiB = 1024 * 1024;
// Claude rejects images whose width or height is over 8000px, even when the bytes fit.
export const MAX_WORK_IMAGE_EDGE = 8000;
// Decoding needs about 4 bytes per pixel, so very large sources can exhaust memory, especially on iOS Safari.
export const MAX_SOURCE_PIXELS = 50_000_000;
export const MAX_SOURCE_BYTES = 50 * MiB;
// Enough to reach the JPEG frame header past typical EXIF and thumbnail segments.
export const IMAGE_HEADER_BYTES = 512 * 1024;
// Long edge first, then quality.
const LOSSY_STEPS: readonly [edge: number, quality: number][] = [[2560, 0.85], [2048, 0.85], [1600, 0.85], [1600, 0.75], [1280, 0.75], [1024, 0.65]];
// Screenshots stay lossless while only the size shrinks, so text stays sharp.
const PNG_EDGES = [2560, 2048];
const PNG_FALLBACK_EDGES = [2560, 2048, 1600, 1280, 1024];
const PNG_WEBP_STEPS: readonly [edge: number, quality: number][] = [[2560, 0.9], ...LOSSY_STEPS.slice(1)];
// Below this a photo is not worth encoding; the batch already uses most of the total.
const MIN_PHOTO_BUDGET = 64 * 1024;
const EXTENSIONS: Record<PhotoType, string> = { "image/jpeg": "jpg", "image/png": "png", "image/webp": "webp" };

function fit(width: number, height: number, edge: number) {
  const scale = Math.min(1, edge / Math.max(width, height));
  return { width: Math.max(1, Math.round(width * scale)), height: Math.max(1, Math.round(height * scale)) };
}

export function isOversizedImage(width: number, height: number) {
  return Math.max(width, height) > MAX_WORK_IMAGE_EDGE;
}

export function shrinkAttempts(mimeType: PhotoType, width: number, height: number,
  { webp = true, opaque = true }: Partial<ShrinkEncoders> = {}): ShrinkAttempt[] {
  // Lossy steps keep JPEG and use WebP otherwise. Without a WebP encoder an opaque image falls back to JPEG,
  // and a transparent one has no lossy option.
  const lossyType: PhotoType | null = mimeType === "image/jpeg" ? mimeType : webp ? "image/webp" : opaque ? "image/jpeg" : null;
  const lossy = (steps: readonly (readonly [number, number])[]): ShrinkAttempt[] =>
    lossyType ? steps.map(([edge, quality]) => ({ mimeType: lossyType, ...fit(width, height, edge), quality })) : [];
  const png = (edges: readonly number[]): ShrinkAttempt[] => edges.map(edge => ({ mimeType: "image/png", ...fit(width, height, edge) }));
  // An image over the edge limit first tries the largest size the API accepts.
  const largest = !isOversizedImage(width, height) ? []
    : mimeType === "image/png" || !lossyType ? png([MAX_WORK_IMAGE_EDGE]) : lossy([[MAX_WORK_IMAGE_EDGE, 0.85]]);
  const steps = mimeType === "image/png"
    ? webp ? [...png(PNG_EDGES), ...lossy(PNG_WEBP_STEPS)] : [...png(PNG_FALLBACK_EDGES), ...lossy(LOSSY_STEPS)]
    : lossyType ? lossy(LOSSY_STEPS) : png(PNG_FALLBACK_EDGES);
  const seen = new Set<string>();
  return [...largest, ...steps].filter(attempt => {
    const key = `${attempt.mimeType}:${attempt.width}x${attempt.height}:${attempt.quality ?? ""}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

/**
 * Returns the first encoding that fits the target and is smaller than the original. An image over the edge
 * limit may grow, because the original would be rejected anyway.
 */
export async function shrinkWith(source: ShrinkSource, targetBytes: number,
  encode: (attempt: ShrinkAttempt) => Promise<Blob | null>): Promise<{ blob: Blob; attempt: ShrinkAttempt } | null> {
  const unsupported = new Set<PhotoType>();
  for (const attempt of shrinkAttempts(source.mimeType, source.width, source.height, source)) {
    if (unsupported.has(attempt.mimeType)) continue;
    const blob = await encode(attempt);
    if (!blob) continue;
    // Browsers without an encoder for the requested type return PNG instead.
    if (blob.type !== attempt.mimeType) { unsupported.add(attempt.mimeType); continue; }
    const smaller = blob.size < source.size || isOversizedImage(source.width, source.height);
    if (blob.size > 0 && blob.size <= targetBytes && smaller) return { blob, attempt };
  }
  return null;
}

/**
 * Byte budget for each new photo. Photos that already fit keep their size; when the batch would pass the
 * total, the largest photos share what is left equally. Returns null when nothing useful is left.
 */
export function photoBudgets(existingBytes: number, sizes: readonly number[]): number[] | null {
  const capped = sizes.map(size => Math.min(size, MAX_WORK_IMAGE_BYTES));
  let rest = MAX_WORK_IMAGES_BYTES - existingBytes;
  if (capped.reduce((sum, size) => sum + size, 0) <= rest) return capped;
  const ascending = [...capped].sort((a, b) => a - b);
  let cap = 0;
  for (const [index, size] of ascending.entries()) {
    const share = rest / (ascending.length - index);
    if (size <= share) { rest -= size; continue; }
    cap = Math.floor(share);
    break;
  }
  return cap < MIN_PHOTO_BUDGET ? null : capped.map(size => Math.min(size, cap));
}

/** Width, height and animation from a PNG, JPEG or WebP header, or null when the header is not recognized. */
export function imageHeader(bytes: Uint8Array): ImageHeader | null {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const ascii = (offset: number, text: string) => [...text].every((char, index) => bytes[offset + index] === char.charCodeAt(0));
  const size = (width: number, height: number, animated = false) => width > 0 && height > 0 ? { width, height, animated } : null;
  if (bytes.length >= 24 && bytes[0] === 0x89 && ascii(1, "PNG") && ascii(12, "IHDR")) {
    // An animated PNG declares acTL before its first image data.
    let animated = false;
    for (let offset = 8; offset + 8 <= bytes.length;) {
      if (ascii(offset + 4, "acTL")) { animated = true; break; }
      if (ascii(offset + 4, "IDAT")) break;
      offset += 12 + view.getUint32(offset);
    }
    return size(view.getUint32(16), view.getUint32(20), animated);
  }
  if (bytes.length >= 30 && ascii(0, "RIFF") && ascii(8, "WEBP")) {
    if (ascii(12, "VP8 ") && bytes[23] === 0x9d && bytes[24] === 0x01 && bytes[25] === 0x2a)
      return size(view.getUint16(26, true) & 0x3fff, view.getUint16(28, true) & 0x3fff);
    if (ascii(12, "VP8L") && bytes[20] === 0x2f) {
      const bits = view.getUint32(21, true);
      return size((bits & 0x3fff) + 1, ((bits >>> 14) & 0x3fff) + 1);
    }
    const u24 = (offset: number) => bytes[offset]! | (bytes[offset + 1]! << 8) | (bytes[offset + 2]! << 16);
    if (ascii(12, "VP8X")) return size(u24(24) + 1, u24(27) + 1, (bytes[20]! & 0x02) !== 0);
    return null;
  }
  if (bytes[0] !== 0xff || bytes[1] !== 0xd8) return null;
  let offset = 2;
  while (offset + 3 < bytes.length) {
    if (bytes[offset] !== 0xff) return null;
    const marker = bytes[offset + 1]!;
    if (marker === 0xff) { offset++; continue; }
    if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd8)) { offset += 2; continue; }
    if (marker === 0xd9 || marker === 0xda) return null;
    const isFrame = marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc;
    if (isFrame) return offset + 8 < bytes.length ? size(view.getUint16(offset + 7), view.getUint16(offset + 5)) : null;
    offset += 2 + view.getUint16(offset + 2);
  }
  return null;
}

/** Keeps the name but matches the extension to the format the photo was saved in (shot.png → shot.webp). */
export function nameForType(name: string, mimeType: PhotoType) {
  const dot = name.lastIndexOf(".");
  const extension = dot > 0 ? name.slice(dot + 1).toLowerCase() : "";
  if (extension === EXTENSIONS[mimeType] || (mimeType === "image/jpeg" && extension === "jpeg")) return name;
  return `${dot > 0 ? name.slice(0, dot) : name || "photo"}.${EXTENSIONS[mimeType]}`;
}

function formatBytes(bytes: number) {
  if (bytes >= MiB) return `${(bytes / MiB).toFixed(1)} MiB`;
  if (bytes >= 1024) return `${Math.round(bytes / 1024)} KiB`;
  return `${bytes} B`;
}

export function shrinkSummary(note: ShrinkNote) {
  const from = `${note.fromWidth}×${note.fromHeight}`;
  const to = `${note.toWidth}×${note.toHeight}`;
  return { bytes: `${formatBytes(note.fromBytes)} → ${formatBytes(note.toBytes)}`, pixels: from === to ? from : `${from} → ${to}` };
}

/** True when every alpha value is fully opaque, so JPEG can stand in without losing transparency. */
export function allOpaque(rgba: ArrayLike<number>) {
  for (let index = 3; index < rgba.length; index += 4) if (rgba[index] !== 255) return false;
  return true;
}

type ShrinkScope = { createImageBitmap?: unknown; document?: { createElement?: unknown } };

/** The board composer only shrinks on web, where the canvas encoder exists. The mobile app sends photos from the session. */
export function photoShrinkSupported(os: string, scope: ShrinkScope = globalThis as ShrinkScope): boolean {
  return os === "web" && typeof scope.createImageBitmap === "function" && typeof scope.document?.createElement === "function";
}

let webpEncoder: Promise<boolean> | undefined;
function canEncodeWebp() {
  return webpEncoder ??= new Promise<boolean>(resolve => {
    const canvas = document.createElement("canvas");
    canvas.width = canvas.height = 1;
    canvas.toBlob(blob => resolve(blob?.type === "image/webp"), "image/webp");
  });
}

async function decode(file: Blob) {
  try { return await createImageBitmap(file, { imageOrientation: "from-image" }); }
  catch (error) {
    // Older engines reject the options dictionary; they apply EXIF orientation on their own or not at all.
    if (error instanceof TypeError) return await createImageBitmap(file);
    throw error;
  }
}

function isOpaque(bitmap: ImageBitmap) {
  // A reduced copy is enough: any transparent pixel lowers the averaged alpha below 255.
  const { width, height } = fit(bitmap.width, bitmap.height, 1024);
  const probe = document.createElement("canvas");
  probe.width = width;
  probe.height = height;
  try {
    const context = probe.getContext("2d", { willReadFrequently: true });
    if (!context) return false;
    context.drawImage(bitmap, 0, 0, width, height);
    return allOpaque(context.getImageData(0, 0, width, height).data);
  } finally {
    probe.width = probe.height = 0;
  }
}

/** Browser only: call after photoShrinkSupported. Re-encoding drops EXIF data, including location. */
export async function shrinkInBrowser(file: Blob, mimeType: PhotoType, targetBytes: number): Promise<ShrunkPhoto | null> {
  let bitmap: ImageBitmap;
  try { bitmap = await decode(file); }
  catch { return null; }
  const canvas = document.createElement("canvas");
  try {
    const context = canvas.getContext("2d");
    if (!context) return null;
    const encoders = { webp: await canEncodeWebp(), opaque: mimeType === "image/jpeg" || isOpaque(bitmap) };
    const source = { mimeType, width: bitmap.width, height: bitmap.height, size: file.size, ...encoders };
    const result = await shrinkWith(source, targetBytes, attempt => {
      canvas.width = attempt.width;
      canvas.height = attempt.height;
      context.imageSmoothingEnabled = true;
      context.imageSmoothingQuality = "high";
      context.clearRect(0, 0, attempt.width, attempt.height);
      context.drawImage(bitmap, 0, 0, attempt.width, attempt.height);
      return new Promise<Blob | null>(resolve => canvas.toBlob(resolve, attempt.mimeType, attempt.quality));
    });
    return result && { blob: result.blob, fromWidth: bitmap.width, fromHeight: bitmap.height,
      toWidth: result.attempt.width, toHeight: result.attempt.height };
  } catch {
    return null;
  } finally {
    bitmap.close();
    canvas.width = canvas.height = 0;
  }
}
