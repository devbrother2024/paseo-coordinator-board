/// <reference lib="dom" />
import {
  MAX_WORK_IMAGE_BYTES, MAX_WORK_IMAGES, MAX_WORK_IMAGES_BYTES, WORK_IMAGE_MIME_TYPES, type WorkImage,
} from "../shared/operations";
import {
  IMAGE_HEADER_BYTES, imageHeader, isOversizedImage, MAX_SOURCE_BYTES, MAX_SOURCE_PIXELS, nameForType, photoBudgets,
  type ImageHeader, type ShrinkNote, type ShrunkPhoto,
} from "./photo-shrink";

export type DraftPhoto = { id: number; name: string; size: number; image: WorkImage; preview: string; questionIndex?: number; shrunk?: ShrinkNote };
export type PhotoError = "format" | "count" | "size" | "total" | "read" | "shrink" | "source";
export type PreparedPhoto = { name: string; size: number; image: WorkImage; shrunk?: ShrinkNote };
export type PhotoShrinker = (file: File, mimeType: WorkImage["mimeType"], targetBytes: number) => Promise<ShrunkPhoto | null>;

function photoType(file: Pick<File, "type" | "name">): WorkImage["mimeType"] | undefined {
  const suffix = file.name.split(".").pop()?.toLowerCase() ?? "";
  const type = file.type || ({ jpg: "image/jpeg", jpeg: "image/jpeg", png: "image/png", webp: "image/webp" }[suffix]);
  return WORK_IMAGE_MIME_TYPES.find(allowed => allowed === type);
}

export function checkPhotoSelection(existing: readonly Pick<DraftPhoto, "size">[], files: readonly Pick<File, "type" | "name" | "size">[],
  canShrink = false): PhotoError | null {
  if (existing.length + files.length > MAX_WORK_IMAGES) return "count";
  if (files.some(file => !photoType(file))) return "format";
  if (files.some(file => !file.size)) return "size";
  // Oversized photos are shrunk later, against the budget from photoBudgets, unless decoding them is unsafe.
  if (canShrink) return files.some(file => file.size > MAX_SOURCE_BYTES) ? "source" : null;
  if (files.some(file => file.size > MAX_WORK_IMAGE_BYTES)) return "size";
  const total = [...existing, ...files].reduce((sum, file) => sum + file.size, 0);
  return total > MAX_WORK_IMAGES_BYTES ? "total" : null;
}

export async function readWorkPhoto(file: File): Promise<WorkImage> {
  const mimeType = photoType(file);
  if (!mimeType) throw Error("format");
  const encoded = await new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const url = reader.result;
      if (typeof url !== "string" || !url.includes(";base64,")) reject(Error("read"));
      else resolve(url.slice(url.indexOf(",") + 1));
    };
    reader.onabort = reader.onerror = () => reject(Error("read"));
    reader.readAsDataURL(file);
  });
  const padding = encoded.endsWith("==") ? 2 : encoded.endsWith("=") ? 1 : 0;
  if (!encoded.length || encoded.length % 4 !== 0 || encoded.length / 4 * 3 - padding !== file.size) throw Error("read");
  return { mimeType, data: encoded };
}

/**
 * Reads a batch for the draft. With a shrinker, photos over their byte budget or over the edge limit are
 * replaced by a smaller copy; only that copy is kept. The server still checks the limits in shared/work-images.ts.
 */
export async function prepareWorkPhotos(existing: readonly Pick<DraftPhoto, "size">[], files: readonly File[],
  shrink?: PhotoShrinker): Promise<PreparedPhoto[] | PhotoError> {
  const reason = files.length ? checkPhotoSelection(existing, files, !!shrink) : "read";
  if (reason) return reason;
  const headers = shrink ? await Promise.all(files.map(readHeader)) : [];
  if (headers.some(header => header && header.width * header.height > MAX_SOURCE_PIXELS)) return "source";
  const budgets = shrink ? photoBudgets(existing.reduce((sum, photo) => sum + photo.size, 0), files.map(file => file.size))
    : files.map(file => file.size);
  if (!budgets) return "total";
  const prepared: PreparedPhoto[] = [];
  try {
    for (const [index, file] of files.entries()) {
      const budget = budgets[index]!;
      const header = headers[index];
      if (file.size <= budget && !(header && isOversizedImage(header.width, header.height))) {
        prepared.push({ name: file.name, size: file.size, image: await readWorkPhoto(file) });
        continue;
      }
      const shrunk = shrink && await shrink(file, photoType(file)!, budget);
      // A budget cut below the per-photo limit means other photos are taking the room.
      if (!shrunk || shrunk.blob.size > budget) return budget < Math.min(file.size, MAX_WORK_IMAGE_BYTES) ? "total" : "shrink";
      const name = nameForType(file.name, shrunk.blob.type as WorkImage["mimeType"]);
      const copy = new File([shrunk.blob], name, { type: shrunk.blob.type });
      prepared.push({ name, size: copy.size, image: await readWorkPhoto(copy), shrunk: {
        fromBytes: file.size, toBytes: copy.size, fromWidth: shrunk.fromWidth, fromHeight: shrunk.fromHeight,
        toWidth: shrunk.toWidth, toHeight: shrunk.toHeight, ...(header?.animated ? { firstFrameOnly: true } : {}) } });
    }
  } catch {
    return "read";
  }
  return prepared;
}

async function readHeader(file: Blob): Promise<ImageHeader | null> {
  try { return imageHeader(new Uint8Array(await file.slice(0, IMAGE_HEADER_BYTES).arrayBuffer())); }
  catch { return null; }
}

export function clipboardPhotos(data: DataTransfer): File[] {
  try {
    const files = Array.from(data.files ?? []);
    const fileItems = Array.from(data.items ?? []).filter(item => item.kind === "file");
    if (files.length && files.length >= fileItems.length) return files;
    const resolved = fileItems.map(item => item.getAsFile());
    return resolved.every((file): file is File => file !== null) ? resolved : [];
  } catch {
    // Some native drags advertise a file that the WebView cannot read.
    return [];
  }
}

export function isFileDrag(data: DataTransfer): boolean {
  // Browsers hide the FileList until drop, but expose the drag's type during dragover.
  return Array.from(data.types ?? []).some(type => type === "Files" || type.startsWith("image/")) ||
    data.files?.length > 0 || Array.from(data.items ?? []).some(item => item.kind === "file");
}
