import { QdrantClient } from '@qdrant/js-client-rest';
import OpenAI from 'openai';
import { v4 as uuidv4 } from 'uuid';

interface QdrantPoint {
  id: string;
  vector: number[];
  payload: any;
}

interface SearchResult {
  id: string;
  score: number;
  payload: any;
}

class QdrantService {
  private client: QdrantClient;
  private openai: OpenAI;
  private collectionName: string;

  constructor() {
    if (!process.env.QDRANT_URL || !process.env.QDRANT_API_KEY) {
      throw new Error('Qdrant configuration missing. Please set QDRANT_URL and QDRANT_API_KEY');
    }

    this.client = new QdrantClient({
      url: process.env.QDRANT_URL,
      apiKey: process.env.QDRANT_API_KEY,
    });

    this.openai = new OpenAI({
      apiKey: process.env.OPENAI_API_KEY,
    });

    this.collectionName = process.env.QDRANT_COLLECTION || 'uni-books-cluster';
  }

  async ensureCollection(): Promise<void> {
    try {
      // Check if collection exists
      const collections = await this.client.getCollections();
      const collectionExists = collections.collections.some(
        collection => collection.name === this.collectionName
      );

      if (!collectionExists) {
        console.log(`Creating Qdrant collection: ${this.collectionName}`);
        await this.client.createCollection(this.collectionName, {
          vectors: {
            size: 1536, // OpenAI text-embedding-3-small dimension
            distance: 'Cosine',
          },
        });
        
        // Create payload indexes for filtering
        await this.client.createPayloadIndex(this.collectionName, {
          field_name: 'docId',
          field_schema: 'keyword'
        });
        
        await this.client.createPayloadIndex(this.collectionName, {
          field_name: 'subjectId',
          field_schema: 'keyword'
        });
        
        await this.client.createPayloadIndex(this.collectionName, {
          field_name: 'type',
          field_schema: 'keyword'
        });
        
        await this.client.createPayloadIndex(this.collectionName, {
          field_name: 'sectionId',
          field_schema: 'keyword'
        });
        
        console.log('✅ Created payload indexes for filtering');
        console.log(`Collection ${this.collectionName} created successfully`);
      }
    } catch (error) {
      console.error('Error ensuring collection exists:', error);
      throw error;
    }
  }

  private validateTextLength(text: string): string {
    // Conservative token estimation: 1 token = 3 characters
    const maxTokens = 8000; // Leave some margin from 8192 limit
    const maxChars = maxTokens * 3;
    
    if (text.length > maxChars) {
      console.warn(`Text too long for embedding: ${text.length} chars (max: ${maxChars}). Truncating.`);
      return text.substring(0, maxChars);
    }
    
    return text;
  }

  async generateEmbedding(text: string): Promise<number[]> {
    try {
      // Validate and potentially truncate text
      const validatedText = this.validateTextLength(text);
      
      const response = await this.openai.embeddings.create({
        model: 'text-embedding-3-small',
        input: validatedText,
      });

      return response.data[0].embedding;
    } catch (error) {
      console.error('Error generating embedding:', error);
      throw error;
    }
  }

  async addPoints(points: QdrantPoint[]): Promise<void> {
    try {
      await this.ensureCollection();
      
      const formattedPoints = points.map(point => ({
        id: point.id,
        vector: point.vector,
        payload: point.payload,
      }));

      await this.client.upsert(this.collectionName, {
        wait: true,
        points: formattedPoints,
      });

      console.log(`Added ${points.length} points to Qdrant collection`);
    } catch (error) {
      console.error('Error adding points to Qdrant:', error);
      throw error;
    }
  }

  async addSection(
    sectionId: string,
    content: string,
    metadata: {
      docId: string;
      subjectId: string;
      title: string;
      path: string;
      level: number;
      pageStart: number;
      pageEnd: number;
      type: 'section';
    }
  ): Promise<string> {
    try {
      const embedding = await this.generateEmbedding(content);
      // Generate UUID for vector ID
      const vectorId = uuidv4();

      await this.addPoints([{
        id: vectorId,
        vector: embedding,
        payload: {
          ...metadata,
          sectionId: sectionId, // Store original sectionId in payload
          content_preview: content.substring(0, 200), // Store preview only
        },
      }]);

      return vectorId;
    } catch (error) {
      console.error('Error adding section to Qdrant:', error);
      throw error;
    }
  }

  async addChunk(
    chunkId: string,
    content: string,
    metadata: {
      docId: string;
      subjectId: string;
      sectionId: string;
      title?: string;
      path: string;
      page: number;
      paragraphIdx: number;
      r2KeyOriginal: string;
      r2KeyPreviewPage?: string;
      type: 'chunk';
    }
  ): Promise<string> {
    try {
      const embedding = await this.generateEmbedding(content);
      // Generate UUID for vector ID
      const vectorId = uuidv4();

      await this.addPoints([{
        id: vectorId,
        vector: embedding,
        payload: {
          ...metadata,
          chunkId: chunkId, // Store original chunkId in payload
          content_preview: content.substring(0, 300), // Store preview only
        },
      }]);

      return vectorId;
    } catch (error) {
      console.error('Error adding chunk to Qdrant:', error);
      throw error;
    }
  }

  async searchSections(
    query: string,
    subjectId: string,
    limit: number = 8
  ): Promise<SearchResult[]> {
    try {
      await this.ensureCollection();
      
      const queryEmbedding = await this.generateEmbedding(query);

      const searchResults = await this.client.search(this.collectionName, {
        vector: queryEmbedding,
        limit,
        filter: {
          must: [
            { key: 'subjectId', match: { value: subjectId } },
            { key: 'type', match: { value: 'section' } },
          ],
        },
        with_payload: true,
      });

      return searchResults.map(result => ({
        id: result.id as string,
        score: result.score,
        payload: result.payload,
      }));
    } catch (error) {
      console.error('Error searching sections:', error);
      throw error;
    }
  }

  async searchChunks(
    query: string,
    subjectId: string,
    sectionIds?: string[],
    limit: number = 5
  ): Promise<SearchResult[]> {
    try {
      await this.ensureCollection();
      
      const queryEmbedding = await this.generateEmbedding(query);

      const filter: any = {
        must: [
          { key: 'subjectId', match: { value: subjectId } },
          { key: 'type', match: { value: 'chunk' } },
        ],
      };

      // If specific sections are provided, filter by them
      if (sectionIds && sectionIds.length > 0) {
        filter.must.push({
          key: 'sectionId',
          match: { any: sectionIds },
        });
      }

      const searchResults = await this.client.search(this.collectionName, {
        vector: queryEmbedding,
        limit,
        filter,
        with_payload: true,
      });

      return searchResults.map(result => ({
        id: result.id as string,
        score: result.score,
        payload: result.payload,
      }));
    } catch (error) {
      console.error('Error searching chunks:', error);
      throw error;
    }
  }

  async deleteByDocId(docId: string): Promise<void> {
    try {
      await this.ensureCollection();
      
      await this.client.delete(this.collectionName, {
        filter: {
          must: [{ key: 'docId', match: { value: docId } }],
        },
      });

      console.log(`Deleted vectors for document: ${docId}`);
    } catch (error) {
      console.error('Error deleting vectors:', error);
      throw error;
    }
  }

  async clearCollection(): Promise<void> {
    try {
      await this.ensureCollection();
      
      // Delete collection and recreate it
      await this.client.deleteCollection(this.collectionName);
      console.log(`Deleted Qdrant collection: ${this.collectionName}`);
      
      // Recreate the collection
      await this.client.createCollection(this.collectionName, {
        vectors: {
          size: 1536, // OpenAI text-embedding-3-small dimension
          distance: 'Cosine',
        },
      });
      
      // Create payload indexes for filtering
      await this.client.createPayloadIndex(this.collectionName, {
        field_name: 'docId',
        field_schema: 'keyword'
      });
      
      await this.client.createPayloadIndex(this.collectionName, {
        field_name: 'subjectId',
        field_schema: 'keyword'
      });
      
      await this.client.createPayloadIndex(this.collectionName, {
        field_name: 'type',
        field_schema: 'keyword'
      });
      
      await this.client.createPayloadIndex(this.collectionName, {
        field_name: 'sectionId',
        field_schema: 'keyword'
      });
      
      console.log('✅ Created payload indexes for filtering');
      console.log(`Recreated Qdrant collection: ${this.collectionName}`);
    } catch (error) {
      console.error('Error clearing Qdrant collection:', error);
      throw error;
    }
  }

  async createMissingIndexes(): Promise<void> {
    try {
      await this.ensureCollection();
      
      const indexFields = ['docId', 'subjectId', 'type', 'sectionId'];
      
      for (const field of indexFields) {
        try {
          await this.client.createPayloadIndex(this.collectionName, {
            field_name: field,
            field_schema: 'keyword'
          });
          console.log(`✅ Created index for field: ${field}`);
        } catch (error: any) {
          if (error.message?.includes('already exists')) {
            console.log(`ℹ️ Index for field ${field} already exists`);
          } else {
            console.error(`⚠️ Failed to create index for field ${field}:`, error);
          }
        }
      }
    } catch (error) {
      console.error('Error creating missing indexes:', error);
      throw error;
    }
  }

  async deleteDocument(docId: string): Promise<void> {
    try {
      await this.ensureCollection();
      
      // Try to create missing indexes first (in case collection exists without them)
      try {
        await this.createMissingIndexes();
      } catch (indexError) {
        console.warn('Warning: Could not ensure indexes exist:', indexError);
      }
      
      // Delete all vectors (sections and chunks) for this document
      await this.client.delete(this.collectionName, {
        filter: {
          must: [
            { key: 'docId', match: { value: docId } }
          ]
        }
      });
      
      console.log(`✅ Deleted all vectors for document: ${docId} from Qdrant`);
    } catch (error) {
      console.error('Error deleting document from Qdrant:', error);
      throw error;
    }
  }

  async healthCheck(): Promise<boolean> {
    try {
      await this.client.getCollections();
      return true;
    } catch (error) {
      console.error('Qdrant health check failed:', error);
      return false;
    }
  }

}

export default new QdrantService();