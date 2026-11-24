import { expect, test } from "bun:test";
import {
  allOpaque, imageHeader, MAX_SOURCE_BYTES, MAX_WORK_IMAGE_EDGE, nameForType, photoBudgets, photoShrinkSupported, shrinkAttempts, shrinkSummary, shrinkWith, type ShrinkAttempt,
} from "../client/photo-shrink";
import { prepareWorkPhotos, type PhotoShrinker } from "../client/work-photos";
import { MAX_WORK_IMAGE_BYTES, MAX_WORK_IMAGES_BYTES } from "../shared/operations";

const MiB = 1024 * 1024;

// A stand-in encoder: bytes grow with pixels and quality, PNG costs more per pixel than lossy formats.
function fakeEncoder(bytesPerPixel: Partial<Record<ShrinkAttempt["mimeType"], number>>, log: ShrinkAttempt[] = []) {
  return async (attempt: ShrinkAttempt) => {
    log.push(attempt);
    const rate = bytesPerPixel[attempt.mimeType];
    if (rate === undefined) return new Blob(["x"], {type: "image/png"}); // browser without this encoder falls back to PNG
    const size = Math.round(attempt.width * attempt.height * rate * (attempt.quality ?? 1));
    return new Blob([new Uint8Array(size)], {type: attempt.mimeType});
  };
}

test("attempts shrink the long edge step by step and keep the aspect ratio", () => {
  const attempts = shrinkAttempts("image/jpeg", 4032, 3024);
  expect(attempts[0]).toEqual({mimeType: "image/jpeg", width: 2560, height: 1920, quality: 0.85});
  expect(attempts.map(a => Math.max(a.width, a.height))).toEqual([2560, 2048, 1600, 1600, 1280, 1024]);
  expect(attempts.every(a => a.mimeType === "image/jpeg")).toBe(true);
  expect(attempts.map(a => a.quality)).toEqual([0.85, 0.85, 0.85, 0.75, 0.75, 0.65]);
  const portrait = shrinkAttempts("image/webp", 3000, 6000)[0];
  expect(portrait).toEqual({mimeType: "image/webp", width: 1280, height: 2560, quality: 0.85});
});

test("PNG screenshots shrink losslessly first and only then switch to WebP", () => {
  const attempts = shrinkAttempts("image/png", 5120, 2880);
  const firstWebp = attempts.findIndex(a => a.mimeType === "image/webp");
  expect(attempts.slice(0, firstWebp).map(a => [a.mimeType, a.width])).toEqual([["image/png", 2560], ["image/png", 2048]]);
  expect(attempts.slice(0, firstWebp).every(a => a.quality === undefined)).toBe(true);
  expect(attempts.slice(firstWebp).every(a => a.mimeType === "image/webp")).toBe(true);
});

test("a small image that is still too many bytes is re-encoded at its own size without upscaling", () => {
  const attempts = shrinkAttempts("image/jpeg", 1800, 1200);
  expect(attempts[0]).toEqual({mimeType: "image/jpeg", width: 1800, height: 1200, quality: 0.85});
  expect(attempts.every(a => a.width <= 1800 && a.height <= 1200)).toBe(true);
  expect(new Set(attempts.map(a => `${a.mimeType}:${a.width}:${a.quality}`)).size).toBe(attempts.length);
});

test("a large JPEG shrinks to the first step that fits the target", async () => {
  const log: ShrinkAttempt[] = [];
  const source = {mimeType: "image/jpeg" as const, width: 4032, height: 3024, size: 8.4e6};
  // 2560x1920 at 0.85 is about 4.2 MB, so the first attempt already fits 5 MiB.
  const result = await shrinkWith(source, MAX_WORK_IMAGE_BYTES, fakeEncoder({"image/jpeg": 1}, log));
  expect(result?.attempt).toEqual({mimeType: "image/jpeg", width: 2560, height: 1920, quality: 0.85});
  expect(result!.blob.size).toBeLessThanOrEqual(MAX_WORK_IMAGE_BYTES);
  expect(log).toHaveLength(1);
});

test("a large PNG keeps PNG when the smaller size fits and moves to WebP when it does not", async () => {
  const source = {mimeType: "image/png" as const, width: 5120, height: 2880, size: 14e6};
  const lossless = await shrinkWith(source, MAX_WORK_IMAGE_BYTES, fakeEncoder({"image/png": 0.9, "image/webp": 0.3}));
  expect(lossless?.attempt.mimeType).toBe("image/png");
  expect(lossless!.blob.size).toBeLessThanOrEqual(MAX_WORK_IMAGE_BYTES);
  const lossy = await shrinkWith(source, MAX_WORK_IMAGE_BYTES, fakeEncoder({"image/png": 3, "image/webp": 0.3}));
  expect(lossy?.attempt.mimeType).toBe("image/webp");
  expect(lossy!.blob.size).toBeLessThanOrEqual(MAX_WORK_IMAGE_BYTES);
});

test("an encoder that silently returns another format is skipped", async () => {
  const source = {mimeType: "image/png" as const, width: 5120, height: 2880, size: 14e6};
  // Safari-like: no WebP encoder, so asking for WebP returns PNG.
  expect(await shrinkWith(source, MAX_WORK_IMAGE_BYTES, fakeEncoder({"image/png": 3}))).toBeNull();
});

test("a result that would be larger than the original is never chosen", async () => {
  const source = {mimeType: "image/jpeg" as const, width: 2000, height: 1500, size: 1e6};
  expect(await shrinkWith(source, 2 * MiB, fakeEncoder({"image/jpeg": 2}))).toBeNull();
});

test("an image that cannot reach the target returns no result", async () => {
  const source = {mimeType: "image/jpeg" as const, width: 4032, height: 3024, size: 9e6};
  expect(await shrinkWith(source, 10_000, fakeEncoder({"image/jpeg": 1}))).toBeNull();
});

test("budgets keep photos that fit and shrink the largest photos first to fit the total", () => {
  expect(photoBudgets(0, [1 * MiB, 2 * MiB])).toEqual([1 * MiB, 2 * MiB]);
  expect(photoBudgets(0, [8 * MiB])).toEqual([MAX_WORK_IMAGE_BYTES]);
  const sizes = [1 * MiB, 4.5 * MiB, 4.8 * MiB, 4.9 * MiB];
  const budgets = photoBudgets(0, sizes)!;
  expect(budgets[0]).toBe(1 * MiB);
  expect(budgets.reduce((a, b) => a + b, 0)).toBeLessThanOrEqual(MAX_WORK_IMAGES_BYTES);
  expect(budgets.slice(1).every(budget => budget < 4.5 * MiB)).toBe(true);
  const withExisting = photoBudgets(10 * MiB, [3 * MiB])!;
  expect(withExisting[0]).toBeLessThanOrEqual(2 * MiB);
  expect(photoBudgets(MAX_WORK_IMAGES_BYTES, [1 * MiB])).toBeNull();
});

test("shrinking runs only on web with an image decoder and a document", () => {
  const browser = {createImageBitmap: () => {}, document: {createElement: () => {}}} as unknown as typeof globalThis;
  expect(photoShrinkSupported("web", browser)).toBe(true);
  expect(photoShrinkSupported("ios", browser)).toBe(false);
  expect(photoShrinkSupported("android", browser)).toBe(false);
  expect(photoShrinkSupported("web", {document: {createElement: () => {}}} as unknown as typeof globalThis)).toBe(false);
  expect(photoShrinkSupported("web", {createImageBitmap: () => {}} as unknown as typeof globalThis)).toBe(false);
});

test("the preview summary shows bytes and pixels before and after", () => {
  expect(shrinkSummary({fromBytes: 8_400_000, toBytes: 3_100_000, fromWidth: 4032, fromHeight: 3024, toWidth: 2048, toHeight: 1536}))
    .toEqual({bytes: "8.0 MiB → 3.0 MiB", pixels: "4032×3024 → 2048×1536"});
  expect(shrinkSummary({fromBytes: 1_200_000, toBytes: 640_000, fromWidth: 2000, fromHeight: 1000, toWidth: 2000, toHeight: 1000}))
    .toEqual({bytes: "1.1 MiB → 625 KiB", pixels: "2000×1000"});
});

function withReader<T>(run: () => Promise<T>) {
  const original = Object.getOwnPropertyDescriptor(globalThis, "FileReader");
  class Reader {
    result = "";
    onload = () => {};
    onerror = () => {};
    readAsDataURL(blob: Blob) {
      void blob.arrayBuffer().then(buffer => {
        this.result = `data:${blob.type};base64,` + Buffer.from(buffer).toString("base64");
        this.onload();
      });
    }
  }
  Object.defineProperty(globalThis, "FileReader", {value: Reader, configurable: true});
  return run().finally(() => {
    if (original) Object.defineProperty(globalThis, "FileReader", original); else Reflect.deleteProperty(globalThis, "FileReader");
  });
}

const photo = (name: string, size: number, type = "image/jpeg") => new File([new Uint8Array(size)], name, {type});

test("photos within the limits are attached unchanged without calling the shrinker", async () => {
  let calls = 0;
  const shrinker: PhotoShrinker = async () => { calls++; return null; };
  const result = await withReader(() => prepareWorkPhotos([], [photo("a.jpg", 1000)], shrinker));
  expect(Array.isArray(result)).toBe(true);
  if (!Array.isArray(result)) return;
  expect(result[0]).toMatchObject({name: "a.jpg", size: 1000, image: {mimeType: "image/jpeg"}});
  expect(result[0]!.shrunk).toBeUndefined();
  expect(calls).toBe(0);
});

test("an oversized photo is replaced by the shrunk copy and records what changed", async () => {
  const targets: number[] = [];
  const shrinker: PhotoShrinker = async (_file, _type, target) => {
    targets.push(target);
    return {blob: new Blob([new Uint8Array(2000)], {type: "image/webp"}), fromWidth: 5000, fromHeight: 2500, toWidth: 2560, toHeight: 1280};
  };
  const big = photo("shot.png", MAX_WORK_IMAGE_BYTES + 1, "image/png");
  const result = await withReader(() => prepareWorkPhotos([], [big], shrinker));
  if (!Array.isArray(result)) throw Error(String(result));
  expect(targets).toEqual([MAX_WORK_IMAGE_BYTES]);
  expect(result[0]).toMatchObject({name: "shot.webp", size: 2000, image: {mimeType: "image/webp"},
    shrunk: {fromBytes: MAX_WORK_IMAGE_BYTES + 1, toBytes: 2000, fromWidth: 5000, toWidth: 2560}});
  expect(Buffer.from(result[0]!.image.data, "base64").length).toBe(2000);
});

test("the batch shrinks photos that would push the total over the limit", async () => {
  const targets: number[] = [];
  const shrinker: PhotoShrinker = async (file, type, target) => {
    targets.push(target);
    return {blob: new Blob([new Uint8Array(Math.floor(target / 2))], {type}), fromWidth: 4000, fromHeight: 3000, toWidth: 2560, toHeight: 1920};
  };
  const files = [photo("1.jpg", 4.9 * MiB), photo("2.jpg", 4.9 * MiB), photo("3.jpg", 4.9 * MiB)];
  const result = await withReader(() => prepareWorkPhotos([], files, shrinker));
  if (!Array.isArray(result)) throw Error(String(result));
  expect(targets).toHaveLength(3);
  expect(result.reduce((sum, item) => sum + item.size, 0)).toBeLessThanOrEqual(MAX_WORK_IMAGES_BYTES);
});

test("a photo that cannot be shrunk enough fails the whole batch", async () => {
  const shrinker: PhotoShrinker = async () => null;
  expect(await withReader(() => prepareWorkPhotos([], [photo("a.jpg", 10), photo("b.jpg", 6 * MiB)], shrinker))).toBe("shrink");
});

test("without a shrinker the original size errors remain", async () => {
  expect(await prepareWorkPhotos([], [photo("big.jpg", MAX_WORK_IMAGE_BYTES + 1)])).toBe("size");
  expect(await prepareWorkPhotos([{size: 5 * MiB}, {size: 5 * MiB}], [photo("c.jpg", 3 * MiB)])).toBe("total");
  expect(await prepareWorkPhotos([], [photo("empty.jpg", 0)], async () => null)).toBe("size");
  expect(await prepareWorkPhotos([], [], async () => null)).toBe("read");
});

function pngHeader(width: number, height: number) {
  const bytes = new Uint8Array(33);
  bytes.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52]);
  new DataView(bytes.buffer).setUint32(16, width);
  new DataView(bytes.buffer).setUint32(20, height);
  return bytes;
}

function jpegHeader(width: number, height: number) {
  // SOI, an APP1 segment to skip, then SOF0 with height before width.
  const app1 = [0xff, 0xe1, 0, 8, 0x45, 0x78, 0x69, 0x66, 0, 0];
  const sof = [0xff, 0xc0, 0, 11, 8, height >> 8, height & 255, width >> 8, width & 255, 1, 1, 0x11, 0];
  return new Uint8Array([0xff, 0xd8, ...app1, ...sof]);
}

function webpHeader(kind: "VP8 " | "VP8L" | "VP8X", width: number, height: number) {
  const bytes = new Uint8Array(30);
  const text = (offset: number, value: string) => bytes.set([...value].map(c => c.charCodeAt(0)), offset);
  text(0, "RIFF"); text(8, "WEBP"); text(12, kind);
  const view = new DataView(bytes.buffer);
  if (kind === "VP8 ") { bytes.set([0x9d, 0x01, 0x2a], 23); view.setUint16(26, width, true); view.setUint16(28, height, true); }
  if (kind === "VP8L") { bytes[20] = 0x2f; view.setUint32(21, ((width - 1) & 0x3fff) | (((height - 1) & 0x3fff) << 14), true); }
  if (kind === "VP8X") { const w = width - 1, h = height - 1; bytes.set([w & 255, (w >> 8) & 255, w >> 16, h & 255, (h >> 8) & 255, h >> 16], 24); }
  return bytes;
}

test("image dimensions come from the file header of each supported format", () => {
  expect(imageHeader(pngHeader(12000, 3000))).toEqual({width: 12000, height: 3000, animated: false});
  expect(imageHeader(jpegHeader(9000, 4000))).toEqual({width: 9000, height: 4000, animated: false});
  expect(imageHeader(webpHeader("VP8 ", 4000, 3000))).toEqual({width: 4000, height: 3000, animated: false});
  expect(imageHeader(webpHeader("VP8L", 9000, 2000))).toEqual({width: 9000, height: 2000, animated: false});
  expect(imageHeader(webpHeader("VP8X", 16000, 900))).toEqual({width: 16000, height: 900, animated: false});
  expect(imageHeader(new Uint8Array([1, 2, 3]))).toBeNull();
  expect(imageHeader(jpegHeader(9000, 4000).subarray(0, 14))).toBeNull();
});

test("animated PNG and WebP headers are recognized", () => {
  const ihdr = pngHeader(640, 480);
  const actl = new Uint8Array([0, 0, 0, 8, 0x61, 0x63, 0x54, 0x4c, 0, 0, 0, 2, 0, 0, 0, 0, 0, 0, 0, 0]);
  const idat = new Uint8Array([0, 0, 0, 0, 0x49, 0x44, 0x41, 0x54, 0, 0, 0, 0]);
  // pngHeader already ends with the IHDR checksum, so the next chunk starts right after it.
  expect(imageHeader(new Uint8Array([...ihdr, ...actl, ...idat]))?.animated).toBe(true);
  expect(imageHeader(new Uint8Array([...ihdr, ...idat, ...actl]))?.animated).toBe(false);
  const animatedWebp = webpHeader("VP8X", 400, 300);
  animatedWebp[20] = 0x02;
  expect(imageHeader(animatedWebp)?.animated).toBe(true);
});

test("an image wider or taller than 8000px first tries the largest size the API accepts", () => {
  const panorama = shrinkAttempts("image/jpeg", 12000, 2000);
  expect(panorama[0]).toEqual({mimeType: "image/jpeg", width: MAX_WORK_IMAGE_EDGE, height: 1333, quality: 0.85});
  expect(shrinkAttempts("image/png", 2000, 16000)[0]).toEqual({mimeType: "image/png", width: 1000, height: MAX_WORK_IMAGE_EDGE});
  expect(shrinkAttempts("image/jpeg", 8000, 3000)[0]!.width).toBe(2560);
  expect(shrinkAttempts("image/png", 12000, 2000).every(a => Math.max(a.width, a.height) <= MAX_WORK_IMAGE_EDGE)).toBe(true);
});

test("an oversized image may grow in bytes because the original would be rejected anyway", async () => {
  const source = {mimeType: "image/png" as const, width: 12000, height: 2000, size: 1e6};
  const result = await shrinkWith(source, MAX_WORK_IMAGE_BYTES, fakeEncoder({"image/png": 0.2}));
  expect(result?.attempt).toEqual({mimeType: "image/png", width: 8000, height: 1333});
  expect(result!.blob.size).toBeGreaterThan(source.size);
});

test("a photo within the byte limit but over 8000px is shrunk while smaller photos are not decoded", async () => {
  const calls: [string, number][] = [];
  const shrinker: PhotoShrinker = async (file, type, target) => {
    calls.push([file.name, target]);
    return {blob: new Blob([new Uint8Array(3000)], {type}), fromWidth: 12000, fromHeight: 3000, toWidth: 8000, toHeight: 2000};
  };
  const wide = new File([pngHeader(12000, 3000), new Uint8Array(5000)], "wide.png", {type: "image/png"});
  const normal = new File([pngHeader(4000, 3000), new Uint8Array(5000)], "normal.png", {type: "image/png"});
  const edge = new File([pngHeader(8000, 6000), new Uint8Array(5000)], "edge.png", {type: "image/png"});
  const result = await withReader(() => prepareWorkPhotos([], [wide, normal, edge], shrinker));
  if (!Array.isArray(result)) throw Error(String(result));
  expect(calls).toEqual([["wide.png", wide.size]]);
  expect(result[0]).toMatchObject({size: 3000, shrunk: {fromBytes: wide.size, toBytes: 3000, fromWidth: 12000, toWidth: 8000}});
  expect(result[1]!.shrunk).toBeUndefined();
  expect(result[2]!.shrunk).toBeUndefined();
});

// Safari: asking the canvas for WebP silently returns PNG.
const safari = {"image/jpeg": 0.5, "image/png": 3};

test("without a WebP encoder an opaque WebP falls back to JPEG and a transparent one to PNG", async () => {
  expect(shrinkAttempts("image/webp", 4000, 3000, {webp: false, opaque: true}).every(a => a.mimeType === "image/jpeg")).toBe(true);
  expect(shrinkAttempts("image/webp", 4000, 3000, {webp: false, opaque: false}).every(a => a.mimeType === "image/png")).toBe(true);
  const source = {mimeType: "image/webp" as const, width: 4000, height: 3000, size: 7 * MiB};
  const opaque = await shrinkWith({...source, webp: false, opaque: true}, MAX_WORK_IMAGE_BYTES, fakeEncoder(safari));
  expect(opaque?.attempt.mimeType).toBe("image/jpeg");
  const transparent = await shrinkWith({...source, webp: false, opaque: false}, MAX_WORK_IMAGE_BYTES, fakeEncoder({"image/png": 0.5}));
  expect(transparent?.attempt).toEqual({mimeType: "image/png", width: 2560, height: 1920});
});

test("without a WebP encoder a PNG keeps shrinking as PNG, then uses JPEG only when opaque", async () => {
  const transparentPlan = shrinkAttempts("image/png", 5120, 2880, {webp: false, opaque: false});
  expect(transparentPlan.map(a => [a.mimeType, a.width])).toEqual(
    [["image/png", 2560], ["image/png", 2048], ["image/png", 1600], ["image/png", 1280], ["image/png", 1024]]);
  const opaquePlan = shrinkAttempts("image/png", 5120, 2880, {webp: false, opaque: true});
  expect(opaquePlan.slice(0, 5).every(a => a.mimeType === "image/png")).toBe(true);
  expect(opaquePlan.slice(5).every(a => a.mimeType === "image/jpeg")).toBe(true);
  const photoLike = {mimeType: "image/png" as const, width: 5120, height: 2880, size: 30 * MiB};
  // PNG at 1024 is still about 6.3 MB here, so only the JPEG steps fit.
  const result = await shrinkWith({...photoLike, webp: false, opaque: true}, MAX_WORK_IMAGE_BYTES, fakeEncoder({"image/png": 11, "image/jpeg": 0.5}));
  expect(result?.attempt.mimeType).toBe("image/jpeg");
  expect(await shrinkWith({...photoLike, webp: false, opaque: false}, MAX_WORK_IMAGE_BYTES, fakeEncoder({"image/png": 11}))).toBeNull();
});

test("an encoder that ignores the requested type is not asked for that type again", async () => {
  const log: ShrinkAttempt[] = [];
  const source = {mimeType: "image/webp" as const, width: 4000, height: 3000, size: 7 * MiB};
  expect(await shrinkWith(source, MAX_WORK_IMAGE_BYTES, fakeEncoder(safari, log))).toBeNull();
  expect(log).toHaveLength(1);
});

test("opacity checks every alpha value", () => {
  expect(allOpaque([1, 2, 3, 255, 4, 5, 6, 255])).toBe(true);
  expect(allOpaque([1, 2, 3, 255, 4, 5, 6, 254])).toBe(false);
});

test("a photo saved in another format gets the matching extension", () => {
  expect(nameForType("shot.png", "image/webp")).toBe("shot.webp");
  expect(nameForType("shot.PNG", "image/png")).toBe("shot.PNG");
  expect(nameForType("photo.jpeg", "image/jpeg")).toBe("photo.jpeg");
  expect(nameForType("art.webp", "image/jpeg")).toBe("art.jpg");
  expect(nameForType("image", "image/webp")).toBe("image.webp");
  expect(nameForType("", "image/jpeg")).toBe("photo.jpg");
});

test("sources too large to decode safely are refused before shrinking", async () => {
  let calls = 0;
  const shrinker: PhotoShrinker = async () => { calls++; return null; };
  const heavy = {name: "huge.jpg", type: "image/jpeg", size: MAX_SOURCE_BYTES + 1} as File;
  expect(await prepareWorkPhotos([], [heavy], shrinker)).toBe("source");
  const panorama = new File([pngHeader(20000, 3000), new Uint8Array(100)], "pano.png", {type: "image/png"});
  expect(await prepareWorkPhotos([], [panorama], shrinker)).toBe("source");
  expect(calls).toBe(0);
});

test("a shrink that fails because other photos fill the total asks to remove an attachment", async () => {
  const shrinker: PhotoShrinker = async () => null;
  expect(await withReader(() => prepareWorkPhotos([{size: 10 * MiB}], [photo("c.jpg", 3 * MiB)], shrinker))).toBe("total");
  expect(await withReader(() => prepareWorkPhotos([], [photo("d.jpg", 6 * MiB)], shrinker))).toBe("shrink");
});

test("a shrunk photo takes the extension of its new format and notes when only the first frame remains", async () => {
  const shrinker: PhotoShrinker = async () =>
    ({blob: new Blob([new Uint8Array(4000)], {type: "image/webp"}), fromWidth: 640, fromHeight: 480, toWidth: 640, toHeight: 480});
  const ihdr = pngHeader(640, 480);
  const actl = [0, 0, 0, 8, 0x61, 0x63, 0x54, 0x4c, 0, 0, 0, 2, 0, 0, 0, 0, 0, 0, 0, 0];
  const animated = new File([ihdr, new Uint8Array(actl), new Uint8Array(MAX_WORK_IMAGE_BYTES)], "loop.png", {type: "image/png"});
  const result = await withReader(() => prepareWorkPhotos([], [animated], shrinker));
  if (!Array.isArray(result)) throw Error(String(result));
  expect(result[0]).toMatchObject({name: "loop.webp", image: {mimeType: "image/webp"}, shrunk: {firstFrameOnly: true}});
});
