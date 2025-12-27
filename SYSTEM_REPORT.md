# PiTagger AI - Complete System Report

## Executive Summary

PiTagger is a React-based web application that uses Google Gemini AI to automatically generate SEO-optimized metadata (titles, keywords) for stock photography and video assets. The system supports both traditional file uploads and direct folder access via the File System Access API, enabling batch processing of large asset libraries with intelligent rate limiting and quota management.

---

## 1. Architecture Overview

### 1.1 Technology Stack
- **Frontend Framework**: React 19.0.0 with TypeScript
- **Build Tool**: Vite 6.0.3
- **Styling**: Tailwind CSS 3.4.16
- **AI Service**: Google Gemini API (REST API v1)
- **File Processing**: File System Access API (Chrome/Edge/Opera)
- **Utilities**: JSZip for batch downloads

### 1.2 Application Structure
```
pitagger/
├── App.tsx                    # Main application component (1700+ lines)
├── components/                # UI components
│   ├── Header.tsx            # Top navigation and controls
│   ├── FileCard.tsx          # Individual file display
│   ├── LazyFileCard.tsx      # Optimized card for large folders
│   ├── FileUpload.tsx        # File/folder selection
│   ├── MetadataSidebar.tsx   # Metadata editing panel
│   ├── BatchActions.tsx      # Bulk operations
│   ├── SettingsModal.tsx    # API key management
│   ├── ApiQuotaStatus.tsx    # Quota monitoring
│   └── Toast.tsx             # Notifications
├── services/
│   ├── geminiService.ts      # Gemini API integration
│   ├── fileSystemService.ts  # File System Access API wrapper
│   └── fileUtils.ts          # File processing utilities
└── types.ts                  # TypeScript type definitions
```

---

## 2. Core Functionality

### 2.1 File Processing Workflow

#### Upload Modes
1. **Traditional Upload**: User selects files via `<input type="file">`
   - Files stored in browser memory as `File` objects
   - Preview URLs generated as blob URLs
   - Metadata saved only in application state

2. **Folder Mode** (File System Access API):
   - User grants folder access permission
   - Files accessed via `FileSystemFileHandle` objects
   - Direct read/write access to local filesystem
   - Metadata saved as `.pitagger.json` files alongside assets
   - CSV export saved directly to folder
   - JSON database (`pitagger_data.json`) maintains file registry

#### File Processing Pipeline
```
1. File Selection/Upload
   ↓
2. Preview Generation
   - Images: Blob URL or compressed canvas preview (800px max)
   - Videos: Extract single frame at 0s, 10%, or 30% of duration
   - Large files (>50MB): Compressed previews to save memory
   ↓
3. Queue Management
   - Files added to processing queue with PENDING status
   - Queue processor runs every 1 second
   - Processes multiple files in parallel (one per available API+model combo)
   ↓
4. AI Metadata Generation
   - Image: Compressed to 1024px max, converted to base64
   - Video: Single frame extracted at 512px max, JPEG quality 0.5
   - Payload sent to Gemini API with profile-specific prompts
   ↓
5. Metadata Processing
   - JSON response parsed (handles markdown code blocks)
   - Title and keywords extracted
   - Filename generated from title (sanitized, max 200 chars)
   - Readiness score calculated
   ↓
6. File System Updates (Folder Mode Only)
   - Save `.pitagger.json` metadata file
   - Update `pitagger_data.json` database
   - Append/update CSV row in real-time
   - Rename file if new filename differs
   ↓
7. UI Update
   - File status changed to COMPLETED
   - Metadata displayed in FileCard
   - Progress indicators updated
```

### 2.2 AI Integration (Gemini Service)

#### API Communication
- **Endpoint**: `https://generativelanguage.googleapis.com/v1`
- **Method**: REST API (not SDK) to avoid v1beta endpoint issues
- **Authentication**: API key via query parameter
- **Request Format**: Multi-part content (text prompt + image/video frame)

#### Model Selection Strategy
1. **Auto Mode** (default):
   - Queries available models via `/models` endpoint
   - Prioritizes `-lite` models (higher rate limits)
   - Falls back to newer versions (2.5, 3.0 over 1.5)
   - Caches model list for 5 minutes

2. **Manual Selection**:
   - User selects specific model in Settings
   - System validates model availability
   - Falls back to available models if selected model unavailable

#### Supported Models (Fallback List)
- `gemini-2.5-flash` (5 RPM free tier)
- `gemini-3-flash` (5 RPM free tier)
- `gemini-2.5-flash-lite` (10 RPM free tier)
- `gemini-1.5-flash`
- `gemini-1.5-pro`
- Legacy models

#### Response Processing
- Extracts JSON from markdown code blocks if present
- Handles truncated responses (common with large payloads)
- Validates required fields (title, keywords)
- Limits keywords to 50 items
- Error handling for:
  - Rate limits (429)
  - Invalid API keys (400)
  - Billing issues (403)
  - Model not found (404)

### 2.3 Rate Limiting & Quota Management

#### Multi-API Key Support
- Users can add multiple API keys
- Each key tracked independently with:
  - Per-minute quota (default: 30 requests/minute)
  - Daily quota (default: 1500 requests/day)
  - Cooldown periods
  - Last used timestamp

#### Quota Tracking
```typescript
ApiKeyRecord {
  requestCount: number;        // Current minute window
  quotaResetAt: number;          // Timestamp when minute resets
  requestsPerMinute: number;     // Limit (default: 30)
  dailyRequestCount: number;     // Current day window
  dailyQuotaResetAt: number;     // Timestamp when day resets
  requestsPerDay: number;        // Limit (default: 1500)
  status: 'active' | 'cooldown';
  nextAllowedAt: number;        // Earliest next request time
}
```

#### Intelligent Scheduling
- **Minimum Interval**: 2 seconds between requests (conservative)
- **Key Selection**: Round-robin based on `lastUsedAt`
- **Quota Reset**: Automatic when window expires
- **Cooldown**: 60 seconds when quota exceeded
- **Parallel Processing**: Multiple API+model combinations processed simultaneously

#### API+Model Combination Testing
- Background testing of all API key + model combinations
- Tracks working combinations in `workingApiModels` state
- Automatically retries failed combinations
- Removes exhausted combinations from pool
- Resumes processing when APIs recover

### 2.4 Generation Profiles

Four predefined profiles with custom prompts:

1. **Commercial Lifestyle**
   - Focus: Lifestyle energy, copy space, commercial utility
   - Use case: Stock photos for marketing

2. **Editorial News**
   - Focus: Journalistic, location-focused, no subjective adjectives
   - Use case: News and editorial content

3. **Minimal Product**
   - Focus: Minimalist, texture-focused, studio quality
   - Use case: Product photography

4. **Scientific/Medical**
   - Focus: Precise nomenclature, technical accuracy
   - Use case: Medical and scientific imagery

**Custom Profiles**: Users can override prompts per profile in Settings.

### 2.5 Style Memory

The system maintains user preferences:
- **Rejected Keywords**: Terms to avoid in future generations
- **Preferred Tones**: Desired stylistic approaches
- **Last Used Profile**: Remembers user's preferred profile
- **Custom Profile Prompts**: User-defined prompts per profile
- **Selected Model**: User's preferred Gemini model

Stored in `localStorage` as `autotagger_style_mem_v4`.

---

## 3. Data Management

### 3.1 File Metadata Structure
```typescript
Metadata {
  title: string;              // SEO-optimized title (max 180 chars)
  description: string;         // Currently unused (empty)
  keywords: string[];          // Array of 50 keywords
  backupKeywords?: string[];   // Additional suggestions (unused)
  keywordScores?: KeywordScore[];  // Scoring data (unused)
  rejectionRisks?: string[];   // Potential rejection reasons
  category: string;           // Asset category
  releases?: string;           // Model/property releases
  readinessScore?: number;     // 0-100 quality score
}
```

### 3.2 File Item State
```typescript
FileItem {
  id: string;                 // Unique identifier
  file?: File;                // File object (upload mode)
  fileHandle?: FileSystemFileHandle;  // Handle (folder mode)
  fileName: string;            // Original filename
  filePath?: string;           // Path in folder structure
  previewUrl: string;          // Blob URL or data URL
  status: ProcessingStatus;    // PENDING | PROCESSING | COMPLETED | ERROR
  metadata: Metadata;          // Generated metadata
  variantB?: Metadata;          // Alternative generation
  base64Frames?: string[];     // Video frames (for API)
  newFilename?: string;         // Generated filename
  isFromFileSystem: boolean;   // Folder mode flag
}
```

### 3.3 Storage Mechanisms

#### Browser Storage (localStorage)
- **API Keys**: `autotagger_api_vault_v4`
  - Stores: id, key, label, addedAt, quota tracking
  - Keys are NOT encrypted (stored in plain text)
  - Persists across sessions

- **Style Memory**: `autotagger_style_mem_v4`
  - Stores: rejected keywords, preferred tones, custom prompts, selected model
  - Persists user preferences

#### File System Storage (Folder Mode)
- **`.pitagger.json`**: Per-file metadata
  - Contains full metadata object
  - Saved alongside original file
  - Updated when metadata changes

- **`pitagger_data.json`**: Central database
  - Key-value store: filename → file data
  - Includes: originalFilename, newFilename, filePath, metadata, updatedAt
  - Enables fast lookup of processed files

- **`pitagger_export.csv`**: CSV export
  - Format: `Filename,Title,Tags,Suggestions`
  - Updated in real-time as files complete
  - Prevents duplicates (updates existing rows)

---

## 4. User Interface Components

### 4.1 Header Component
- **File Statistics**: Total, completed, processing, pending
- **Queue Controls**: Start/Stop processing
- **Export Options**: CSV download (multiple presets)
- **Settings Access**: API key management
- **Folder Selection**: Directory picker (if supported)
- **Quota Display**: Daily quota remaining across all keys
- **Progress Indicator**: Processing progress bar

### 4.2 FileCard Component
- **Preview**: Image/video thumbnail
- **Status Badge**: Processing status indicator
- **Metadata Preview**: Title and keyword count
- **Actions**: Remove, select, open sidebar
- **Lazy Loading**: `LazyFileCard` for folders with 20+ files

### 4.3 MetadataSidebar Component
- **Full Metadata Display**: Title, keywords, category
- **Editing**: Inline editing of all fields
- **Variant Generation**: Generate alternative metadata
- **Readiness Score**: Quality indicator
- **Save**: Persists changes to file system (folder mode)

### 4.4 BatchActions Component
- **Profile Selection**: Apply generation profile to selected files
- **Category Assignment**: Bulk category updates
- **Selection Management**: Select all, clear selection

### 4.5 SettingsModal Component
- **API Key Management**:
  - Add keys (with label)
  - Remove keys
  - View quota status per key
  - Reset quota manually
- **Model Selection**: Choose Gemini model (auto or specific)
- **Custom Prompts**: Override profile prompts

---

## 5. Processing Queue System

### 5.1 Queue Processor
- **Interval**: Runs every 1 second
- **Parallel Processing**: Processes up to N files simultaneously
  - N = number of available API+model combinations
  - Each combination processes one file at a time
- **Active Tracking**: Uses `activeProcessingIds` ref to prevent duplicates

### 5.2 Queue Logic
```typescript
1. Check for available API+model combinations
2. Filter pending files (not currently processing)
3. Process up to N files (N = available combinations)
4. If more pending than available:
   - Test additional API+model combinations in background
5. If all APIs exhausted:
   - Show modal warning
   - Continue testing in background for recovery
```

### 5.3 Error Handling
- **Rate Limits**: Re-queue file, show quota message
- **API Key Issues**: Stop queue, show error
- **Billing Issues**: Stop queue, show error
- **Other Errors**: Mark file as ERROR, continue processing others

### 5.4 Retry Logic
- **API Failures**: Up to 5 retries per file
- **Model Switching**: Tries next model on rate limit
- **API Switching**: Tries next API key if all models exhausted
- **Background Recovery**: Continuously tests exhausted APIs

---

## 6. File System Integration

### 6.1 File System Access API
- **Browser Support**: Chrome, Edge, Opera only
- **Permissions**: User grants folder access once
- **Scope**: Read/write access to selected folder and subfolders

### 6.2 File Operations

#### Reading Files
- **For Preview**: Compressed previews for large files
- **For Processing**: Full file read when needed
- **Video Frames**: Extracted on-demand

#### Writing Files
- **Metadata Files**: `.pitagger.json` saved alongside original
- **CSV Updates**: Real-time append/update
- **JSON Database**: Central registry updated per file
- **File Renaming**: Renames original file if new filename differs

#### File Detection
- **Processed Files**: Checks CSV and `.pitagger.json`
- **Skip Logic**: Automatically skips already-processed files
- **Resume Support**: Can resume processing on folder re-open

### 6.3 CSV Format
```csv
Filename,Title,Tags,Suggestions
"new-filename.jpg","SEO Title Here","keyword1, keyword2, keyword3","suggestion1, suggestion2"
```

- **Headers**: Fixed format
- **Quoting**: Fields quoted, internal quotes escaped (`""`)
- **Updates**: Existing rows updated instead of duplicated

---

## 7. Performance Optimizations

### 7.1 Image Processing
- **API Payload**: Images compressed to 1024px max
- **Preview**: Images compressed to 800px max
- **Large Files**: Special handling for files >50MB
- **Canvas Compression**: JPEG quality 0.7 for API, 0.8 for preview

### 7.2 Video Processing
- **Single Frame**: Only one frame extracted (not multiple)
- **Frame Size**: 512px max for API payload
- **Quality**: JPEG quality 0.5 for API
- **Timeout**: Adaptive based on file size (90s base + 2s per 10MB, max 5min)

### 7.3 Memory Management
- **Blob URLs**: Properly revoked on file removal
- **Large Files**: Compressed previews to reduce memory
- **Lazy Loading**: `LazyFileCard` defers preview loading
- **Sequential Preview Loading**: Prevents browser overload

### 7.4 Network Optimization
- **Request Spacing**: 2-second minimum between requests
- **Parallel Processing**: Multiple API keys used simultaneously
- **Model Caching**: Model list cached for 5 minutes
- **Payload Compression**: Images/videos compressed before API calls

---

## 8. Error Handling & Recovery

### 8.1 API Error Types
1. **Rate Limit (429)**: 
   - Extracts retry-after time from response
   - Waits before retry
   - Tries next model/API if available

2. **Invalid API Key (400)**:
   - Stops processing queue
   - Shows user-friendly error
   - Requires user action

3. **Billing Issue (403)**:
   - Stops processing queue
   - Directs user to Google Cloud Console

4. **Model Not Found (404)**:
   - Tries next available model
   - Falls back to other models

5. **Quota Exceeded**:
   - Internal `QuotaExceededInternal` exception
   - Re-queues file for later
   - Shows quota reset option

### 8.2 File Processing Errors
- **Preview Failures**: Retries with exponential backoff (up to 10 attempts)
- **Video Frame Extraction**: Multiple time points attempted
- **File Read Errors**: Graceful degradation, error state shown

### 8.3 Recovery Mechanisms
- **Background Testing**: Continuously tests exhausted APIs
- **Automatic Resume**: Processing resumes when APIs recover
- **Manual Reset**: User can reset quotas in Settings
- **State Persistence**: Queue state maintained across sessions

---

## 9. Security & Privacy

### 9.1 API Key Storage
- **Location**: Browser `localStorage`
- **Encryption**: None (stored in plain text)
- **Scope**: Local to user's browser only
- **No Transmission**: Keys never sent to external servers (only to Google API)

### 9.2 File Access
- **Folder Mode**: User explicitly grants permission
- **Upload Mode**: Files never leave browser (processed in-memory)
- **No Backend**: All processing client-side

### 9.3 Data Privacy
- **No Analytics**: No tracking or analytics
- **No Cloud Storage**: Files never uploaded to external servers
- **Local Only**: All data stays in user's browser/filesystem

---

## 10. Limitations & Constraints

### 10.1 Browser Limitations
- **File System API**: Chrome, Edge, Opera only
- **Memory**: Large files may cause browser slowdown
- **Concurrent Requests**: Limited by browser connection limits

### 10.2 API Limitations
- **Free Tier**: 30 requests/minute, 1500/day (conservative estimates)
- **Rate Limits**: Strict enforcement to avoid 429 errors
- **Model Availability**: Varies by API key permissions

### 10.3 Processing Limitations
- **Video Frames**: Only one frame extracted (may miss content)
- **Large Files**: Processing may be slow (>100MB)
- **Batch Size**: No hard limit, but memory constraints apply

---

## 11. Future Enhancement Opportunities

### 11.1 Potential Improvements
1. **Multiple Video Frames**: Extract multiple frames for better analysis
2. **Batch Size Limits**: Configurable batch processing limits
3. **API Key Encryption**: Encrypt keys in localStorage
4. **Progress Persistence**: Save queue state to localStorage
5. **Export Formats**: Additional CSV presets (Shutterstock, Getty, etc.)
6. **Metadata Validation**: Pre-submission validation for stock sites
7. **Keyword Optimization**: AI-powered keyword refinement
8. **Duplicate Detection**: Identify similar assets

### 11.2 Technical Debt
- Large `App.tsx` file (1700+ lines) could be split into hooks
- Some error handling could be more granular
- Type safety could be improved in some areas
- Test coverage is currently non-existent

---

## 12. Deployment & Build

### 12.1 Build Configuration
- **Output**: `dist/` directory
- **Code Splitting**: React and Gemini vendor chunks separated
- **Minification**: ESBuild
- **Source Maps**: Disabled in production

### 12.2 Development
- **Dev Server**: Vite on port 3000
- **Hot Reload**: Enabled
- **TypeScript**: Strict mode enabled

### 12.3 Production
- **Static Hosting**: Can be deployed to any static host (Vercel, Netlify, etc.)
- **No Backend Required**: Fully client-side application
- **Environment Variables**: None required (API keys user-provided)

---

## Conclusion

PiTagger is a sophisticated client-side application that leverages Google Gemini AI to automate metadata generation for stock assets. The system is designed for scalability (multiple API keys, parallel processing), reliability (intelligent retry logic, quota management), and user experience (folder mode, real-time updates, progress tracking).

The architecture is modular and extensible, with clear separation between UI components, services, and utilities. The system handles edge cases gracefully and provides comprehensive error recovery mechanisms.

---

**Report Generated**: 2024
**System Version**: 1.0.0
**Last Updated**: Current implementation state

