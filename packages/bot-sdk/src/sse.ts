/** Server-Sent Events parsing. The stream route writes blocks of `field: value` lines separated by a blank line. */

export interface RawSse {
  event: string;
  id: string | null;
  data: string;
  /** Reconnect hint in ms, when the block carried `retry:`. */
  retry: number | null;
}

/** Splits a byte stream into SSE blocks. A block with no `data:` and no `retry:` (a comment) is dropped. */
export async function* parseSse(body: ReadableStream<Uint8Array>, signal?: AbortSignal): AsyncGenerator<RawSse> {
  const reader = body.getReader();
  // Aborting ends a pending read even when the body itself is not tied to the signal.
  const onAbort = () => void reader.cancel().catch(() => undefined);
  if (signal?.aborted) onAbort();
  else signal?.addEventListener("abort", onAbort, { once: true });
  const dec = new TextDecoder();
  let buf = "";
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      buf += dec.decode(value, { stream: true }).replace(/\r\n/g, "\n");
      let i: number;
      while ((i = buf.indexOf("\n\n")) >= 0) {
        const block = buf.slice(0, i);
        buf = buf.slice(i + 2);
        const ev = parseBlock(block);
        if (ev) yield ev;
      }
    }
  } finally {
    signal?.removeEventListener("abort", onAbort);
    try {
      await reader.cancel();
    } catch {
      /* already closed */
    }
  }
}

function parseBlock(block: string): RawSse | null {
  let event = "message";
  let id: string | null = null;
  let retry: number | null = null;
  const data: string[] = [];
  for (const line of block.split("\n")) {
    if (line === "" || line.startsWith(":")) continue;
    const c = line.indexOf(":");
    const field = c < 0 ? line : line.slice(0, c);
    const val = c < 0 ? "" : line.slice(c + 1).replace(/^ /, "");
    if (field === "event") event = val;
    else if (field === "id") id = val;
    else if (field === "retry" && /^\d+$/.test(val)) retry = Number(val);
    else if (field === "data") data.push(val);
  }
  if (data.length === 0 && retry === null) return null;
  return { event, id, data: data.join("\n"), retry };
}
