import DocumentChunk from '../../models/DocumentChunk';
import { IDocumentChunk } from '../../models/DocumentChunk';

class SemanticSearchService {
  async searchSimilarChunks(query: string, chunks: IDocumentChunk[]): Promise<IDocumentChunk[]> {
    try {
      // For now, implement basic text similarity
      // This can be enhanced with actual vector embeddings using Qdrant later
      
      const queryLower = query.toLowerCase();
      const queryWords = queryLower.split(/\s+/).filter(word => word.length > 2);

      const scoredChunks = chunks.map(chunk => {
        const content = (chunk.content || '').toLowerCase();
        const contentWords = content.split(/\s+/);

        // Calculate simple relevance score
        let score = 0;
        
        // Exact phrase matching gets highest score
        if (content.includes(queryLower)) {
          score += 1.0;
        }

        // Word overlap scoring
        const matchingWords = queryWords.filter(qWord => 
          contentWords.some(cWord => 
            cWord.includes(qWord) || qWord.includes(cWord) || this.areSimilar(qWord, cWord)
          )
        );

        score += (matchingWords.length / queryWords.length) * 0.8;

        // Length penalty for very short chunks
        if (content.length < 100) {
          score *= 0.7;
        }

        return {
          chunk,
          score
        };
      });

      // Sort by relevance and filter out low scores
      return scoredChunks
        .filter(item => item.score > 0.1)
        .sort((a, b) => b.score - a.score)
        .slice(0, 10)
        .map(item => item.chunk);

    } catch (error) {
      console.error('Semantic Search Service Error:', error);
      return [];
    }
  }

  private areSimilar(word1: string, word2: string): boolean {
    // Basic similarity check for Serbian language
    if (word1.length < 4 || word2.length < 4) return false;
    
    // Check if one word contains the other (for different word forms)
    if (word1.includes(word2) || word2.includes(word1)) return true;
    
    // Levenshtein distance for similar words
    return this.levenshteinDistance(word1, word2) <= 2;
  }

  private levenshteinDistance(str1: string, str2: string): number {
    const matrix = [];
    
    for (let i = 0; i <= str2.length; i++) {
      matrix[i] = [i];
    }
    
    for (let j = 0; j <= str1.length; j++) {
      matrix[0][j] = j;
    }
    
    for (let i = 1; i <= str2.length; i++) {
      for (let j = 1; j <= str1.length; j++) {
        if (str2.charAt(i - 1) === str1.charAt(j - 1)) {
          matrix[i][j] = matrix[i - 1][j - 1];
        } else {
          matrix[i][j] = Math.min(
            matrix[i - 1][j - 1] + 1,
            matrix[i][j - 1] + 1,
            matrix[i - 1][j] + 1
          );
        }
      }
    }
    
    return matrix[str2.length][str1.length];
  }

  // Future method for actual vector embeddings integration
  async searchWithEmbeddings(query: string, chunks: IDocumentChunk[]): Promise<IDocumentChunk[]> {
    // TODO: Integrate with Qdrant vector database
    // This will provide much more accurate semantic search
    console.log('Vector embeddings search not yet implemented');
    return this.searchSimilarChunks(query, chunks);
  }
}

export const semanticSearchService = new SemanticSearchService();