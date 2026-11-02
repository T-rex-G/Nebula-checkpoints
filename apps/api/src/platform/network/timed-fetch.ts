/*
 * A fetch with a deadline that covers the whole response, body included.
 *
 * The deadline aborts the request if it has not finished by then. A response
 * that arrives in time is handed back with its body wrapped, so the deadline
 * keeps running while the body is read and is cleared only once the body has
 * been read to its end, failed, or been cancelled. A provider that sends its
 * headers promptly and then stalls the body cannot hold a request open past
 * it. The timer never keeps the process alive.
 */

/*
 * What a caller hands in: options it built, often around an address or headers
 * a provider's answer named. They are typed no tighter than the caller holds
 * them, and fetch reads them as it always has.
 */
export type TimedFetchOptions = RequestInit | Readonly<Record<string, unknown>>;

export async function fetchWithDeadline(url: unknown, options: TimedFetchOptions = {}, ms = 20000): Promise<Response> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(new Error(`Upstream timeout after ${ms / 1000}s`)), ms);
  if (typeof timeout.unref === 'function') timeout.unref();
  let response: Response;
  try {
    response = await fetch(url as string | URL, { ...options, signal: controller.signal } as RequestInit);
  } catch (error) {
    clearTimeout(timeout);
    throw error;
  }
  if (!response.body) {
    clearTimeout(timeout);
    return response;
  }
  const reader = response.body.getReader();
  const body = new ReadableStream({
    async pull(streamController) {
      try {
        const { done, value } = await reader.read();
        if (done) {
          clearTimeout(timeout);
          streamController.close();
        } else streamController.enqueue(value);
      } catch (error) {
        clearTimeout(timeout);
        streamController.error(error);
      }
    },
    async cancel(reason) {
      clearTimeout(timeout);
      try { await reader.cancel(reason); } catch {}
    }
  });
  return new Response(body, {
    status: response.status,
    statusText: response.statusText,
    headers: response.headers
  });
}
