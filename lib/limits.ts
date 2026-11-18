// Limits shared by the server pipeline and the UI (no server-only imports here).
export const MAX_BYTES = 4 * 1024 * 1024; // Vercel function request bodies are capped near 4.5 MB.
export const MIN_TEXT_CHARS = 120; // fewer real characters than this means the invoice itself is an image
