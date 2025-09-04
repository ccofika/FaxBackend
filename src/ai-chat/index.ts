/**
 * Main export file for the AI Chat system
 * Provides easy access to all major components and services
 */

// Core services
export { advancedSemanticSearch } from './services/advanced-semantic-search';
export { tocAIAnalyzer } from './services/toc-ai-analyzer';
export { sectionContentExtractor } from './services/section-content-extractor';
export { intelligentContentPipeline } from './services/intelligent-content-pipeline';
export { mainAICoordinator } from './services/main-ai-coordinator';

// Content retrieval services
export { contentRetrievalService } from './services/content-retrieval';
export { materialFinder } from './services/material-finder';

// Type definitions
export type {
  // Semantic search types
  SemanticSearchQuery,
  SectionMatch,
  SemanticSearchResult,
  
  // TOC analysis types
  TocSection,
  SelectedSection,
  SectionSelectionResult,
  
  // Content extraction types
  SectionContentRequest,
  ExtractedSectionContent,
  SectionExtractionResult,
  
  // Main AI types
  MainAIRequest,
  MainAIResponse,
  ContentSource,
  
  // Content retrieval types
  ContentRetrievalParams,
  ContentRetrievalResult,
  ProcessedContent,
  
  // Material finder types
  MaterialSearchParams,
  SubjectMaterials
} from './services/advanced-semantic-search';

export type {
  TocSection,
  SelectedSection,
  SectionSelectionResult,
  SectionSelectionRequest
} from './services/toc-ai-analyzer';

export type {
  SectionContentRequest,
  ExtractedSectionContent,
  ExtractedChunkContent,
  SectionExtractionResult
} from './services/section-content-extractor';

export type {
  MainAIRequest,
  MainAIResponse,
  ContentSource
} from './services/main-ai-coordinator';

export type {
  ContentRetrievalParams,
  ContentRetrievalResult,
  ProcessedContent,
  IntelligentContentRequest
} from './services/intelligent-content-pipeline';

export type {
  MaterialSearchParams,
  SubjectMaterials,
  MaterialInfo
} from './services/material-finder';

// Test utilities
export { testCompleteAISystem } from './test-complete-system';
export { testIntelligentPipeline } from './test-intelligent-pipeline';

// Configuration
export { openai } from './config/openai-config';

/**
 * Quick setup function for admin panel integration
 * Provides a simple interface for testing the complete AI system
 */
export async function quickAISetup() {
  const { mainAICoordinator } = await import('./services/main-ai-coordinator');
  const { advancedSemanticSearch } = await import('./services/advanced-semantic-search');
  const { tocAIAnalyzer } = await import('./services/toc-ai-analyzer');
  
  return {
    // Main interface for generating answers
    generateAnswer: mainAICoordinator.generateAnswer.bind(mainAICoordinator),
    quickAnswer: mainAICoordinator.quickAnswer.bind(mainAICoordinator),
    
    // Semantic search interface
    semanticSearch: advancedSemanticSearch.searchSimilarSections.bind(advancedSemanticSearch),
    
    // TOC analysis interface
    tocAnalysis: tocAIAnalyzer.selectRelevantSections.bind(tocAIAnalyzer),
    
    // Utility functions
    clearCache: advancedSemanticSearch.clearCache.bind(advancedSemanticSearch),
    getCacheStats: advancedSemanticSearch.getCacheStats.bind(advancedSemanticSearch)
  };
}

/**
 * System status check
 * Verifies that all required services are available
 */
export async function checkSystemStatus(): Promise<{
  status: 'ready' | 'partial' | 'error';
  services: {
    semanticSearch: boolean;
    tocAnalysis: boolean;
    contentExtraction: boolean;
    mainAI: boolean;
    database: boolean;
    openai: boolean;
  };
  errors?: string[];
}> {
  const status = {
    semanticSearch: false,
    tocAnalysis: false,
    contentExtraction: false,
    mainAI: false,
    database: false,
    openai: false
  };
  
  const errors: string[] = [];
  
  try {
    // Check database connection
    const mongoose = await import('mongoose');
    status.database = mongoose.connection.readyState === 1;
    if (!status.database) {
      errors.push('Database not connected');
    }
    
    // Check OpenAI configuration
    const { openai } = await import('./config/openai-config');
    status.openai = !!openai;
    if (!status.openai) {
      errors.push('OpenAI not configured');
    }
    
    // Check service imports
    try {
      const { advancedSemanticSearch } = await import('./services/advanced-semantic-search');
      status.semanticSearch = !!advancedSemanticSearch;
    } catch (error) {
      errors.push('Semantic search service error');
    }
    
    try {
      const { tocAIAnalyzer } = await import('./services/toc-ai-analyzer');
      status.tocAnalysis = !!tocAIAnalyzer;
    } catch (error) {
      errors.push('TOC analysis service error');
    }
    
    try {
      const { sectionContentExtractor } = await import('./services/section-content-extractor');
      status.contentExtraction = !!sectionContentExtractor;
    } catch (error) {
      errors.push('Content extraction service error');
    }
    
    try {
      const { mainAICoordinator } = await import('./services/main-ai-coordinator');
      status.mainAI = !!mainAICoordinator;
    } catch (error) {
      errors.push('Main AI coordinator service error');
    }
    
  } catch (error) {
    errors.push(`System check failed: ${error.message}`);
  }
  
  const serviceCount = Object.values(status).filter(Boolean).length;
  const totalServices = Object.keys(status).length;
  
  let overallStatus: 'ready' | 'partial' | 'error';
  if (serviceCount === totalServices) {
    overallStatus = 'ready';
  } else if (serviceCount > totalServices / 2) {
    overallStatus = 'partial';
  } else {
    overallStatus = 'error';
  }
  
  return {
    status: overallStatus,
    services: status,
    errors: errors.length > 0 ? errors : undefined
  };
}

// Default export for convenience
export default {
  quickAISetup,
  checkSystemStatus,
  mainAICoordinator,
  advancedSemanticSearch,
  tocAIAnalyzer,
  sectionContentExtractor,
  intelligentContentPipeline,
  contentRetrievalService,
  materialFinder
};