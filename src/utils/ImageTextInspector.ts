import * as Tesseract from "tesseract.js";
import sharp from "sharp";
import { createHash } from "crypto";
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

    const result = await Tesseract.recognize(processedBuffer, "eng");

    const text = (result.data?.text ?? "").toLowerCase();
    const matches: string[] = [];

    scamPatterns.forEach((pattern) => {
      const match = text.match(pattern);
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
