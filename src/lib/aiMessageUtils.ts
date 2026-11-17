import type { AIMessage } from '../types/database.ts';

export const AI_MESSAGE_MAX_LENGTH = 10000;

export class AICompanionValidationError extends Error {
  code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = 'AICompanionValidationError';
    this.code = code;
  }
}

export interface CompanionApiResponsePayload {
  reply: string;
  groundedSummary?: {
    scholarshipsCount: number;
    eligibleCount: number;
    documentsCount: number;
    marksheetsCount: number;
    readinessPercent: number;
  };
}

/**
 * Validates and builds a clean AIMessage object suitable for Firestore `setDoc`.
 * Guarantees `content` is a non-empty string within Firestore rule limits
 * and removes any risk of `undefined` field values.
 */
export function validateAndBuildAIMessage(input: {
  id?: unknown;
  conversationId?: unknown;
  userId?: unknown;
  role?: unknown;
  content?: unknown;
  createdAt?: unknown;
}): AIMessage {
  if (typeof input.id !== 'string' || !input.id.trim()) {
    throw new AICompanionValidationError(
      'INVALID_MESSAGE_ID',
      'Unable to save message because the message identifier is missing.'
    );
  }
  if (typeof input.conversationId !== 'string' || !input.conversationId.trim()) {
    throw new AICompanionValidationError(
      'INVALID_CONVERSATION_ID',
      'Unable to save message because no active conversation thread was found.'
    );
  }
  if (typeof input.userId !== 'string' || !input.userId.trim()) {
    throw new AICompanionValidationError(
      'INVALID_USER_ID',
      'Authentication is required before saving conversation messages.'
    );
  }
  if (input.role !== 'user' && input.role !== 'assistant') {
    throw new AICompanionValidationError(
      'INVALID_MESSAGE_ROLE',
      'Unable to save message due to an invalid sender role.'
    );
  }
  if (typeof input.content !== 'string') {
    throw new AICompanionValidationError(
      'INVALID_MESSAGE_CONTENT',
      input.role === 'assistant'
        ? 'AI Companion did not return a valid text response. Please retry.'
        : 'Please enter a valid message before sending.'
    );
  }

  const trimmed = input.content.trim();
  if (!trimmed) {
    throw new AICompanionValidationError(
      'EMPTY_MESSAGE_CONTENT',
      input.role === 'assistant'
        ? 'AI Companion returned an empty response. Please retry.'
        : 'Message cannot be empty.'
    );
  }

  if (input.content.length > AI_MESSAGE_MAX_LENGTH) {
    throw new AICompanionValidationError(
      'MESSAGE_TOO_LONG',
      `Message exceeds the maximum length of ${AI_MESSAGE_MAX_LENGTH} characters.`
    );
  }

  const createdAt =
    typeof input.createdAt === 'string' && input.createdAt.trim().length >= 10
      ? input.createdAt.trim().slice(0, 40)
      : new Date().toISOString();

  return {
    id: input.id.trim(),
    conversationId: input.conversationId.trim(),
    userId: input.userId.trim(),
    role: input.role,
    content: input.role === 'user' ? trimmed : input.content,
    createdAt,
  };
}

/**
 * Validates the response payload returned from POST /api/ai/companion
 * before attempting to construct or persist an assistant AIMessage.
 */
export function parseCompanionApiResponse(payload: unknown): CompanionApiResponsePayload {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    throw new AICompanionValidationError(
      'MALFORMED_API_RESPONSE',
      'AI Companion returned an invalid response format. Please retry.'
    );
  }

  const record = payload as Record<string, unknown>;
  if (typeof record.reply !== 'string' || !record.reply.trim()) {
    throw new AICompanionValidationError(
      'MISSING_AI_REPLY',
      'AI Companion did not return a response message. Please retry.'
    );
  }

  const boundedReply = boundCompanionReplyForStorage(record.reply);
  if (!boundedReply) {
    throw new AICompanionValidationError(
      'MISSING_AI_REPLY',
      'AI Companion returned an empty response. Please retry.'
    );
  }

  return {
    reply: boundedReply,
    groundedSummary:
      record.groundedSummary && typeof record.groundedSummary === 'object'
        ? (record.groundedSummary as CompanionApiResponsePayload['groundedSummary'])
        : undefined,
  };
}

/**
 * Ensures non-empty Gemini replies stay within Firestore's 10,000-char limit
 * for `ai_messages.content` without fabricating placeholder text when empty.
 */
export function boundCompanionReplyForStorage(rawReply: string): string {
  const trimmed = rawReply.trim();
  if (!trimmed) return '';
  if (trimmed.length <= AI_MESSAGE_MAX_LENGTH) return trimmed;

  const suffix = '\n\n[Response truncated to fit message storage limit.]';
  const maxBodyLen = AI_MESSAGE_MAX_LENGTH - suffix.length;
  const slice = trimmed.slice(0, maxBodyLen);
  const lastBreak = Math.max(slice.lastIndexOf('\n'), slice.lastIndexOf('. '), slice.lastIndexOf(' '));
  const body = lastBreak > maxBodyLen * 0.6 ? slice.slice(0, lastBreak).trimEnd() : slice.trimEnd();
  return `${body}${suffix}`;
}

/**
 * Normalizes retrieved Firestore `ai_messages` documents:
 * filters out any corrupted/incomplete docs (e.g. missing string `content`),
 * deduplicates by `id`, and sorts chronologically.
 */
export function normalizeRetrievedMessages(
  rawMessages: unknown[],
  conversationId?: string
): AIMessage[] {
  const seen = new Set<string>();
  const valid: AIMessage[] = [];

  for (const item of rawMessages) {
    if (!item || typeof item !== 'object') continue;
    const candidate = item as Partial<AIMessage>;
    if (
      typeof candidate.id !== 'string' ||
      !candidate.id.trim() ||
      typeof candidate.conversationId !== 'string' ||
      !candidate.conversationId.trim() ||
      typeof candidate.userId !== 'string' ||
      !candidate.userId.trim() ||
      (candidate.role !== 'user' && candidate.role !== 'assistant') ||
      typeof candidate.content !== 'string' ||
      !candidate.content.trim() ||
      typeof candidate.createdAt !== 'string' ||
      !candidate.createdAt.trim()
    ) {
      continue;
    }

    if (conversationId && candidate.conversationId !== conversationId) {
      continue;
    }
    if (seen.has(candidate.id)) {
      continue;
    }
    seen.add(candidate.id);
    valid.push({
      id: candidate.id,
      conversationId: candidate.conversationId,
      userId: candidate.userId,
      role: candidate.role,
      content: candidate.content,
      createdAt: candidate.createdAt,
    });
  }

  return valid.sort((a, b) => a.createdAt.localeCompare(b.createdAt));
}

/**
 * Translates raw Firebase / Firestore JSON error payloads into readable messages
 * safe for student-facing UI display.
 */
export function formatCompanionErrorMessage(err: unknown, fallback: string): string {
  if (err instanceof AICompanionValidationError) {
    return err.message;
  }

  const raw = err instanceof Error ? err.message : typeof err === 'string' ? err : '';
  if (!raw) return fallback;

  let extracted = raw;
  if (raw.startsWith('{') && raw.endsWith('}')) {
    try {
      const parsed = JSON.parse(raw) as { error?: unknown };
      if (typeof parsed.error === 'string' && parsed.error.trim()) {
        extracted = parsed.error.trim();
      }
    } catch {
      // Keep raw string for pattern matching below
    }
  }

  const lower = extracted.toLowerCase();
  if (lower.includes('unsupported field value: undefined') || lower.includes('setdoc() called with invalid data')) {
    return 'Unable to save message because its content was missing or incomplete. Please retry.';
  }
  if (lower.includes('permission-denied') || lower.includes('missing or insufficient permissions')) {
    return 'Permission denied while accessing conversation history. Please sign in again with a verified email.';
  }
  if (lower.includes('offline') || lower.includes('network') || lower.includes('failed to fetch')) {
    return 'Network connection error while reaching AI Companion. Please check your connection and retry.';
  }
  if (lower.includes('not authenticated') || lower.includes('expired')) {
    return 'Your session expired. Please sign in again to continue.';
  }

  // Avoid exposing raw JSON blobs even if JSON didn't match expected shape
  if (extracted.startsWith('{') && extracted.endsWith('}')) {
    return fallback;
  }

  return extracted;
}
