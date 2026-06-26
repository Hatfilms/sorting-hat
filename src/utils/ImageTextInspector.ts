import * as Tesseract from 'tesseract.js';
import sharp from 'sharp';
import { createHash } from 'crypto';
import { getCachedScamResult, saveScamResult, ScamCacheResult } from './sqlite';

const scamPatterns = [
  /\b(crypto\s+casi?no|online\s+gambling)\b/i,
  /\b(giveaway|free\s+money|win\s+prizes|claim\s+reward)\b/i,
  /\$[\d,]+\b|\b(free\s+\$\d+|earn\s+\$\d+)/i,
  /\b(bonus|reward|incentive|prize)\b/i,
  /\b(promo\s*code|discount\s*code|voucher|coupon)\b/i,
  /\b(register|sign\s+up|join\s+now|create\s+account)\b/i,
  /\b(limited\s+time|exclusive\s+offer|act\s+fast|don\'t\s+miss)/i,
  /\b(instantly|immediately|right\s+away|quick\s+access)\b/i,
  /\b(no\s+fees|risk-free|guaranteed|secret\s+method)\b/i,
  /\b(bitcoin|ethereum|crypto|wallet|deposit)\b/i,
];

export const hashImageBuffer = (imageBuffer: Buffer): string =>
  createHash('sha256').update(imageBuffer).digest('hex');

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

    const result = await Tesseract.recognize(processedBuffer, 'eng');

    const text = (result.data?.text ?? '').toLowerCase();
    const matches: string[] = [];

    scamPatterns.forEach((pattern) => {
      const match = text.match(pattern);
      if (match) {
        matches.push(...match.filter((m) => m != null).map((m) => m.trim()));
      }
    });

    const inspectionResult: ScamCacheResult = {
      hasScamIndicators: matches.length > 0,
      matchedKeywords: [...new Set(matches)],
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
      fullText: '',
      imageHash,
    };
  }
};
