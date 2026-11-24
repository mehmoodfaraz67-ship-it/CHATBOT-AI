import { GoogleGenAI, ThinkingLevel } from "@google/genai";

export const maxDuration = 30;

const PRIMARY_MODEL = "gemini-3.1-flash-lite";
const FALLBACK_MODEL = "gemini-4-hydrogen";
const MAX_CONTEXT_MESSAGES = 16;

interface ChatMessageInput {
  role: "user" | "model";
  text: string;
}

let cachedClient: { apiKey: string; client: GoogleGenAI } | null = null;

function getGeminiClient(): GoogleGenAI {
  const apiKey = process.env.GEMINI_API_KEY?.trim();
  if (!apiKey) {
    throw new Error(
      "Gemini API key is not configured. Please add GEMINI_API_KEY in Settings > Secrets or Vercel Environment Variables."
    );
  }
  if (cachedClient && cachedClient.apiKey === apiKey) {
    return cachedClient.client;
  }
  const client = new GoogleGenAI({
    apiKey,
    httpOptions: {
      headers: {
        "User-Agent": "aistudio-build",
      },
    },
  });
  cachedClient = { apiKey, client };
  return client;
}

function extractReadableErrorMessage(raw: string): string {
  let current = raw.trim();
  for (let i = 0; i < 3; i++) {
    if (!current.startsWith("{")) break;
    try {
      const parsed = JSON.parse(current) as Record<string, unknown>;
      if (parsed.error && typeof parsed.error === "object") {
        const inner = parsed.error as Record<string, unknown>;
        if (typeof inner.message === "string") {
          current = inner.message.trim();
          continue;
        }
      }
      if (typeof parsed.message === "string") {
        current = parsed.message.trim();
        continue;
      }
    } catch {
      break;
    }
    break;
  }
  return current;
}

function parseGeminiError(err: unknown): {
  status: number;
  message: string;
  shouldFallback: boolean;
} {
  const rawMessage =
    err instanceof Error ? err.message : "An unexpected error occurred.";
  const readable = extractReadableErrorMessage(rawMessage);

  if (
    rawMessage.includes("API_KEY_INVALID") ||
    rawMessage.includes("PERMISSION_DENIED") ||
    rawMessage.toLowerCase().includes("gemini api key is not configured")
  ) {
    return {
      status: 403,
      message:
        "Invalid or missing Gemini API key. Please check GEMINI_API_KEY in Settings > Secrets or Vercel Environment Variables.",
      shouldFallback: false,
    };
  }

  if (rawMessage.includes("RESOURCE_EXHAUSTED") || rawMessage.includes("429")) {
    return {
      status: 429,
      message:
        "Rate limit or quota exceeded. Please wait a moment and try again.",
      shouldFallback: false,
    };
  }

  if (
    rawMessage.includes("UNAVAILABLE") ||
    rawMessage.includes("503") ||
    rawMessage.includes("high demand") ||
    rawMessage.includes("fetch failed") ||
    rawMessage.includes("ECONNRESET") ||
    rawMessage.includes("ETIMEDOUT") ||
    rawMessage.includes("socket")
  ) {
    return {
      status: 503,
      message: "Gemini is temporarily busy. Please try again in a moment.",
      shouldFallback: true,
    };
  }

  if (rawMessage.includes("NOT_FOUND") || rawMessage.includes("404")) {
    return {
      status: 404,
      message: "Requested Gemini model is unavailable.",
      shouldFallback: true,
    };
  }

  return {
    status: 500,
    message: readable || "Failed to generate a response from Gemini.",
    shouldFallback:
      rawMessage.includes("500") || rawMessage.includes("INTERNAL"),
  };
}

function sanitizeMessages(rawMessages: unknown): ChatMessageInput[] {
  if (!Array.isArray(rawMessages)) return [];
  return rawMessages
    .filter((item): item is ChatMessageInput => {
      if (!item || typeof item !== "object") return false;
      const candidate = item as Record<string, unknown>;
      return (
        (candidate.role === "user" || candidate.role === "model") &&
        typeof candidate.text === "string" &&
        candidate.text.trim().length > 0
      );
    })
    .map((item) => ({
      role: item.role,
      text: item.text.trim(),
    }));
}

function jsonResponse(status: number, payload: unknown): Response {
  return new Response(JSON.stringify(payload), {
    status,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "no-store",
    },
  });
}

export async function OPTIONS(): Promise<Response> {
  return new Response(null, {
    status: 204,
    headers: {
      Allow: "POST, OPTIONS",
    },
  });
}

export async function POST(request: Request): Promise<Response> {
  let body: { messages?: unknown } | null = null;
  try {
    body = (await request.json()) as { messages?: unknown };
  } catch {
    return jsonResponse(400, { error: "Invalid JSON request body." });
  }

  if (!body || !Array.isArray(body.messages) || body.messages.length === 0) {
    return jsonResponse(400, {
      error: "A non-empty messages array is required.",
    });
  }

  const sanitizedMessages = sanitizeMessages(body.messages);
  if (
    sanitizedMessages.length === 0 ||
    sanitizedMessages[sanitizedMessages.length - 1].role !== "user"
  ) {
    return jsonResponse(400, {
      error: "Conversation must end with a non-empty user message.",
    });
  }

  let ai: GoogleGenAI;
  try {
    ai = getGeminiClient();
  } catch (err) {
    const { status, message } = parseGeminiError(err);
    return jsonResponse(status, { error: message });
  }

  const recentMessages = sanitizedMessages.slice(-MAX_CONTEXT_MESSAGES);
  const contents = recentMessages.map((msg) => ({
    role: msg.role,
    parts: [{ text: msg.text }],
  }));

  const systemInstruction =
    "You are a fast, helpful, and concise AI assistant. Give direct, clear answers without unnecessary filler.";

  const attempts = [
    {
      model: PRIMARY_MODEL,
      thinkingLevel: ThinkingLevel.MINIMAL,
      firstTokenTimeoutMs: 8500,
    },
    {
      model: FALLBACK_MODEL,
      thinkingLevel: ThinkingLevel.LOW,
      firstTokenTimeoutMs: 8500,
    },
    {
      model: PRIMARY_MODEL,
      thinkingLevel: ThinkingLevel.MINIMAL,
      firstTokenTimeoutMs: 7000,
      onlyAfterFastError: true,
    },
  ];

  const encoder = new TextEncoder();
  let activeAbortController: AbortController | null = null;

  const onRequestAbort = () => {
    activeAbortController?.abort();
  };
  request.signal.addEventListener("abort", onRequestAbort, { once: true });

  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      const enqueueSse = (payload: unknown) => {
        controller.enqueue(
          encoder.encode(`data: ${JSON.stringify(payload)}\n\n`)
        );
      };

      // Flush SSE heartbeat immediately so proxies start streaming right away
      controller.enqueue(encoder.encode(": open\n\n"));

      try {
        let lastError: unknown = null;
        let completed = false;
        let anyTimedOut = false;

        for (let i = 0; i < attempts.length; i++) {
          if (request.signal.aborted) break;

          const attempt = attempts[i];
          if (attempt.onlyAfterFastError && anyTimedOut) {
            break;
          }

          if (i === 2) {
            await new Promise((resolve) => setTimeout(resolve, 250));
            if (request.signal.aborted) break;
          }

          const attemptController = new AbortController();
          activeAbortController = attemptController;

          let timedOut = false;
          const timer = setTimeout(() => {
            timedOut = true;
            attemptController.abort();
          }, attempt.firstTokenTimeoutMs);

          try {
            const geminiStream = await ai.models.generateContentStream({
              model: attempt.model,
              contents,
              config: {
                abortSignal: attemptController.signal,
                thinkingConfig: { thinkingLevel: attempt.thinkingLevel },
                systemInstruction,
              },
            });

            const iterator = geminiStream[Symbol.asyncIterator]();
            let firstText = "";

            while (true) {
              const step = await iterator.next();
              if (step.done) break;
              const text = step.value.text ?? "";
              if (text) {
                firstText = text;
                break;
              }
            }

            clearTimeout(timer);

            if (!firstText) {
              throw new Error("Model returned an empty response.");
            }

            if (request.signal.aborted) break;

            enqueueSse({ text: firstText });

            while (true) {
              if (request.signal.aborted) break;
              const step = await iterator.next();
              if (step.done) break;
              const text = step.value.text ?? "";
              if (text) {
                enqueueSse({ text });
              }
            }

            if (!request.signal.aborted) {
              enqueueSse({ done: true });
            }

            completed = true;
            break;
          } catch (err) {
            clearTimeout(timer);
            if (request.signal.aborted) break;

            if (timedOut) {
              anyTimedOut = true;
              lastError = new Error(
                "Gemini took too long to respond. Please try again."
              );
              if (i < attempts.length - 1) continue;
              throw lastError;
            }

            lastError = err;
            const parsed = parseGeminiError(err);
            if (!parsed.shouldFallback || i === attempts.length - 1) {
              throw err;
            }
          } finally {
            if (activeAbortController === attemptController) {
              activeAbortController = null;
            }
          }
        }

        if (!completed && !request.signal.aborted) {
          throw (
            lastError ?? new Error("Failed to generate a response from Gemini.")
          );
        }
      } catch (err) {
        if (!request.signal.aborted) {
          const { message } = parseGeminiError(err);
          enqueueSse({ error: message });
        }
      } finally {
        request.signal.removeEventListener("abort", onRequestAbort);
        try {
          controller.close();
        } catch {
          // Stream already closed
        }
      }
    },
    cancel() {
      activeAbortController?.abort();
    },
  });

  return new Response(stream, {
    status: 200,
    headers: {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
    },
  });
}
