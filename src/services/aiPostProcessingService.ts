import { GoogleGenerativeAI } from '@google/generative-ai';
import { DocumentSection, Material } from '../models';
import { IDocumentSection } from '../models/DocumentSection';

interface AnalysisResult {
  shortAbstract: string;
  keywords: string[];
  queries: string[];
}

class AIPostProcessingService {
  private genAI: GoogleGenerativeAI;
  private model: any;
  private requestQueue: Array<() => Promise<any>> = [];
  private isProcessingQueue = false;
  private readonly MAX_REQUESTS_PER_MINUTE = 10; // Conservative limit below 15
  private readonly RETRY_DELAY_MS = 20000; // 20 seconds retry delay
  private lastRequestTime = 0;
  
  // Track active AI analysis processes
  private activeAnalyses: Map<string, boolean> = new Map();
  private abortedAnalyses: Set<string> = new Set();
  
  // NUCLEAR OPTION - kill all active requests
  private shouldKillAll = false;

  constructor() {
    this.genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY!);
    this.model = this.genAI.getGenerativeModel({ model: 'gemini-2.5-flash-lite' });
  }

  // Method to abort specific analysis
  abortAnalysis(materialId: string): void {
    console.log(`🛑 Aborting AI analysis for material: ${materialId}`);
    this.abortedAnalyses.add(materialId);
    this.activeAnalyses.delete(materialId);
  }

  // Method to abort ALL analyses
  abortAllAnalyses(): number {
    const activeCount = this.activeAnalyses.size;
    console.log(`🛑 Aborting ALL AI analyses (${activeCount} active)`);
    
    // NUCLEAR OPTION - kill everything
    this.shouldKillAll = true;
    console.log(`💥 NUCLEAR ABORT ACTIVATED - will kill all requests!`);
    
    // Mark all active analyses as aborted
    for (const materialId of this.activeAnalyses.keys()) {
      this.abortedAnalyses.add(materialId);
    }
    
    this.activeAnalyses.clear();
    
    // Clear kill flag after some time
    setTimeout(() => {
      this.shouldKillAll = false;
      console.log(`🟢 Nuclear abort deactivated`);
    }, 10000); // 10 seconds
    
    return activeCount;
  }

  // Check if analysis is aborted
  private isAborted(materialId: string): boolean {
    return this.shouldKillAll || this.abortedAnalyses.has(materialId) || (global as any).abortProcessing === true;
  }

  private async rateLimitedRequest<T>(requestFn: () => Promise<T>, materialId?: string): Promise<T> {
    return new Promise((resolve, reject) => {
      this.requestQueue.push(async () => {
        try {
          // NUCLEAR CHECK - kill immediately
          if (this.shouldKillAll) {
            console.log(`💥 NUCLEAR KILL - aborting request immediately!`);
            throw new Error('Request killed by nuclear abort');
          }
          
          // Ensure minimum delay between requests
          const now = Date.now();
          const minDelay = 60000 / this.MAX_REQUESTS_PER_MINUTE; // 6 seconds between requests
          const timeSinceLastRequest = now - this.lastRequestTime;
          
          if (timeSinceLastRequest < minDelay) {
            const waitTime = minDelay - timeSinceLastRequest;
            console.log(`⏳ Rate limiting: waiting ${Math.round(waitTime / 1000)}s before next request`);
            
            // ČEKAJ SA ABORT PROVEROM!
            const startTime = Date.now();
            while (Date.now() - startTime < waitTime) {
              // NUCLEAR CHECK during wait
              if (this.shouldKillAll) {
                console.log(`💥 NUCLEAR KILL during rate limit wait!`);
                throw new Error('Request killed by nuclear abort during wait');
              }
              // Proveri abort svakih 200ms tokom rate limit čekanja
              if (materialId && this.isAborted(materialId)) {
                console.log(`🛑 ABORTING during rate limit wait for material: ${materialId}`);
                throw new Error('Analysis aborted during rate limit wait');
              }
              await new Promise(r => setTimeout(r, 200));
            }
          }
          
          this.lastRequestTime = Date.now();
          const result = await this.retryRequest(requestFn, 3, materialId);
          resolve(result);
        } catch (error) {
          reject(error);
        }
      });
      
      if (!this.isProcessingQueue) {
        this.processQueue();
      }
    });
  }

  private async processQueue(): Promise<void> {
    this.isProcessingQueue = true;
    
    while (this.requestQueue.length > 0) {
      const request = this.requestQueue.shift();
      if (request) {
        await request();
      }
    }
    
    this.isProcessingQueue = false;
  }

  private async retryRequest<T>(requestFn: () => Promise<T>, maxRetries = 3, materialId?: string): Promise<T> {
    let lastError: Error | null = null;
    
    for (let attempt = 1; attempt <= maxRetries; attempt++) {
      try {
        console.log(`🔄 Attempt ${attempt}/${maxRetries} for Gemini API request`);
        return await requestFn();
      } catch (error: any) {
        lastError = error;
        
        // Check if it's a rate limit error
        if (error.status === 429 || (error.message && error.message.includes('Too Many Requests'))) {
          const delay = attempt === 1 ? this.RETRY_DELAY_MS : this.RETRY_DELAY_MS * attempt;
          console.log(`⚠️ Rate limit hit, waiting ${delay / 1000}s before retry ${attempt}/${maxRetries}`);
          
          if (attempt < maxRetries) {
            // ČEKAJ SA ABORT PROVEROM!
            const startTime = Date.now();
            while (Date.now() - startTime < delay) {
              // NUCLEAR CHECK during retry wait
              if (this.shouldKillAll) {
                console.log(`💥 NUCLEAR KILL during retry wait!`);
                throw new Error('Request killed by nuclear abort during retry wait');
              }
              // Proveri abort svakih 500ms tokom čekanja
              if (materialId && this.isAborted(materialId)) {
                console.log(`🛑 ABORTING during retry wait for material: ${materialId}`);
                throw new Error('Analysis aborted during retry wait');
              }
              await new Promise(resolve => setTimeout(resolve, 500));
            }
            continue;
          }
        } else {
          // For other errors, don't retry
          break;
        }
      }
    }
    
    throw lastError || new Error('Request failed after all retries');
  }

  async analyzeMaterial(materialId: string): Promise<{
    success: boolean;
    totalSections: number;
    processedSections: number;
    skippedSections: number;
    error?: string;
    aborted?: boolean;
  }> {
    try {
      console.log(`🧠 Starting AI analysis for material: ${materialId}`);

      // Register this analysis as active
      this.activeAnalyses.set(materialId, true);
      
      // Clean up any old abort status for this material
      this.abortedAnalyses.delete(materialId);

      // Check abort flag before starting
      if (this.isAborted(materialId)) {
        console.log(`🛑 AI Analysis aborted before starting for material: ${materialId}`);
        this.activeAnalyses.delete(materialId);
        return {
          success: false,
          totalSections: 0,
          processedSections: 0,
          skippedSections: 0,
          aborted: true,
          error: 'Analysis aborted by user'
        };
      }

      // Get material info for logging
      const material = await Material.findById(materialId);
      if (!material) {
        throw new Error(`Material not found: ${materialId}`);
      }

      console.log(`📖 Analyzing material: ${material.title}`);

      // Get all main sections (not split parts) for this material
      const sections = await DocumentSection.find({
        docId: materialId,
        $or: [
          { isMainPart: true },
          { isMainPart: { $exists: false } }
        ]
      }).sort({ pageStart: 1 });

      console.log(`📊 Found ${sections.length} sections to analyze`);

      if (sections.length === 0) {
        return {
          success: true,
          totalSections: 0,
          processedSections: 0,
          skippedSections: 0
        };
      }

      let processedCount = 0;
      let skippedCount = 0;

      // Process sections sequentially to respect rate limits
      console.log(`🔄 Processing ${sections.length} sections sequentially with rate limiting`);
      
      for (let i = 0; i < sections.length; i++) {
        // Check abort flag at the start of each iteration
        if (this.isAborted(materialId)) {
          console.log(`🛑 AI Analysis aborted during processing at section ${i + 1}/${sections.length} for material: ${materialId}`);
          this.activeAnalyses.delete(materialId);
          return {
            success: false,
            totalSections: sections.length,
            processedSections: processedCount,
            skippedSections: skippedCount,
            aborted: true,
            error: `Analysis aborted by user after processing ${processedCount} sections`
          };
        }

        const section = sections[i];
        
        try {
          // Skip if already analyzed
          if (section.analyzed) {
            console.log(`⏭️ Section already analyzed: ${section.title} (${i + 1}/${sections.length})`);
            skippedCount++;
            continue;
          }

          // Skip if no content
          if (!section.content || section.content.trim().length < 100) {
            console.log(`⏭️ Section too short, skipping: ${section.title} (${i + 1}/${sections.length})`);
            section.analyzed = true;
            await section.save();
            skippedCount++;
            continue;
          }

          console.log(`🧠 Analyzing section: ${section.title} (${i + 1}/${sections.length})`);
          const analysis = await this.analyzeSection(section, materialId);
          
          // Check abort flag again after the potentially long AI request
          if (this.isAborted(materialId)) {
            console.log(`🛑 AI Analysis aborted after completing section: ${section.title} for material: ${materialId}`);
            this.activeAnalyses.delete(materialId);
            return {
              success: false,
              totalSections: sections.length,
              processedSections: processedCount,
              skippedSections: skippedCount,
              aborted: true,
              error: `Analysis aborted by user after processing ${processedCount} sections`
            };
          }
          
          // Update section with analysis results
          section.shortAbstract = analysis.shortAbstract;
          section.keywords = analysis.keywords;
          section.queries = analysis.queries;
          section.analyzed = true;
          await section.save();

          console.log(`✅ Analysis completed for: ${section.title}`);
          console.log(`📝 Abstract: ${analysis.shortAbstract.substring(0, 100)}...`);
          console.log(`🏷️ Keywords: ${analysis.keywords.join(', ')}`);
          console.log(`❓ Queries: ${analysis.queries.join('; ')}`);
          
          processedCount++;
        } catch (error) {
          console.error(`❌ Failed to analyze section "${section.title}":`, error);
          // Continue with other sections, don't fail entire process
        }
      }

      console.log(`🎉 Analysis completed for material: ${material.title}`);
      console.log(`📊 Processed: ${processedCount}, Skipped: ${skippedCount}, Total: ${sections.length}`);

      // Clean up - remove from active analyses
      this.activeAnalyses.delete(materialId);

      return {
        success: true,
        totalSections: sections.length,
        processedSections: processedCount,
        skippedSections: skippedCount
      };

    } catch (error) {
      console.error('❌ AI analysis failed:', error);
      // Clean up - remove from active analyses
      this.activeAnalyses.delete(materialId);
      return {
        success: false,
        totalSections: 0,
        processedSections: 0,
        skippedSections: 0,
        error: error instanceof Error ? error.message : 'Unknown error'
      };
    }
  }

  private async analyzeSection(section: IDocumentSection, materialId?: string): Promise<AnalysisResult> {
    const content = section.content || '';
    const title = section.title;

    // Limit content length for API call
    const maxContentLength = 8000; // Leave room for prompt and response
    const truncatedContent = content.length > maxContentLength 
      ? content.substring(0, maxContentLength) + '...'
      : content;

    const prompt = `Analyze the following academic section and provide:

1. SHORT ABSTRACT: Create a concise summary in 3-8 sentences that captures the main points and key concepts.
2. KEYWORDS: Extract 5-15 important keywords/phrases for search indexing.
3. QUERIES: Generate 5-10 potential questions that users might ask about this section content.

Section Title: "${title}"

Section Content:
${truncatedContent}

Return your response as JSON in this exact format:
{
  "shortAbstract": "Your 3-8 sentence summary here...",
  "keywords": ["keyword1", "keyword2", "keyword3", ...],
  "queries": ["What is...?", "How does...?", "Why is...?", ...]
}

CRITICAL REQUIREMENTS: 
- MUST write all text using LATIN alphabet only (a, b, c, d, e, f, g, h, i, j, k, l, m, n, o, p, q, r, s, t, u, v, w, x, y, z)
- NEVER use Cyrillic letters (а, б, в, г, д, е, ж, з, и, ј, к, л, м, н, о, п, р, с, т, ћ, у, ф, х, ц, ч, џ, ш)
- If content is in Serbian, write the response using Serbian words but LATIN script only
- Use diacritics like č, ć, š, ž, đ when needed for Serbian words
- Abstract should be clear, informative, and standalone readable
- Keywords should include both broad topics and specific terms
- Queries should be natural questions users would ask about this content
- Focus on academic and technical terms for keywords
- Make queries specific to the content, not generic

EXAMPLE of correct Latin script for Serbian: "Ova sekcija objašnjava..." NOT "Ова секција објашњава..."`;

    try {
      console.log('🤖 Making Gemini API call with model: gemini-2.5-flash-lite');
      console.log('📋 Section being sent to AI:');
      console.log('--- START SECTION ---');
      console.log(`Title: ${title}`);
      console.log(`Content: ${truncatedContent.substring(0, 200)}...`);
      console.log('--- END SECTION ---');
      console.log(`📊 Content length: ${truncatedContent.length} characters`);
      
      const fullPrompt = `You are an expert academic content analyzer. Extract key information and provide structured summaries and keywords for academic search and discovery.\n\n${prompt}`;
      
      const response = await this.rateLimitedRequest(async () => {
        return await this.model.generateContent(fullPrompt);
      }, materialId);
      const result = response.response.text();
      
      if (!result) {
        throw new Error('Empty response from Gemini AI');
      }

      // Parse JSON response
      let parsed: AnalysisResult;
      try {
        // Extract JSON from response if it contains extra text
        const jsonMatch = result.match(/\{[\s\S]*\}/);
        const jsonText = jsonMatch ? jsonMatch[0] : result;
        parsed = JSON.parse(jsonText);
      } catch (parseError) {
        console.error('Failed to parse Gemini response as JSON:', result);
        throw new Error('Gemini AI returned invalid JSON response');
      }

      // Validate response structure
      if (!parsed.shortAbstract || !Array.isArray(parsed.keywords) || !Array.isArray(parsed.queries)) {
        throw new Error('Gemini AI response missing required fields');
      }

      // Clean and validate data
      const shortAbstract = parsed.shortAbstract.trim();
      const keywords = parsed.keywords
        .filter(k => typeof k === 'string' && k.trim().length > 0)
        .map(k => k.trim())
        .slice(0, 20); // Limit to 20 keywords max
      const queries = parsed.queries
        .filter(q => typeof q === 'string' && q.trim().length > 0)
        .map(q => q.trim())
        .slice(0, 15); // Limit to 15 queries max

      if (shortAbstract.length < 50) {
        throw new Error('Generated abstract too short');
      }

      if (keywords.length === 0) {
        throw new Error('No valid keywords extracted');
      }

      if (queries.length === 0) {
        throw new Error('No valid queries extracted');
      }

      return {
        shortAbstract,
        keywords,
        queries
      };

    } catch (error) {
      console.error('Error in Gemini AI analysis:', error);
      throw new Error(`Gemini AI analysis failed: ${error instanceof Error ? error.message : 'Unknown error'}`);
    }
  }

  async getAnalysisStatus(materialId: string): Promise<{
    totalSections: number;
    analyzedSections: number;
    pendingSections: number;
    isComplete: boolean;
  }> {
    try {
      const totalSections = await DocumentSection.countDocuments({
        docId: materialId,
        $or: [
          { isMainPart: true },
          { isMainPart: { $exists: false } }
        ]
      });

      const analyzedSections = await DocumentSection.countDocuments({
        docId: materialId,
        analyzed: true,
        $or: [
          { isMainPart: true },
          { isMainPart: { $exists: false } }
        ]
      });

      return {
        totalSections,
        analyzedSections,
        pendingSections: totalSections - analyzedSections,
        isComplete: analyzedSections === totalSections && totalSections > 0
      };
    } catch (error) {
      console.error('Error getting analysis status:', error);
      return {
        totalSections: 0,
        analyzedSections: 0,
        pendingSections: 0,
        isComplete: false
      };
    }
  }
}

export default new AIPostProcessingService();