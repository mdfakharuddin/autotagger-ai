
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
// Note: Model names may differ between v1 and v1beta APIs
// Try listing models first, then fall back to known working names
// gemini-2.5-flash doesn't exist - using correct model names
const AVAILABLE_MODELS = [
  'gemini-1.5-flash',        // Most widely available
  'gemini-1.5-flash-001',    // Specific version
  'gemini-1.5-pro',          // Pro version
  'gemini-1.5-pro-001',      // Specific pro version
  'gemini-pro',              // Legacy model
];

export class GeminiService {
  private modelCache: Map<string, { models: string[]; timestamp: number }> = new Map();
  private readonly CACHE_DURATION = 5 * 60 * 1000; // 5 minutes

  private getBestModel(): string {
    // Return the model with best free tier access
    // Currently gemini-1.5-flash-latest has good free tier limits
    return AVAILABLE_MODELS[0];
  }

  async listAvailableModels(apiKey: string): Promise<string[]> {
    // Check cache first to avoid repeated API calls
    const cacheKey = apiKey.trim();
    const cached = this.modelCache.get(cacheKey);
    const now = Date.now();
    
    if (cached && (now - cached.timestamp) < this.CACHE_DURATION) {
      return cached.models;
    }
    try {
      const url = new URL(`${API_BASE_URL}/models`);
      url.searchParams.set('key', apiKey.trim());
      
      const response = await fetch(url.toString());
      if (response.ok) {
        const data = await response.json();
        const models = (data.models || [])
          .map((m: any) => m.name?.replace('models/', '') || m.name)
          .filter(Boolean)
          // Filter out invalid/non-existent models
          .filter((name: string) => {
            // Only allow known valid model patterns
            return name.includes('gemini-1.5') || 
                   name.includes('gemini-pro') || 
                   name.includes('gemini-1.0');
            // Explicitly exclude invalid models like gemini-2.5-flash
          });
        // Cache the results
        this.modelCache.set(cacheKey, { models, timestamp: now });
        return models;
      }
    } catch (e) {
      console.warn('Failed to list models:', e);
    }
    return [];
  }

  async testKey(apiKey: string): Promise<boolean> {
    // Validate API key format
    const trimmedKey = apiKey.trim();
    if (!trimmedKey || trimmedKey.length < 20) {
      console.warn('API key appears to be invalid (too short or empty)');
      return false;
    }

    // First, try to list available models
    let availableModels: string[] = [];
    try {
      availableModels = await this.listAvailableModels(trimmedKey);
    } catch (e) {
      // If listing fails, use fallback models
    }
    const modelsToTry = availableModels.length > 0 ? availableModels : AVAILABLE_MODELS;

    // Try models in order until one works using REST API
    for (const model of modelsToTry) {
      try {
        // Remove 'models/' prefix if present
        const modelName = model.replace(/^models\//, '');
        // Use query parameter for API key (Gemini API requires it this way)
        const url = new URL(`${API_BASE_URL}/models/${modelName}:generateContent`);
        url.searchParams.set('key', trimmedKey);
        
        const response = await fetch(url.toString(), {
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

        // If it's an invalid API key error, don't try other models
        if (statusCode === 400 && (errMsg.toLowerCase().includes('api key') || errMsg.toLowerCase().includes('invalid'))) {
          console.warn(`Invalid API key:`, errMsg);
          return false;
        }

        // Log the error for debugging
        console.warn(`Model ${modelName} failed:`, statusCode, errMsg);
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
    isVariant: boolean = false,
    preferredModel?: string
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
      { text: `You are an expert stock photography metadata generator. Analyze this image/video and generate comprehensive, SEO-optimized metadata.

Profile: ${profile}
Style Guide: ${profileInstruction}
${variantModifier}

REQUIREMENTS:
1. Title: Create a compelling, SEO-optimized title (max 180 characters) that accurately describes the content and includes key search terms.

2. Description: Write a detailed, professional description (2-4 sentences) that:
   - Clearly describes what's in the image/video
   - Includes relevant context, setting, and mood
   - Uses natural language that's both descriptive and keyword-rich
   - Avoids generic phrases, be specific

3. Keywords: Generate exactly 70 keywords total:
   - 50 PRIMARY keywords covering: Main Subject, Secondary Subjects, Environment/Setting, Action/Activity, Lighting Conditions, Time of Day, Mood/Emotion, Style/Aesthetic, Colors, Composition Elements
   - 20 BACKUP keywords: Alternative terms, synonyms, related concepts, and secondary associations
   - Prioritize specific, searchable terms over generic ones
   - Include both broad and niche keywords

4. Category: Assign the most appropriate stock photography category (e.g., "Lifestyle", "Business", "Nature", "Technology", etc.)

5. Rejection Risks: Identify any potential issues such as:
   - Trademarked items or logos
   - Recognizable people without releases
   - Copyright concerns
   - Quality issues
   - Policy violations

${memoryInstruction}

Generate comprehensive metadata that maximizes discoverability while maintaining accuracy and professionalism.` }
    ];

    if (data.frames && data.frames.length > 0) {
      // Use only the first frame to reduce API payload - single frame is sufficient
      promptParts.push({ inlineData: { data: data.frames[0], mimeType: 'image/jpeg' } });
      promptParts.push({ text: "This is a representative frame from a video. Generate comprehensive metadata that covers the entire video content." });
    } else if (data.base64) {
      promptParts.push({ inlineData: { data: data.base64, mimeType: data.mimeType } });
    }

    // Try models in order, starting with the one with best free tier access
    let lastError: any = null;
    const trimmedKey = apiKey.trim();
    
    // First, try to get available models for this API key
    let availableModels: string[] = [];
    try {
      availableModels = await this.listAvailableModels(trimmedKey);
    } catch (e) {
      // If listing fails, use fallback models
    }
    
    // If user has selected a specific model (not 'auto'), prioritize it
    let modelsToTry: string[] = [];
    if (preferredModel && preferredModel !== 'auto') {
      // User selected a specific model - try it first, then fallback
      modelsToTry = [preferredModel, ...(availableModels.length > 0 ? availableModels : AVAILABLE_MODELS)];
      // Remove duplicates
      modelsToTry = [...new Set(modelsToTry)];
    } else {
      // Auto mode - use available models or fallback
      modelsToTry = availableModels.length > 0 ? availableModels : AVAILABLE_MODELS;
    }
    
    for (const model of modelsToTry) {
      try {
        // Remove 'models/' prefix if present
        const modelName = model.replace(/^models\//, '');
        // Use URL object to properly construct the query string
        const url = new URL(`${API_BASE_URL}/models/${modelName}:generateContent`);
        url.searchParams.set('key', trimmedKey);
        
        const response = await fetch(url.toString(), {
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
          const errMsg = errorData.error?.message || errorData.error?.message || JSON.stringify(errorData);
          const statusCode = response.status;
          
          // Log the actual error for debugging
          console.error(`Gemini API Error [${statusCode}]:`, {
            model: modelName,
            message: errMsg,
            fullError: errorData
          });
          
          // Check for fundamental API issues that will affect all models
          const lowerMsg = errMsg.toLowerCase();
          const isApiKeyIssue = statusCode === 400 && (
            lowerMsg.includes('api key') ||
            lowerMsg.includes('invalid api key') ||
            lowerMsg.includes('api key not valid') ||
            lowerMsg.includes('authentication') ||
            lowerMsg.includes('permission denied') ||
            lowerMsg.includes('invalid') && lowerMsg.includes('key')
          );
          
          const isBillingIssue = statusCode === 403 || 
            lowerMsg.includes('billing') ||
            lowerMsg.includes('quota exceeded') ||
            lowerMsg.includes('payment required');
          
          // If it's a fundamental API issue (key, billing), don't try other models
          if (isApiKeyIssue || isBillingIssue) {
            throw new Error(isApiKeyIssue 
              ? 'Invalid API key. Please check your API key in Settings and ensure it has access to the Generative Language API.' 
              : 'Billing or quota issue. Please check your Google Cloud Console.');
          }
          
          // If it's a rate limit error, try next model
          const isRateLimit = statusCode === 429 || 
            errMsg.includes('429') || 
            lowerMsg.includes('rate limit') ||
            lowerMsg.includes('too many requests');
          
          // 400 Bad Request - treat as API key issue if it's the first model
          // Most 400 errors from Gemini API are API key related, not model-specific
          const modelIndex = modelsToTry.indexOf(model);
          if (statusCode === 400) {
            // If first model returns 400, assume it's an API key issue and stop
            if (modelIndex === 0) {
              throw new Error(`Invalid API key or request. ${errMsg || 'Please check your API key in Settings and ensure it has access to Gemini models.'}`);
            }
            // If subsequent models also return 400, definitely an API key issue
            throw new Error(`API key issue detected. ${errMsg || 'Please verify your API key in Settings.'}`);
          }
          
          // 404 can mean model not found - try next model only if it's clearly model-specific
          const isModelNotFound = statusCode === 404 && 
            !lowerMsg.includes('api key') &&
            !lowerMsg.includes('permission');
          
          if (isRateLimit) {
            lastError = { message: errMsg, status: statusCode, statusCode };
            console.warn(`Model ${modelName} rate limited, trying next...`);
            continue; // Try next model for rate limits
          }
          
          if (isModelNotFound) {
            // Only try next model if it's clearly a model not found issue
            if (modelIndex < modelsToTry.length - 1) {
              lastError = { message: errMsg, status: statusCode, statusCode };
              console.warn(`Model ${modelName} not found, trying next model...`);
              continue;
            } else {
              throw new Error(`Model not available. ${errMsg || 'Please check your API key and Google Cloud Console settings.'}`);
            }
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
      
      // Check for quota/rate limit errors first
      const isQuotaError = statusCode === 429 || 
          errMsg.includes('429') || 
          errMsg.toLowerCase().includes('quota') || 
          errMsg.toLowerCase().includes('rate limit') ||
          errMsg.toLowerCase().includes('too many requests') ||
          errMsg.toLowerCase().includes('quota exceeded');
      
      if (isQuotaError) {
        throw new QuotaExceededInternal();
      }
      
      // Check for API key or billing issues
      const isApiKeyIssue = statusCode === 400 && (
        errMsg.toLowerCase().includes('api key') ||
        errMsg.toLowerCase().includes('invalid api key') ||
        errMsg.toLowerCase().includes('authentication')
      );
      
      const isBillingIssue = statusCode === 403 || 
        errMsg.toLowerCase().includes('billing') ||
        errMsg.toLowerCase().includes('payment required');
      
      if (isApiKeyIssue) {
        throw new Error('Invalid API key. Please verify your API key in Settings and ensure it has access to the Generative Language API.');
      }
      
      if (isBillingIssue) {
        throw new Error('Billing or quota issue. Please check your Google Cloud Console - billing may need to be enabled or quota limits may have been reached.');
      }
      
      // Generic error with helpful message
      throw new Error(`Unable to process request: ${errMsg || 'Please check your API key and Google Cloud Console settings.'}`);
    }
    
    throw new Error('No models available. Please verify your API key has access to Gemini models in Google Cloud Console.');
  }
}

export const geminiService = new GeminiService();
