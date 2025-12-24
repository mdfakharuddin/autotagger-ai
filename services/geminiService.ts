
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
// Note: These are fallback models if ListModels API fails
// The app will always try to use models from ListModels API first
const AVAILABLE_MODELS = [
  'gemini-2.5-flash',        // Latest flash model (5 RPM free tier)
  'gemini-3-flash',          // Latest model (5 RPM free tier)
  'gemini-2.5-flash-lite',   // Lite version (10 RPM free tier)
  'gemini-1.5-flash',        // Older flash model
  'gemini-1.5-flash-001',    // Specific version
  'gemini-1.5-pro',          // Pro version
  'gemini-1.5-pro-001',      // Specific pro version
  'gemini-pro',              // Legacy model
];

export class GeminiService {
  private modelCache: Map<string, { models: string[]; timestamp: number }> = new Map();
  private readonly CACHE_DURATION = 5 * 60 * 1000; // 5 minutes

  private extractJsonFromResponse(text: string): string {
    if (!text || typeof text !== 'string') {
      return '{}';
    }
    
    // Remove markdown code block markers if present
    let cleaned = text.trim();
    
    // Remove ```json or ``` at the start (handle multiple newlines)
    cleaned = cleaned.replace(/^```(?:json)?\s*\n?/i, '');
    // Remove ``` at the end (handle multiple newlines)
    cleaned = cleaned.replace(/\n?\s*```$/i, '');
    
    // Try to extract JSON from markdown code blocks (greedy match to get full JSON)
    const codeBlockMatch = cleaned.match(/```(?:json)?\s*(\{[\s\S]*\})\s*```/);
    if (codeBlockMatch && codeBlockMatch[1]) {
      return codeBlockMatch[1].trim();
    }
    
    // Try to find JSON object in the text (find the first { and last })
    // Use a more robust approach: find balanced braces
    const firstBrace = cleaned.indexOf('{');
    if (firstBrace === -1) {
      return cleaned; // No JSON found, return as-is
    }
    
    // Find the matching closing brace by counting braces
    let braceCount = 0;
    let lastBrace = -1;
    for (let i = firstBrace; i < cleaned.length; i++) {
      if (cleaned[i] === '{') {
        braceCount++;
      } else if (cleaned[i] === '}') {
        braceCount--;
        if (braceCount === 0) {
          lastBrace = i;
          break;
        }
      }
    }
    
    if (lastBrace !== -1 && lastBrace > firstBrace) {
      const jsonCandidate = cleaned.substring(firstBrace, lastBrace + 1).trim();
      // Validate it looks like JSON
      if (jsonCandidate.startsWith('{') && jsonCandidate.endsWith('}')) {
        return jsonCandidate;
      }
    }
    
    // Fallback: try simple regex match (greedy to get full object)
    const jsonMatch = cleaned.match(/\{[\s\S]*\}/);
    if (jsonMatch && jsonMatch[0]) {
      const candidate = jsonMatch[0].trim();
      // Quick validation: should start and end with braces
      if (candidate.startsWith('{') && candidate.endsWith('}')) {
        return candidate;
      }
    }
    
    // Last resort: if text starts with {, try to use it
    if (cleaned.trim().startsWith('{')) {
      return cleaned.trim();
    }
    
    // Return empty object if no JSON found (better than invalid JSON)
    return '{}';
  }

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
          .filter((m: any) => {
            // Only include models that support generateContent
            const supportedMethods = m.supportedGenerationMethods || [];
            return supportedMethods.includes('generateContent');
          })
          .map((m: any) => {
            // Extract model name, removing 'models/' prefix if present
            const name = m.name?.replace(/^models\//, '') || m.name;
            return name;
          })
          .filter(Boolean)
          // Filter to only Gemini models
          .filter((name: string) => {
            return name.includes('gemini');
          });
        
        console.log('Available models for API key:', models);
        
        // Cache the results
        this.modelCache.set(cacheKey, { models, timestamp: now });
        return models;
      } else {
        const errorData = await response.json().catch(() => ({}));
        console.error('Failed to list models:', response.status, errorData);
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
      console.warn('Failed to list models during key test:', e);
    }
    
    // If no models are available, the API key likely doesn't have access
    if (availableModels.length === 0) {
      console.warn('No models available for this API key');
      return false;
    }
    
    const modelsToTry = availableModels;

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

CRITICAL: You MUST respond with ONLY valid JSON. Do NOT include:
- Markdown code blocks (no triple backticks)
- Explanatory text before or after the JSON
- Any text outside the JSON object

The response must be a single, valid JSON object matching this exact structure:
{
  "title": "string",
  "description": "string",
  "keywordsWithScores": [{"word": "string", "score": "string", "specificity": number, "demand": number, "platformFit": number, "reason": "string"}, ...],
  "backupKeywords": ["string", ...],
  "category": "string",
  "rejectionRisks": ["string", ...]
}

Start your response with an opening brace and end with a closing brace. Return ONLY the JSON object, nothing else.` }
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
      console.warn('Failed to list available models:', e);
    }
    
    // If no models are available from the API, we can't proceed
    if (availableModels.length === 0) {
      throw new Error('No models available for this API key. Please check that your API key has access to Gemini models in Google Cloud Console.');
    }
    
    // If user has selected a specific model (not 'auto'), prioritize it
    let modelsToTry: string[] = [];
    if (preferredModel && preferredModel !== 'auto') {
      // Check if the preferred model is in the available models list
      const preferredModelName = preferredModel.replace(/^models\//, '');
      if (availableModels.includes(preferredModelName)) {
        modelsToTry = [preferredModelName];
      } else {
        // Preferred model not available, use available models
        console.warn(`Preferred model ${preferredModelName} not available. Using available models instead.`);
        modelsToTry = availableModels;
      }
    } else {
      // Auto mode - prioritize models with higher rate limits
      // Sort models: prefer -lite versions (higher limits), then newer versions
      modelsToTry = availableModels.sort((a, b) => {
        // Prioritize -lite versions (usually have higher rate limits)
        const aIsLite = a.includes('-lite');
        const bIsLite = b.includes('-lite');
        if (aIsLite && !bIsLite) return -1;
        if (!aIsLite && bIsLite) return 1;
        // Then prioritize newer versions (2.5, 3.0 over 1.5)
        const aVersion = a.match(/gemini-([\d.]+)/)?.[1] || '0';
        const bVersion = b.match(/gemini-([\d.]+)/)?.[1] || '0';
        return parseFloat(bVersion) - parseFloat(aVersion);
      });
    }
    
    for (const model of modelsToTry) {
      try {
        // Remove 'models/' prefix if present
        const modelName = model.replace(/^models\//, '');
        // Use URL object to properly construct the query string
        const url = new URL(`${API_BASE_URL}/models/${modelName}:generateContent`);
        url.searchParams.set('key', trimmedKey);
        
        // Some models (like gemini-2.5-flash-lite) don't support generationConfig at all
        // Start with a minimal request and add config only if needed
        let requestBody: any = {
          contents: [{
            parts: promptParts
          }]
        };
        
        // Only add generationConfig for models that likely support it
        // Newer models (2.5, 3.0) may not support responseMimeType
        // Try without config first, add it only for older models
        if (!modelName.includes('2.5') && !modelName.includes('3.0') && !modelName.includes('2.0')) {
          requestBody.generationConfig = {
            responseMimeType: "application/json"
          };
        }
        
        const response = await fetch(url.toString(), {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
          },
          body: JSON.stringify(requestBody)
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
          
          // Check if it's a generationConfig-related error - retry without config
          const lowerMsg = errMsg.toLowerCase();
          const isConfigError = statusCode === 400 && (
            lowerMsg.includes('responsemimetype') ||
            lowerMsg.includes('response_mime_type') ||
            lowerMsg.includes('generation_config') ||
            lowerMsg.includes('unknown name') ||
            lowerMsg.includes('cannot find field')
          );
          
          if (isConfigError && requestBody.generationConfig) {
            // Retry without generationConfig for this model
            console.warn(`Model ${modelName} doesn't support generationConfig, retrying without it...`);
            const retryBody = {
              contents: [{
                parts: promptParts
              }]
              // No generationConfig
            };
            
            try {
              const retryResponse = await fetch(url.toString(), {
                method: 'POST',
                headers: {
                  'Content-Type': 'application/json',
                },
                body: JSON.stringify(retryBody)
              });
              
              if (retryResponse.ok) {
                // Success without config - parse JSON from text response
                const retryData = await retryResponse.json();
                let jsonStr = retryData.candidates?.[0]?.content?.parts?.[0]?.text || '{}';
                
                // Extract JSON from markdown code blocks if present
                jsonStr = this.extractJsonFromResponse(jsonStr);
                
                let json: any;
                try {
                  json = JSON.parse(jsonStr);
                } catch (parseError) {
                  console.error('Failed to parse JSON response:', parseError, jsonStr);
                  // Try to extract JSON object from the text
                  const jsonMatch = jsonStr.match(/\{[\s\S]*\}/);
                  if (jsonMatch) {
                    try {
                      json = JSON.parse(jsonMatch[0]);
                    } catch (e) {
                      throw new Error('Invalid JSON response from API. Please try again.');
                    }
                  } else {
                    throw new Error('Invalid JSON response from API. Please try again.');
                  }
                }
                
                const keywords = (json.keywordsWithScores || []).map((k: any) => {
                  // Handle both object format {word: "..."} and string format
                  const word = typeof k === 'string' ? k : (k.word || k);
                  return word?.toLowerCase().trim();
                }).filter(Boolean);
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
              }
            } catch (retryError) {
              console.warn('Retry without generationConfig also failed:', retryError);
              // Continue with normal error handling below
            }
          }
          
          // Check for fundamental API issues that will affect all models
          const isApiKeyIssue = statusCode === 400 && !isConfigError && (
            lowerMsg.includes('api key') ||
            lowerMsg.includes('invalid api key') ||
            lowerMsg.includes('api key not valid') ||
            lowerMsg.includes('authentication') ||
            lowerMsg.includes('permission denied') ||
            (lowerMsg.includes('invalid') && lowerMsg.includes('key'))
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
          // Exclude config errors from this check
          const modelIndex = modelsToTry.indexOf(model);
          if (statusCode === 400 && !isConfigError) {
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
        let jsonStr = responseData.candidates?.[0]?.content?.parts?.[0]?.text || '{}';
        
        // Extract JSON from markdown code blocks if present
        jsonStr = this.extractJsonFromResponse(jsonStr);
        
        let json: any;
        try {
          json = JSON.parse(jsonStr);
        } catch (parseError) {
          console.error('Failed to parse JSON response:', parseError, 'Raw text:', jsonStr.substring(0, 200));
          // Try to extract JSON object from the text as fallback
          const jsonMatch = jsonStr.match(/\{[\s\S]*\}/);
          if (jsonMatch && jsonMatch[0]) {
            try {
              json = JSON.parse(jsonMatch[0]);
            } catch (e) {
              throw new Error('Invalid JSON response from API. The model returned text instead of JSON. Please try again.');
            }
          } else {
            throw new Error('Invalid JSON response from API. The model returned text instead of JSON. Please try again.');
          }
        }
        
        // Validate required fields exist
        if (!json.title || !json.description || !Array.isArray(json.keywordsWithScores)) {
          console.warn('JSON response missing required fields:', json);
          // Try to continue with what we have, but log the issue
        }
        
        const keywords = (json.keywordsWithScores || []).map((k: any) => {
          // Handle both object format {word: "..."} and string format
          const word = typeof k === 'string' ? k : (k.word || k);
          return word?.toLowerCase().trim();
        }).filter(Boolean);
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
