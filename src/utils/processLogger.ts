import fs from 'fs/promises';
import path from 'path';

/**
 * Process Logger for tracking all document processing activities
 */
class ProcessLogger {
  private logs: string[] = [];
  private startTime: Date = new Date();
  private materialId: string = '';
  private logFilePath: string = '';
  
  /**
   * Initialize a new logging session
   */
  startLogging(materialId: string): void {
    this.materialId = materialId;
    this.startTime = new Date();
    this.logs = [];
    
    // Create log file name with timestamp
    const timestamp = this.startTime.toISOString().replace(/[:.]/g, '-').substring(0, 19);
    this.logFilePath = path.join(process.cwd(), `process_log_${materialId}_${timestamp}.txt`);
    
    this.addLog('='.repeat(80));
    this.addLog(`DOCUMENT PROCESSING LOG`);
    this.addLog(`Material ID: ${materialId}`);
    this.addLog(`Start Time: ${this.startTime.toISOString()}`);
    this.addLog('='.repeat(80));
    this.addLog('');
  }
  
  /**
   * Add a log entry - DO NOT console.log here, just store
   */
  addLog(message: string, level: 'INFO' | 'WARNING' | 'ERROR' | 'DEBUG' = 'INFO'): void {
    const timestamp = new Date().toISOString();
    const logEntry = `[${timestamp}] ${level}: ${message}`;
    this.logs.push(logEntry);
  }
  
  /**
   * Console.log wrapper - logs to both console and file with identical message
   */
  log(message: string): void {
    const timestamp = new Date().toISOString();
    this.logs.push(`[${timestamp}] ${message}`);
    console.log(message);
  }
  
  /**
   * Console.error wrapper
   */
  error(message: string): void {
    const timestamp = new Date().toISOString();
    this.logs.push(`[${timestamp}] ${message}`);
    console.error(message);
  }
  
  /**
   * Console.warn wrapper
   */
  warn(message: string): void {
    const timestamp = new Date().toISOString();
    this.logs.push(`[${timestamp}] ${message}`);
    console.warn(message);
  }
  
  /**
   * Add a section separator for better organization
   */
  addSection(sectionName: string): void {
    this.addLog('');
    this.addLog('-'.repeat(60));
    this.addLog(`SECTION: ${sectionName}`);
    this.addLog('-'.repeat(60));
  }
  
  /**
   * Log progress update
   */
  logProgress(step: string, percent: number, message?: string): void {
    const progressBar = this.createProgressBar(percent);
    this.addLog(`Progress: ${step} ${progressBar} ${percent}%${message ? ' - ' + message : ''}`);
  }
  
  /**
   * Create a text progress bar
   */
  private createProgressBar(percent: number): string {
    const width = 20;
    const filled = Math.floor((percent / 100) * width);
    const empty = width - filled;
    return `[${'\u2588'.repeat(filled)}${'-'.repeat(empty)}]`;
  }
  
  /**
   * Log TOC analysis results
   */
  logTocAnalysis(sections: any[]): void {
    this.addSection('TOC ANALYSIS RESULTS');
    this.addLog(`Total sections found: ${sections.length}`);
    this.addLog('');
    
    sections.forEach((section, index) => {
      this.addLog(`  ${index + 1}. ${section.title}`);
      this.addLog(`     Level: ${section.level} | Pages: ${section.pageStart}-${section.pageEnd}`);
      this.addLog(`     Type: ${section.semanticType}`);
      if (section.cleanTitle !== section.title) {
        this.addLog(`     Clean Title: ${section.cleanTitle}`);
      }
    });
    
    this.addLog('');
  }
  
  /**
   * Log section processing
   */
  logSectionProcessing(sectionTitle: string, index: number, total: number, content: string): void {
    this.addLog(`Processing section ${index}/${total}: "${sectionTitle}"`);
    this.addLog(`  Content length: ${content.length} characters`);
    this.addLog(`  First 100 chars: "${content.substring(0, 100)}..."`);
  }
  
  /**
   * Log fuzzy matching attempts
   */
  logFuzzyMatch(title: string, found: boolean, position?: number, variation?: string): void {
    if (found) {
      this.addLog(`  Fuzzy match SUCCESS for "${title}"`, 'DEBUG');
      this.addLog(`    Found at position: ${position}`, 'DEBUG');
      this.addLog(`    Matched variation: "${variation}"`, 'DEBUG');
    } else {
      this.addLog(`  Fuzzy match FAILED for "${title}"`, 'WARNING');
    }
  }
  
  /**
   * Log chunk creation
   */
  logChunkCreation(sectionTitle: string, numChunks: number): void {
    this.addLog(`  Created ${numChunks} chunks for section "${sectionTitle}"`, 'DEBUG');
  }
  
  /**
   * Log embedding creation
   */
  logEmbedding(sectionId: string, vectorId: string): void {
    this.addLog(`  Embedding created for ${sectionId} -> Vector ID: ${vectorId}`, 'DEBUG');
  }
  
  /**
   * Log error with stack trace
   */
  logError(error: Error | any, context?: string): void {
    this.addLog(`ERROR${context ? ' in ' + context : ''}: ${error.message || error}`, 'ERROR');
    if (error.stack) {
      this.addLog('Stack trace:', 'ERROR');
      error.stack.split('\n').forEach((line: string) => {
        this.addLog(`  ${line}`, 'ERROR');
      });
    }
  }
  
  /**
   * Add statistics summary
   */
  addStatistics(stats: {
    totalPages?: number;
    totalSections?: number;
    totalChunks?: number;
    processingTime?: number;
    [key: string]: any;
  }): void {
    this.addSection('PROCESSING STATISTICS');
    
    Object.entries(stats).forEach(([key, value]) => {
      const formattedKey = key.replace(/([A-Z])/g, ' $1').toLowerCase();
      this.addLog(`${formattedKey}: ${value}`);
    });
  }
  
  /**
   * Save logs to file
   */
  async saveToFile(): Promise<string> {
    try {
      const endTime = new Date();
      const processingTime = Math.round((endTime.getTime() - this.startTime.getTime()) / 1000);
      
      // Add footer
      this.addLog('');
      this.addLog('='.repeat(80));
      this.addLog(`End Time: ${endTime.toISOString()}`);
      this.addLog(`Total Processing Time: ${processingTime} seconds`);
      this.addLog(`Total Log Entries: ${this.logs.length}`);
      this.addLog('='.repeat(80));
      
      // Join all logs
      const fullLog = this.logs.join('\n');
      
      // Save to file
      await fs.writeFile(this.logFilePath, fullLog, 'utf-8');
      
      console.log(`\n✅ Process log saved to: ${this.logFilePath}`);
      
      return this.logFilePath;
    } catch (error) {
      console.error('Failed to save log file:', error);
      throw error;
    }
  }
  
  /**
   * Get all logs as string
   */
  getLogsAsString(): string {
    return this.logs.join('\n');
  }
  
  /**
   * Clear logs
   */
  clear(): void {
    this.logs = [];
  }
}

// Export singleton instance
export default new ProcessLogger();