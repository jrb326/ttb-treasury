/**
 * OpenAI-compatible chat client backed by Cloudflare's REST endpoint.
 *
 * Only route that actually receives image pixels on this account: the native
 * `env.AI.run` image inputs (moondream `{}`, `prompt+images`, content-blocks)
 * all silently dropped the image — measured hallucinated answers and empty
 * outputs. `/ai/v1/chat/completions` returned correct reads on every fixture.
 */

export const VISION_MODEL = "@cf/meta/llama-4-scout-17b-16e-instruct";

export interface TextPart { type: "text"; text: string }
export interface ImagePart { type: "image_url"; image_url: { url: string } }
export type ChatContent = TextPart | ImagePart;

/** Minimal surface the extractor needs; tests fake this without touching HTTP. */
export interface ChatClient {
  complete(content: ChatContent[], opts?: { maxTokens?: number }): Promise<string>;
  /**
   * CUMULATIVE token usage across every successful call this client has
   * made — summed, never overwritten. Retry-on-garbage in src/extract.ts
   * makes two calls per label sometimes; the budget ledger must see both,
   * and callers derive per-call cost as the delta between observations.
   * Starts at null (no successful call yet): callers report 0, never guess.
   */
  usageTotal?: { prompt: number; completion: number } | null;
}

export interface RestChatEnv {
  CF_ACCOUNT_ID: string;
  /**
   * API token with Account → Workers AI → Edit (from a token file, never chat:
   * set via `wrangler secret put AGENT_AI_TOKEN` / mirrored in .dev.vars).
   */
  AGENT_AI_TOKEN: string;
}

const COMPLETIONS_TIMEOUT_MS = 9000;

export function restChatClient(env: RestChatEnv): ChatClient {
  const client: ChatClient = {
    usageTotal: null,
    async complete(content, opts) {
      const url = `https://api.cloudflare.com/client/v4/accounts/${env.CF_ACCOUNT_ID}/ai/v1/chat/completions`;
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), COMPLETIONS_TIMEOUT_MS);
      try {
        const r = await fetch(url, {
          method: "POST",
          headers: {
            Authorization: `Bearer ${env.AGENT_AI_TOKEN}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            model: VISION_MODEL,
            messages: [{ role: "user", content }],
            max_tokens: opts?.maxTokens ?? 600,
            temperature: 0,
          }),
          signal: controller.signal,
        });
        if (!r.ok) throw new Error(`completions HTTP ${r.status}: ${(await r.text()).slice(0, 200)}`);
        const data = (await r.json()) as {
          choices?: Array<{ message?: { content?: unknown } }>;
          usage?: { prompt_tokens?: number; completion_tokens?: number };
        };
        const text = data.choices?.[0]?.message?.content;
        if (typeof text !== "string" || text.length === 0) throw new Error("empty completion");
        const prev = client.usageTotal;
        client.usageTotal = {
          prompt: (prev?.prompt ?? 0) + (data.usage?.prompt_tokens ?? 0),
          completion: (prev?.completion ?? 0) + (data.usage?.completion_tokens ?? 0),
        };
        return text;
      } finally {
        clearTimeout(timer);
      }
    },
  };
  return client;
}