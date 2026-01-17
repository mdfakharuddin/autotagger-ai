
import { Metadata, GenerationProfile, StyleMemory, AIProvider } from '../types';

export class QuotaExceededInternal extends Error {
  constructor() {
    super("Capacity management signal");
    this.name = "QuotaExceededInternal";
  }
}

// Use REST API directly instead of SDK to avoid v1beta endpoint issues
const API_BASE_URL = 'https://generativelanguage.googleapis.com/v1';

// Simplified schema - only title and keywords needed
const METADATA_SCHEMA = {
  type: "object",
  properties: {
    title: { type: "string", description: "SEO-optimized title, max 180 chars." },
    keywords: {
      type: "array",
      items: { type: "string" },
      description: "50 relevant keywords for stock photography search."
    }
  },
  required: ["title", "keywords"],
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

  async testApiModelCombination(apiKey: string, model: string): Promise<boolean> {
    try {
      const modelName = model.replace(/^models\//, '');
      const url = new URL(`${API_BASE_URL}/models/${modelName}:generateContent`);
      url.searchParams.set('key', apiKey.trim());
      
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

      // If it's a quota/rate limit error, this combination is temporarily unavailable
      const isQuotaError = statusCode === 429 || 
        errMsg.toLowerCase().includes('quota') || 
        errMsg.toLowerCase().includes('rate limit') ||
        errMsg.toLowerCase().includes('too many requests');
      
      if (isQuotaError) {
        return false; // Rate limited, but combination might work later
      }

      // If it's an invalid API key error, this combination won't work
      if (statusCode === 400 && (errMsg.toLowerCase().includes('api key') || errMsg.toLowerCase().includes('invalid'))) {
        return false;
      }

      // Other errors might be temporary
      return false;
    } catch (e: any) {
      return false;
    }
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
      { text: `Analyze this image/video and generate SEO metadata. Profile: ${profile}. ${profileInstruction} ${variantModifier}

Generate ONLY:
1. Title: SEO-optimized title (max 180 chars) describing the content
2. Keywords: 50 relevant searchable keywords as a simple array

${memoryInstruction}

CRITICAL: Respond with ONLY valid JSON, no markdown, no explanations. Structure:
{
  "title": "string",
  "keywords": ["keyword1", "keyword2", ...]
}

Return ONLY the JSON object.` }
    ];

    if (data.frames && data.frames.length > 0) {
      // Use only the first frame to reduce API payload - single frame is sufficient
      promptParts.push({ inlineData: { data: data.frames[0], mimeType: 'image/jpeg' } });
      promptParts.push({ text: "This is a representative frame from a video. Generate comprehensive metadata that covers the entire video content." });
    } else if (data.base64) {
      promptParts.push({ inlineData: { data: data.base64, mimeType: data.mimeType } });
    }

    // Check for Local Proxy Provider
    if (styleMemory.selectedProvider === AIProvider.LOCAL_PROXY) {
      try {
        const payload: any = { prompt: promptParts[0].text }; // Use the main text prompt
        
        // Handle Image Data for Proxy
        if (data.base64) {
           payload.image = data.base64;
        } else if (data.frames && data.frames.length > 0) {
           // If video frames, take the first one
           payload.image = data.frames[0];
        }

        const response = await fetch('/api/ask', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
          },
          body: JSON.stringify(payload)
        });

        if (!response.ok) {
          throw new Error(`Proxy error: ${response.status} ${response.statusText}`);
        }

        const proxyData = await response.json();
        
        if (!proxyData.success) {
          throw new Error(proxyData.error || 'Unknown proxy error');
        }

        // Parse the Markdown/JSON response from the proxy
        let jsonStr = proxyData.response;
        jsonStr = this.extractJsonFromResponse(jsonStr);
        let json: any;
        
        try {
            json = JSON.parse(jsonStr);
        } catch (e) {
            console.error("Failed to parse JSON from proxy response", e);
            throw new Error("Invalid JSON from proxy");
        }

        // Validate required fields exist
        // Use default keywords if missing to avoid breaking app
        const keywords = (json.keywords || []).map((k: any) => {
          const word = typeof k === 'string' ? k : (k.word || k);
          return word?.toLowerCase().trim();
        }).filter(Boolean);

        return {
          title: json.title || "Untitled via Proxy",
          description: "",
          keywords: keywords.slice(0, 50),
          backupKeywords: [],
          keywordScores: [],
          rejectionRisks: [],
          category: "General",
          releases: ""
        };

      } catch (e: any) {
        console.error("Proxy generation failed:", e);
        throw e;
      }
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
                } catch (parseError: any) {
                  console.error('Failed to parse JSON response (retry path):', parseError.message, 'Position:', parseError.message.match(/position (\d+)/)?.[1] || 'unknown', 'Text length:', jsonStr.length);
                  
                  // Check if JSON might be truncated
                  if (jsonStr.length > 100000) {
                    console.warn('Large JSON response detected in retry, attempting to fix truncation...');
                    let fixedJson = jsonStr.trim();
                    
                    if (!fixedJson.endsWith('}')) {
                      const openBraces = (fixedJson.match(/\{/g) || []).length;
                      const closeBraces = (fixedJson.match(/\}/g) || []).length;
                      const openBrackets = (fixedJson.match(/\[/g) || []).length;
                      const closeBrackets = (fixedJson.match(/\]/g) || []).length;
                      
                      for (let i = 0; i < (openBrackets - closeBrackets); i++) {
                        fixedJson += ']';
                      }
                      for (let i = 0; i < (openBraces - closeBraces); i++) {
                        fixedJson += '}';
                      }
                      
                      try {
                        json = JSON.parse(fixedJson);
                        console.log('Successfully fixed truncated JSON in retry path');
                      } catch (e) {
                        // Continue to extraction fallback
                      }
                    }
                  }
                  
                  // If still not parsed, try extraction
                  if (!json) {
                    const jsonMatch = jsonStr.match(/\{[\s\S]*\}/);
                    if (jsonMatch && jsonMatch[0]) {
                      try {
                        json = JSON.parse(jsonMatch[0]);
                      } catch (e) {
                        throw new Error(`Invalid JSON response from API. The response appears to be truncated or malformed (${jsonStr.length} chars). Please try again.`);
                      }
                    } else {
                      throw new Error(`Invalid JSON response from API. Failed to parse after multiple attempts. Response length: ${jsonStr.length} chars.`);
                    }
                  }
                }
                
                // Validate required fields exist
                if (!json.title || !json.description || !Array.isArray(json.keywordsWithScores)) {
                  console.warn('JSON response missing required fields (retry path):', {
                    hasTitle: !!json.title,
                    hasDescription: !!json.description,
                    hasKeywords: Array.isArray(json.keywordsWithScores),
                    keys: Object.keys(json)
                  });
                }
                
                // Simplified: just extract keywords array
                const keywords = (json.keywords || []).map((k: any) => {
                  const word = typeof k === 'string' ? k : (k.word || k);
                  return word?.toLowerCase().trim();
                }).filter(Boolean);

                return {
                  title: json.title || "Untitled Stock Asset",
                  description: "",
                  keywords: keywords.slice(0, 50),
                  backupKeywords: [],
                  keywordScores: [],
                  rejectionRisks: [],
                  category: "General",
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
          
          // If it's a rate limit error, extract retry-after time and wait
          const isRateLimit = statusCode === 429 || 
            errMsg.includes('429') || 
            lowerMsg.includes('rate limit') ||
            lowerMsg.includes('too many requests') ||
            lowerMsg.includes('exceeded your current quota');
          
          if (isRateLimit) {
            // Extract retry-after time from error message (e.g., "Please retry in 8.431675204s")
            let retryAfterSeconds = 60; // Default 60 seconds (more conservative)
            // Try multiple regex patterns to catch different formats
            const retryPatterns = [
              /retry in ([\d.]+)s/i,
              /retry.*?([\d.]+)\s*s/i,
              /wait.*?([\d.]+)\s*s/i,
              /([\d.]+)\s*seconds?/i
            ];
            
            for (const pattern of retryPatterns) {
              const retryMatch = errMsg.match(pattern);
              if (retryMatch && retryMatch[1]) {
                retryAfterSeconds = Math.ceil(parseFloat(retryMatch[1])) + 5; // Add 5 seconds buffer
                console.log(`Extracted retry time: ${retryMatch[1]}s, waiting ${retryAfterSeconds}s`);
                break;
              }
            }
            
            // Also check Retry-After header if available
            const retryAfterHeader = response.headers.get('Retry-After');
            if (retryAfterHeader) {
              const headerSeconds = parseInt(retryAfterHeader) || 60;
              retryAfterSeconds = Math.max(retryAfterSeconds, headerSeconds);
            }
            
            lastError = { message: errMsg, status: statusCode, statusCode };
            console.warn(`Model ${modelName} rate limited. Waiting ${retryAfterSeconds}s...`);
            
            // If this is a -lite model and we've hit rate limit, try non-lite models instead
            const modelIndex = modelsToTry.indexOf(model);
            const isLiteModel = modelName.includes('-lite');
            
            if (isLiteModel && modelIndex < modelsToTry.length - 1) {
              // Skip remaining -lite models and try non-lite models
              const remainingModels = modelsToTry.slice(modelIndex + 1).filter(m => !m.includes('-lite'));
              if (remainingModels.length > 0) {
                console.warn(`Skipping -lite models due to rate limit. Trying non-lite models: ${remainingModels.join(', ')}`);
                // Wait a bit before trying non-lite models
                await new Promise(resolve => setTimeout(resolve, Math.min(retryAfterSeconds, 30) * 1000));
                // Update modelsToTry to only include non-lite models
                modelsToTry = remainingModels;
                continue; // Restart loop with non-lite models
              }
            }
            
            // If we've tried multiple models or this is the last one, wait full time and throw
            if (modelIndex >= 2 || modelIndex >= modelsToTry.length - 1) {
              console.warn(`Multiple models rate limited. Waiting ${retryAfterSeconds}s before giving up...`);
              await new Promise(resolve => setTimeout(resolve, retryAfterSeconds * 1000));
              throw new QuotaExceededInternal();
            }
            
            // Wait before trying next model
            await new Promise(resolve => setTimeout(resolve, retryAfterSeconds * 1000));
            continue; // Try next model after delay
          }
          
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
        } catch (parseError: any) {
          console.error('Failed to parse JSON response:', parseError.message, 'Position:', parseError.message.match(/position (\d+)/)?.[1] || 'unknown', 'Text length:', jsonStr.length);
          
          // Check if JSON might be truncated (common with large responses)
          if (jsonStr.length > 100000) {
            console.warn('Large JSON response detected, attempting to fix truncation...');
            // Try to fix common truncation issues
            let fixedJson = jsonStr.trim();
            
            // If it ends abruptly, try to close arrays/objects
            if (!fixedJson.endsWith('}')) {
              // Count unclosed braces/brackets
              const openBraces = (fixedJson.match(/\{/g) || []).length;
              const closeBraces = (fixedJson.match(/\}/g) || []).length;
              const openBrackets = (fixedJson.match(/\[/g) || []).length;
              const closeBrackets = (fixedJson.match(/\]/g) || []).length;
              
              // Close unclosed arrays first, then objects
              for (let i = 0; i < (openBrackets - closeBrackets); i++) {
                fixedJson += ']';
              }
              for (let i = 0; i < (openBraces - closeBraces); i++) {
                fixedJson += '}';
              }
              
              try {
                json = JSON.parse(fixedJson);
                console.log('Successfully fixed truncated JSON');
              } catch (e) {
                // If fixing didn't work, try extraction
              }
            }
            
            // If still not parsed, try extraction
            if (!json) {
              const jsonMatch = jsonStr.match(/\{[\s\S]*\}/);
              if (jsonMatch && jsonMatch[0]) {
                try {
                  json = JSON.parse(jsonMatch[0]);
                } catch (e) {
                  // Last resort: try to extract and fix the JSON
                  throw new Error(`Invalid JSON response from API. The response appears to be truncated or malformed (${jsonStr.length} chars). Please try again.`);
                }
              }
            }
          } else {
            // For smaller responses, try extraction
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
          
          // If we still don't have json, throw error
          if (!json) {
            throw new Error(`Invalid JSON response from API. Failed to parse after multiple attempts. Response length: ${jsonStr.length} chars.`);
          }
        }
        
        // Validate required fields exist
        if (!json.title || !Array.isArray(json.keywords)) {
          console.warn('JSON response missing required fields:', {
            hasTitle: !!json.title,
            hasKeywords: Array.isArray(json.keywords),
            keys: Object.keys(json)
          });
          // Try to continue with what we have, but log the issue
        }
        
        // Simplified: just extract keywords array (can be strings or objects)
        const keywords = (json.keywords || []).map((k: any) => {
          // Handle both string format and object format {word: "..."}
          const word = typeof k === 'string' ? k : (k.word || k);
          return word?.toLowerCase().trim();
        }).filter(Boolean);

        return {
          title: json.title || "Untitled Stock Asset",
          description: "", // Not needed, keep empty
          keywords: keywords.slice(0, 50),
          backupKeywords: [], // Not needed
          keywordScores: [], // Not needed
          rejectionRisks: [], // Not needed
          category: "General", // Default category
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
        
        if (isRateLimit) {
          // Extract retry-after time from error message
          let retryAfterSeconds = 60; // Default 60 seconds (more conservative)
          // Try multiple regex patterns to catch different formats
          const retryPatterns = [
            /retry in ([\d.]+)s/i,
            /retry.*?([\d.]+)\s*s/i,
            /wait.*?([\d.]+)\s*s/i,
            /([\d.]+)\s*seconds?/i
          ];
          
          for (const pattern of retryPatterns) {
            const retryMatch = errMsg.match(pattern);
            if (retryMatch && retryMatch[1]) {
              retryAfterSeconds = Math.ceil(parseFloat(retryMatch[1])) + 5; // Add 5 seconds buffer
              console.log(`Extracted retry time: ${retryMatch[1]}s, waiting ${retryAfterSeconds}s`);
              break;
            }
          }
          
          lastError = e;
          console.warn(`Model ${model} rate limited. Waiting ${retryAfterSeconds}s...`);
          
          // If this is a -lite model, try non-lite models instead
          const modelIndex = modelsToTry.indexOf(model);
          const isLiteModel = model.includes('-lite');
          
          if (isLiteModel && modelIndex < modelsToTry.length - 1) {
            // Skip remaining -lite models and try non-lite models
            const remainingModels = modelsToTry.slice(modelIndex + 1).filter(m => !m.includes('-lite'));
            if (remainingModels.length > 0) {
              console.warn(`Skipping -lite models due to rate limit. Trying non-lite models: ${remainingModels.join(', ')}`);
              // Wait a bit before trying non-lite models
              await new Promise(resolve => setTimeout(resolve, Math.min(retryAfterSeconds, 30) * 1000));
              // Update modelsToTry to only include non-lite models
              modelsToTry = remainingModels;
              continue; // Restart loop with non-lite models
            }
          }
          
          // If we've tried multiple models, wait full time and throw
          if (modelIndex >= 2 || modelIndex >= modelsToTry.length - 1) {
            console.warn(`Multiple models rate limited. Waiting ${retryAfterSeconds}s before giving up...`);
            await new Promise(resolve => setTimeout(resolve, retryAfterSeconds * 1000));
            throw new QuotaExceededInternal();
          }
          
          // Wait before trying next model
          await new Promise(resolve => setTimeout(resolve, retryAfterSeconds * 1000));
          continue; // Try next model after delay
        }
        
        if (isModelNotFound) {
          lastError = e;
          console.warn(`Model ${model} not found/disabled, trying next...`);
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
