import OpenAI from 'openai';

const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
});

export interface RelevantSection {
  materialId: string;
  materialName: string;
  sectionTitle: string;
  content: string;
  relevanceScore: number;
}

export interface GPTRequest {
  userMessage: string;
  mode: 'Explain' | 'Learn' | 'Test' | 'Summary' | 'Solve';
  relevantSections: RelevantSection[];
  subject: string;
}

export interface GPTResponse {
  content: string;
  tokensUsed: number;
}

class GPTService {
  private getModePrompt(mode: string): string {
    const prompts = {
      Explain: 'Objasni detaljno i jasno koristeći se isključivo informacijama iz priloženih materijala. Koristi primere i analogije kada je to moguće.',
      Learn: 'Pomozi korisniku da nauči gradivo na interaktivan način. Postavljaj pitanja i vodi kroz proces učenja koristeći isključivo sadržaj iz materijala.',
      Test: 'Postavi pitanja za testiranje znanja na osnovu gradiva iz materijala. Fokusiraj se na ključne koncepte i proveru razumevanja.',
      Summary: 'Napravi sažetak ključnih informacija iz relevantnih delova materijala. Budi koncizan ali sveobuhvatan.',
      Solve: 'Reši problem ili zadatak koristeći se metodama i pristupima objašnjenim u materijalima. Pokaži korak po korak rešavanje.'
    };
    
    return prompts[mode as keyof typeof prompts] || prompts.Explain;
  }

  private buildSystemPrompt(mode: string, subject: string): string {
    const modeInstruction = this.getModePrompt(mode);
    
    return `Ti si AI asistent specijalizovan za obrazovni sadržaj predmeta "${subject}".

VAŽNO - STRIKTNA PRAVILA:
1. Koristiš ISKLJUČIVO informacije iz priloženih materijala
2. Ako informacije nisu dostupne u materijalima, jasno reci da nema dovoljno informacija
3. Ne izmišljaj činjenice niti koristiš opšte znanje van materijala
4. Sve tvoje odgovore moraju biti zasnovani na konkretnom sadržaju iz dokumenata

TVOJA ULOGA (${mode} mod):
${modeInstruction}

Odgovori na srpskom jeziku i budi precizan, jasan i koristan.`;
  }

  private buildUserPrompt(userMessage: string, relevantSections: RelevantSection[]): string {
    let prompt = `Korisničko pitanje: ${userMessage}\n\n`;
    
    if (relevantSections.length > 0) {
      prompt += 'RELEVANTNI SADRŽAJ IZ MATERIJALA:\n\n';
      
      relevantSections.forEach((section, index) => {
        prompt += `[MATERIJAL ${index + 1}: ${section.materialName}]\n`;
        prompt += `[SEKCIJA: ${section.sectionTitle}]\n`;
        prompt += `[RELEVANTNOST: ${(section.relevanceScore * 100).toFixed(1)}%]\n\n`;
        prompt += section.content;
        prompt += '\n\n---\n\n';
      });
    } else {
      prompt += 'NAPOMENA: Nisu pronađeni relevantni materijali za ovo pitanje.\n\n';
    }
    
    return prompt;
  }

  async generateResponse(request: GPTRequest): Promise<GPTResponse> {
    try {
      const systemPrompt = this.buildSystemPrompt(request.mode, request.subject);
      const userPrompt = this.buildUserPrompt(request.userMessage, request.relevantSections);

      const completion = await openai.chat.completions.create({
        model: 'gpt-5-nano', 
        messages: [
          {
            role: 'system',
            content: systemPrompt
          },
          {
            role: 'user',
            content: userPrompt
          }
        ]
      });

      const response = completion.choices[0]?.message?.content || 'Došlo je do greške pri generisanju odgovora.';
      const tokensUsed = completion.usage?.total_tokens || 0;

      return {
        content: response,
        tokensUsed
      };

    } catch (error) {
      console.error('GPT Service Error:', error);
      throw new Error('Greška pri komunikaciji sa AI modelom');
    }
  }
}

export const gptService = new GPTService();