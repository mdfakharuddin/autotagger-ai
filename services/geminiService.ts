
import { GoogleGenAI, Type } from "@google/genai";
import { Metadata, GenerationProfile, StyleMemory } from '../types';

export class QuotaExceededInternal extends Error {
  constructor() {
    super("Capacity management signal");
    this.name = "QuotaExceededInternal";
  }
}

const METADATA_SCHEMA = {
  type: Type.OBJECT,
  properties: {
    title: { type: Type.STRING, description: "SEO-optimized title, max 180 chars." },
    description: { type: Type.STRING, description: "Detailed descriptive text for stock metadata." },
    keywordsWithScores: {
      type: Type.ARRAY,
      items: {
        type: Type.OBJECT,
        properties: {
          word: { type: Type.STRING },
          score: { type: Type.STRING, description: "strong, medium, or weak" },
          specificity: { type: Type.INTEGER, description: "Score 0-100 for niche accuracy" },
          demand: { type: Type.INTEGER, description: "Estimated search volume 0-100" },
          platformFit: { type: Type.INTEGER, description: "Suitability for stock platform indexing 0-100" },
          reason: { type: Type.STRING, description: "Short justification for the score" }
        },
        required: ["word", "score", "specificity", "demand", "platformFit"]
      },
      description: "Exactly 50 high-priority keywords. First 10 MUST be primary subjects."
    },
    backupKeywords: {
      type: Type.ARRAY,
      items: { type: Type.STRING },
      description: "20 additional relevant keywords as a suggestion pool."
    },
    category: { type: Type.STRING, description: "Industry standard stock category name." },
    rejectionRisks: {
      type: Type.ARRAY,
      items: { type: Type.STRING },
      description: "Potential trademark, quality or policy issues."
    }
  },
  required: ["title", "description", "keywordsWithScores", "backupKeywords", "category", "rejectionRisks"],
};

export class GeminiService {
  async testKey(apiKey: string): Promise<boolean> {
    try {
      const ai = new GoogleGenAI({ apiKey });
      const response = await ai.models.generateContent({
        model: 'gemini-1.5-flash-latest',
        contents: { parts: [{ text: 'test' }] },
      });
      // If we get a response, the key is valid
      return !!response;
    } catch (e) {
      // Key is invalid or there was an error
      return false;
    }
  }

  async generateMetadata(
    apiKey: string,
    data: { base64?: string, frames?: string[], mimeType: string },
    profile: GenerationProfile,
    styleMemory: StyleMemory,
    isVariant: boolean = false
  ): Promise<Metadata> {
    const ai = new GoogleGenAI({ apiKey });
    
    const memoryInstruction = styleMemory.rejectedKeywords.length > 0 
      ? `Avoid these previously rejected terms: [${styleMemory.rejectedKeywords.slice(-20).join(', ')}].`
      : "";

    const defaultInstructions = {
      [GenerationProfile.COMMERCIAL]: "Lifestyle energy, copy space, commercial utility.",
      [GenerationProfile.EDITORIAL]: "Journalistic, location-focused, no subjective adjectives.",
      [GenerationProfile.PRODUCT]: "Minimalist, texture-focused, studio quality.",
      [GenerationProfile.SCIENTIFIC]: "Precise nomenclature, technical accuracy."
    };

    const profileInstruction = styleMemory.customProfilePrompts?.[profile] || defaultInstructions[profile];
    const variantModifier = isVariant ? "Provide a fresh perspective focusing on different details." : "";

    const promptParts: any[] = [
      { text: `Profile: ${profile}. Instruction: ${profileInstruction} ${variantModifier}
      
      Generate a total of 70 keywords (50 primary + 20 backup). 
      The primary 50 must cover: Subject, Environment, Action, Lighting, and Conceptual Mood.
      The backup 20 should offer alternative synonyms or secondary associations.
      
      ${memoryInstruction}` }
    ];

    if (data.frames && data.frames.length > 0) {
      data.frames.forEach((f) => {
        promptParts.push({ inlineData: { data: f, mimeType: 'image/jpeg' } });
      });
      promptParts.push({ text: "The frames are from one video. Synthesize into one coherent metadata set." });
    } else if (data.base64) {
      promptParts.push({ inlineData: { data: data.base64, mimeType: data.mimeType } });
    }

    try {
      const response = await ai.models.generateContent({
        model: 'gemini-1.5-flash-latest',
        contents: { parts: promptParts },
        config: {
          responseMimeType: "application/json",
          responseSchema: METADATA_SCHEMA
        }
      });

      const jsonStr = response.text || '{}';
      const json = JSON.parse(jsonStr);
      const keywords = (json.keywordsWithScores || []).map((k: any) => k.word.toLowerCase().trim()).filter(Boolean);
      const backupKeywords = (json.backupKeywords || []).map((k: string) => k.toLowerCase().trim()).filter(Boolean);

      return {
        title: json.title || "Untitled Stock Asset",
        description: json.description || "",
        keywords: keywords.slice(0, 50),
        backupKeywords: backupKeywords,
        keywordScores: json.keywordsWithScores || [],
        rejectionRisks: json.rejectionRisks || [],
        category: json.category || "General",
        releases: ""
      };
    } catch (e: any) {
      const errMsg = e.message || '';
      const statusCode = e.status || e.statusCode || '';
      // Check for 429 rate limit errors
      if (statusCode === 429 || 
          errMsg.includes('429') || 
          errMsg.toLowerCase().includes('quota') || 
          errMsg.toLowerCase().includes('rate limit') ||
          errMsg.toLowerCase().includes('too many requests')) {
        throw new QuotaExceededInternal();
      }
      throw e;
    }
  }
}

export const geminiService = new GeminiService();
