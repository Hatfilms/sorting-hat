import { createWorker, Worker } from "tesseract.js";
import sharp from "sharp";
import { createHash } from "node:crypto";
import { getCachedScamResult, saveScamResult, ScamCacheResult } from "./sqlite";

const scamPatterns = [
  // Gambling / casinos
  /\b(crypto\s+casino|online\s+gambling)\b/i,

  // Giveaway scams
  /\b(giveaway|free\s+money|win\s+prizes?|claim\s+reward)\b/i,

  // Money promises (removed generic "$5" matching)
  /\b(free\s+\$\d+|earn\s+\$\d+|make\s+\$\d+)\b/i,

  // Rewards
  /\b(bonus|reward|incentive|prize)\b/i,

  // Codes / vouchers
  /\b(promo\s*code|discount\s*code|voucher|coupon)\b/i,

  // Calls to action
  /\b(register|sign\s+up|join\s+now|create\s+account)\b/i,

  // Urgency
  /\b(limited\s+time|exclusive\s+offer|act\s+fast|don't\s+miss)\b/i,

  // Pressure wording
  /\b(instantly|immediately|right\s+away|quick\s+access)\b/i,

  // Too-good-to-be-true claims
  /\b(no\s+fees|risk[- ]?free|guaranteed|secret\s+method)\b/i,

  // Crypto
  /\b(bitcoin|ethereum|crypto|wallet|deposit)\b/i,
];

// Spinning up a Tesseract worker loads the WASM core and language data,
// which takes seconds. Keep one persistent worker and reuse it.
let workerPromise: Promise<Worker> | null = null;
let ocrQueue: Promise<unknown> = Promise.resolve();

const getWorker = (): Promise<Worker> => {
  workerPromise ??= createWorker("eng").catch((error) => {
    workerPromise = null;
    throw error;
  });

  return workerPromise;
};

export const warmUpImageInspector = async () => {
  try {
    await getWorker();
    console.log("OCR worker ready");
  } catch (error) {
    console.error(
      `[ERROR] OCR worker warm-up failed: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
};

// The worker handles one job at a time, so serialize access to it.
const recognizeText = (imageBuffer: Buffer): Promise<string> => {
  const job = ocrQueue.then(async () => {
    const worker = await getWorker();
    const result = await worker.recognize(imageBuffer);
    return result.data?.text ?? "";
  });

  ocrQueue = job.catch(() => undefined);
  return job;
};

export const hashImageBuffer = (imageBuffer: Buffer): string =>
  createHash("sha256").update(imageBuffer).digest("hex");

export const inspectImage = async (
  imageBuffer: Buffer,
): Promise<ScamCacheResult & { imageHash: string }> => {
  const imageHash = hashImageBuffer(imageBuffer);

  try {
    const cached = getCachedScamResult(imageHash);
    if (cached) {
      return { ...cached, imageHash };
    }

    const processedBuffer = await sharp(imageBuffer)
      .grayscale()
      .normalize()
      .toBuffer();

    const text = (await recognizeText(processedBuffer)).toLowerCase();
    const matches: string[] = [];

    scamPatterns.forEach((pattern) => {
      const match = pattern.exec(text);
      if (match) {
        matches.push(...match.filter((m) => m != null).map((m) => m.trim()));
      }
    });
    const uniqueMatches = [...new Set(matches)];
    const inspectionResult: ScamCacheResult = {
      hasScamIndicators: uniqueMatches.length >= 2,
      matchedKeywords: uniqueMatches,
      fullText: text,
    };

    saveScamResult(imageHash, inspectionResult);

    return { ...inspectionResult, imageHash };
  } catch (error) {
    console.error(
      `[ERROR] Image inspection failed: ${error instanceof Error ? error.message : String(error)}`,
    );
    return {
      hasScamIndicators: false,
      matchedKeywords: [],
      fullText: "",
      imageHash,
    };
  }
};
