
import { Metadata, GenerationProfile, StyleMemory } from '../types';

export class QuotaExceededInternal extends Error {
  constructor() {
    super("Capacity management signal");
    this.name = "QuotaExceededInternal";
  }
}

// Use REST API directly instead of SDK to avoid v1beta endpoint issues
const API_BASE_URL = 'https://generativelanguage.googleapis.com/v1';

const METADATA_SCHEMA = {
  type: "object",
  properties: {
    title: { type: "string", description: "SEO-optimized title, max 180 chars." },
    description: { type: "string", description: "Detailed descriptive text for stock metadata." },
    keywordsWithScores: {
      type: "array",
      items: {
        type: "object",
        properties: {
          word: { type: "string" },
          score: { type: "string", description: "strong, medium, or weak" },
          specificity: { type: "integer", description: "Score 0-100 for niche accuracy" },
          demand: { type: "integer", description: "Estimated search volume 0-100" },
          platformFit: { type: "integer", description: "Suitability for stock platform indexing 0-100" },
          reason: { type: "string", description: "Short justification for the score" }
        },
        required: ["word", "score", "specificity", "demand", "platformFit"]
      },
      description: "Exactly 50 high-priority keywords. First 10 MUST be primary subjects."
    },
    backupKeywords: {
      type: "array",
      items: { type: "string" },
      description: "20 additional relevant keywords as a suggestion pool."
    },
    category: { type: "string", description: "Industry standard stock category name." },
    rejectionRisks: {
      type: "array",
      items: { type: "string" },
      description: "Potential trademark, quality or policy issues."
    }
  },
  required: ["title", "description", "keywordsWithScores", "backupKeywords", "category", "rejectionRisks"],
};

// Models ordered by free tier access (best first)
// Using v1 API endpoint with correct model names
const AVAILABLE_MODELS = [
  'gemini-1.5-flash',        // Most widely available with good free tier
  'gemini-1.5-flash-latest', // Latest version
  'gemini-1.5-pro',         // Pro version
  'gemini-pro',              // Legacy model
];

export class GeminiService {
  private getBestModel(): string {
    // Return the model with best free tier access
    // Currently gemini-1.5-flash-latest has good free tier limits
    return AVAILABLE_MODELS[0];
  }

  async testKey(apiKey: string): Promise<boolean> {
    // Try models in order until one works using REST API
    for (const model of AVAILABLE_MODELS) {
      try {
        const response = await fetch(`${API_BASE_URL}/models/${model}:generateContent?key=${apiKey}`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            contents: [{
              parts: [{ text: 'test' }]
            }]
          })
        });

        if (response.ok) {
          return true;
        }

        const errorData = await response.json().catch(() => ({}));
        const statusCode = response.status;
        const errMsg = errorData.error?.message || '';

        // If it's a quota/rate limit error, don't try other models
        const isQuotaError = statusCode === 429 || 
          errMsg.toLowerCase().includes('quota') || 
          errMsg.toLowerCase().includes('rate limit') ||
          errMsg.toLowerCase().includes('too many requests');
        
        if (isQuotaError) {
          return false;
        }

        // Log the error for debugging
        console.warn(`Model ${model} failed:`, statusCode, errMsg);
        // Try next model
        continue;
      } catch (e: any) {
        console.warn(`Model ${model} error:`, e.message || e);
        continue;
      }
    }
    // No model worked
    return false;
  }

  async generateMetadata(
    apiKey: string,
    data: { base64?: string, frames?: string[], mimeType: string },
    profile: GenerationProfile,
    styleMemory: StyleMemory,
    isVariant: boolean = false
  ): Promise<Metadata> {
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

    // Try models in order, starting with the one with best free tier access
    let lastError: any = null;
    for (const model of AVAILABLE_MODELS) {
      try {
        const response = await fetch(`${API_BASE_URL}/models/${model}:generateContent?key=${apiKey}`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            contents: [{
              parts: promptParts
            }],
            generationConfig: {
              responseMimeType: "application/json",
              responseSchema: METADATA_SCHEMA
            }
          })
        });

        if (!response.ok) {
          const errorData = await response.json().catch(() => ({}));
          const errMsg = errorData.error?.message || '';
          const statusCode = response.status;
          
          // If it's a rate limit error, try next model
          const isRateLimit = statusCode === 429 || 
            errMsg.includes('429') || 
            errMsg.toLowerCase().includes('quota') || 
            errMsg.toLowerCase().includes('rate limit') ||
            errMsg.toLowerCase().includes('too many requests') ||
            errMsg.toLowerCase().includes('quota exceeded');
          
          // 404 can mean model not found OR quota exceeded (API key disabled)
          const isModelNotFound = statusCode === 404 || 
            errMsg.toLowerCase().includes('not found') || 
            errMsg.toLowerCase().includes('invalid model') ||
            errMsg.toLowerCase().includes('404') ||
            errMsg.toLowerCase().includes('permission denied') ||
            errMsg.toLowerCase().includes('api key not valid');
          
          if (isRateLimit || isModelNotFound) {
            lastError = { message: errMsg, status: statusCode, statusCode };
            console.warn(`Model ${model} unavailable (${isRateLimit ? 'rate limit' : 'not found/disabled'}), trying next...`);
            continue; // Try next model
          }
          
          // Other errors, throw immediately
          throw new Error(errMsg || `HTTP ${statusCode}`);
        }

        const responseData = await response.json();
        const jsonStr = responseData.candidates?.[0]?.content?.parts?.[0]?.text || '{}';
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
        
        // If it's a rate limit error, try next model
        const isRateLimit = statusCode === 429 || 
          errMsg.includes('429') || 
          errMsg.toLowerCase().includes('quota') || 
          errMsg.toLowerCase().includes('rate limit') ||
          errMsg.toLowerCase().includes('too many requests') ||
          errMsg.toLowerCase().includes('quota exceeded');
        
        // 404 can mean model not found OR quota exceeded (API key disabled)
        const isModelNotFound = statusCode === 404 || 
          errMsg.toLowerCase().includes('not found') || 
          errMsg.toLowerCase().includes('invalid model') ||
          errMsg.toLowerCase().includes('404') ||
          errMsg.toLowerCase().includes('permission denied') ||
          errMsg.toLowerCase().includes('api key not valid');
        
        if (isRateLimit || isModelNotFound) {
          lastError = e;
          console.warn(`Model ${model} unavailable (${isRateLimit ? 'rate limit' : 'not found/disabled'}), trying next...`);
          continue; // Try next model
        }
        
        // Other errors, throw immediately
        throw e;
      }
    }
    
    // All models failed
    if (lastError) {
      const errMsg = lastError.message || '';
      const statusCode = lastError.status || lastError.statusCode || '';
      
      // Check for quota/rate limit errors first (including 404 that might be quota-related)
      const isQuotaError = statusCode === 429 || 
          errMsg.includes('429') || 
          errMsg.toLowerCase().includes('quota') || 
          errMsg.toLowerCase().includes('rate limit') ||
          errMsg.toLowerCase().includes('too many requests') ||
          errMsg.toLowerCase().includes('quota exceeded') ||
          errMsg.toLowerCase().includes('billing') ||
          errMsg.toLowerCase().includes('permission denied');
      
      // 404 can also mean quota exceeded if API key was disabled
      const is404Quota = (statusCode === 404 || errMsg.toLowerCase().includes('404')) && 
                         (errMsg.toLowerCase().includes('api key') || 
                          errMsg.toLowerCase().includes('disabled') ||
                          errMsg.toLowerCase().includes('not valid'));
      
      if (isQuotaError || is404Quota) {
        throw new QuotaExceededInternal();
      }
      
      // Check if all models returned 404 - could be quota or access issue
      if (statusCode === 404 || errMsg.toLowerCase().includes('404') || errMsg.toLowerCase().includes('not found')) {
        throw new Error('API key may have reached quota limit or been disabled. Please check your Google Cloud Console for quota status, enable billing if needed, or try resetting your API key quota in Settings.');
      }
      
      throw lastError;
    }
    
    throw new Error('No models available. Please verify your API key has access to Gemini models.');
  }
}

export const geminiService = new GeminiService();
