/**
 * Utility functions for fuzzy matching of section titles in text
 * Handles edge cases like extra spaces, case variations, etc.
 */

/**
 * Normalizes text for comparison - removes extra spaces, converts to lowercase
 */
export function normalizeText(text: string): string {
  return text
    .toLowerCase()
    .replace(/\s+/g, ' ')  // Replace multiple spaces with single space
    .trim();
}

/**
 * Creates variations of the title to handle OCR/formatting issues
 * @param title - The original title (e.g., "Hardver")
 * @returns Array of possible variations
 */
export function createTitleVariations(title: string): string[] {
  const variations: string[] = [];
  const normalizedTitle = title.trim();
  
  // Original title
  variations.push(normalizedTitle);
  
  // Lowercase version
  variations.push(normalizedTitle.toLowerCase());
  
  // Uppercase version
  variations.push(normalizedTitle.toUpperCase());
  
  // With spaces between each character (OCR issue)
  const spacedOut = normalizedTitle.split('').join(' ');
  variations.push(spacedOut);
  variations.push(spacedOut.toLowerCase());
  variations.push(spacedOut.toUpperCase());
  
  // Common OCR errors - specific character replacements
  const ocrVariations = [
    normalizedTitle.replace(/l/g, '1').replace(/L/g, '1'),  // l/L -> 1
    normalizedTitle.replace(/1/g, 'l').replace(/1/g, 'L'),  // 1 -> l/L
    normalizedTitle.replace(/0/g, 'O').replace(/0/g, 'o'),  // 0 -> O/o
    normalizedTitle.replace(/O/gi, '0'),                     // O/o -> 0
  ];
  variations.push(...ocrVariations);
  
  // With random spaces (max 2 random spaces inserted)
  if (normalizedTitle.length > 3) {
    for (let i = 1; i < normalizedTitle.length - 1; i++) {
      const withSpace = normalizedTitle.slice(0, i) + ' ' + normalizedTitle.slice(i);
      variations.push(withSpace);
      variations.push(withSpace.toLowerCase());
      
      // Two spaces at different positions
      for (let j = i + 2; j < withSpace.length - 1; j++) {
        const withTwoSpaces = withSpace.slice(0, j) + ' ' + withSpace.slice(j);
        variations.push(withTwoSpaces);
        variations.push(withTwoSpaces.toLowerCase());
      }
    }
  }
  
  // Remove duplicates
  return [...new Set(variations)];
}

/**
 * Finds the first occurrence of any title variation in the text
 * @param text - The text to search in
 * @param title - The section title to find
 * @param startFrom - Optional starting position in text
 * @returns Object with found flag, position, and matched variation
 */
export function findTitleInText(
  text: string, 
  title: string, 
  startFrom: number = 0
): { found: boolean; position: number; matchedVariation: string } {
  const variations = createTitleVariations(title);
  
  let bestMatch = {
    found: false,
    position: -1,
    matchedVariation: ''
  };
  
  for (const variation of variations) {
    // Try to find this variation in the text
    const searchText = text.substring(startFrom);
    const position = searchText.indexOf(variation);
    
    if (position !== -1) {
      const absolutePosition = startFrom + position;
      
      // Keep the earliest match
      if (!bestMatch.found || absolutePosition < bestMatch.position) {
        bestMatch = {
          found: true,
          position: absolutePosition,
          matchedVariation: variation
        };
      }
    }
    
    // Also try regex matching for more flexible patterns
    try {
      // Create a regex that allows for spaces between characters
      const regexPattern = variation
        .split('')
        .map(char => {
          // Escape special regex characters
          const escaped = char.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
          return escaped;
        })
        .join('\\s*');  // Allow optional spaces between characters
      
      const regex = new RegExp(regexPattern, 'i');
      const match = searchText.match(regex);
      
      if (match && match.index !== undefined) {
        const absolutePosition = startFrom + match.index;
        
        if (!bestMatch.found || absolutePosition < bestMatch.position) {
          bestMatch = {
            found: true,
            position: absolutePosition,
            matchedVariation: match[0]
          };
        }
      }
    } catch (e) {
      // Ignore regex errors
    }
  }
  
  return bestMatch;
}

/**
 * Extracts clean title from a TOC line or section header
 * Removes numbering like "1.1.1" and separators
 * @param titleLine - The full title line from TOC
 * @returns Clean title without numbering
 */
export function extractCleanTitle(titleLine: string): string {
  return titleLine
    // Remove leading numbers and dots (e.g., "1.1.1 Hardver" -> "Hardver")
    .replace(/^[\d\.\s]+/, '')
    // Remove page numbers at the end
    .replace(/[\.\s\-_]+\d+\s*$/, '')
    // Remove separator characters
    .replace(/[\.]{2,}|\-{2,}|_{2,}/g, '')
    .trim();
}

/**
 * Calculates similarity between two strings (0-1)
 * Uses Levenshtein distance
 */
export function calculateSimilarity(str1: string, str2: string): number {
  const s1 = normalizeText(str1);
  const s2 = normalizeText(str2);
  
  if (s1 === s2) return 1;
  if (s1.length === 0 || s2.length === 0) return 0;
  
  const maxLength = Math.max(s1.length, s2.length);
  const distance = levenshteinDistance(s1, s2);
  
  return 1 - (distance / maxLength);
}

/**
 * Calculates Levenshtein distance between two strings
 */
function levenshteinDistance(str1: string, str2: string): number {
  const matrix: number[][] = [];
  
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
          matrix[i - 1][j - 1] + 1,  // substitution
          matrix[i][j - 1] + 1,       // insertion
          matrix[i - 1][j] + 1        // deletion
        );
      }
    }
  }
  
  return matrix[str2.length][str1.length];
}

/**
 * Finds the best matching title from a list of candidates
 */
export function findBestMatch(
  target: string,
  candidates: string[],
  minSimilarity: number = 0.7
): { match: string | null; similarity: number } {
  let bestMatch = {
    match: null as string | null,
    similarity: 0
  };
  
  for (const candidate of candidates) {
    const similarity = calculateSimilarity(target, candidate);
    
    if (similarity > bestMatch.similarity && similarity >= minSimilarity) {
      bestMatch = {
        match: candidate,
        similarity
      };
    }
  }
  
  return bestMatch;
}