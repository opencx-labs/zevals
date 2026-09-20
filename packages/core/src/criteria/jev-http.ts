/*
 * Shared HTTP plumbing for the bundled JevClients. Every provider speaks the same
 * conversation — POST one question about one state, read one probability back — and
 * differs only in the URL, the request envelope and the name of the answer field.
 * This module holds what they share; each client owns its own wire shape.
 *
 * Not exported from the public surface.
 */

/** The single question key every bundled client sends. */
export const QUESTION_KEY = 'q0';

/** Max characters of an error response body kept in the thrown error (and so in test logs). */
const ERROR_BODY_LIMIT = 500;

/** Reads a required credential from an option or the environment. */
export function requireCredential({
  value,
  option,
  envVar,
  provider,
}: {
  value: string | undefined;
  option: string;
  envVar: string;
  provider: string;
}): string {
  const credential = value ?? process.env[envVar];
  if (!credential) {
    throw new Error(`${provider} missing: pass ${option} or set ${envVar}`);
  }

  return credential;
}

/**
 * POSTs `body` as JSON with a bearer token and returns the parsed response.
 * Non-2xx responses throw with `label` and a bounded excerpt of the body; callers
 * validate the returned value with zod.
 */
export async function postJson({
  url,
  token,
  body,
  label,
  fetch: doFetch,
}: {
  url: string;
  token: string;
  body: unknown;
  label: string;
  fetch: typeof fetch;
}): Promise<unknown> {
  const response = await doFetch(url, {
    method: 'POST',
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });

  if (!response.ok) {
    throw new Error(`${label} request failed: ${response.status} ${await bodyExcerpt(response)}`);
  }

  return response.json();
}

/**
 * Reads at most {@link ERROR_BODY_LIMIT} characters of the body, whitespace-collapsed.
 * Best effort: a failing stream yields what was read so far, never an error that would
 * replace the HTTP status in the caller's message.
 */
async function bodyExcerpt(response: Response): Promise<string> {
  const reader = response.body?.getReader();
  if (!reader) return '';

  const decoder = new TextDecoder();
  let text = '';
  try {
    while (text.length <= ERROR_BODY_LIMIT) {
      const { done, value } = await reader.read();
      if (done) break;
      text += decoder.decode(value, { stream: true });
    }
    await reader.cancel();
  } catch {
    // Keep whatever was read; the status code is what matters.
  }

  text = text.replace(/\s+/g, ' ').trim();

  return text.length > ERROR_BODY_LIMIT ? `${text.slice(0, ERROR_BODY_LIMIT)}…` : text;
}
