// One OpenAI-compatible client, configured only by env (LLM_API_KEY, LLM_BASE_URL, LLM_MODEL).

export function llmConfigured(): boolean {
  return Boolean(process.env.LLM_API_KEY && process.env.LLM_BASE_URL && process.env.LLM_MODEL);
}

export async function chat(system: string, user: string, timeoutMs = 45000): Promise<string> {
  if (!llmConfigured()) throw new Error("LLM is not configured (set LLM_API_KEY, LLM_BASE_URL, LLM_MODEL)");
  const res = await fetch(`${process.env.LLM_BASE_URL!.replace(/\/$/, "")}/chat/completions`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${process.env.LLM_API_KEY}` },
    body: JSON.stringify({
      model: process.env.LLM_MODEL,
      temperature: 0,
      messages: [
        { role: "system", content: system },
        { role: "user", content: user },
      ],
    }),
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!res.ok) throw new Error(`LLM request failed with status ${res.status}`);
  const data = await res.json();
  const content = data?.choices?.[0]?.message?.content;
  if (typeof content !== "string" || !content.trim()) throw new Error("LLM returned an empty answer");
  return content;
}

/** Parses the first JSON object in a model answer (handles ```json fences). */
export function parseJson<T>(text: string): T {
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start < 0 || end <= start) throw new Error("LLM answer contained no JSON object");
  return JSON.parse(text.slice(start, end + 1)) as T;
}

export async function chatJson<T>(system: string, user: string): Promise<T> {
  try {
    return parseJson<T>(await chat(system, user));
  } catch (first) {
    // One retry: models occasionally wrap or truncate JSON.
    try {
      return parseJson<T>(await chat(system + " Reply with one JSON object and nothing else.", user));
    } catch {
      throw first;
    }
  }
}
