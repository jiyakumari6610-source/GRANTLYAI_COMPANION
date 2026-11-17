import { GoogleGenAI, ThinkingLevel, Type } from '@google/genai';

export const GEMINI_MODEL = 'gemini-4-hydrogen';
export const GEMINI_COMPANION_MODEL = 'gemini-3.1-flash-lite';

let cachedClient: GoogleGenAI | null = null;

export function getGeminiClient(): GoogleGenAI {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey || apiKey === 'MY_GEMINI_API_KEY') {
    throw new Error('GEMINI_API_KEY is not configured on the server.');
  }

  if (!cachedClient) {
    cachedClient = new GoogleGenAI({
      apiKey,
      httpOptions: {
        headers: {
          'User-Agent': 'aistudio-build',
        },
      },
    });
  }

  return cachedClient;
}

export { ThinkingLevel, Type };
