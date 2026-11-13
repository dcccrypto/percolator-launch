// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({
  list: vi.fn(),
}));

vi.mock("@vercel/blob", () => ({
  list: h.list,
  put: vi.fn(),
  del: vi.fn(),
}));

// Real implementation, not mocked.
import { readRegisteredMarkets } from "@/lib/playground-registered-markets";

beforeEach(() => {
  h.list.mockReset();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("V22 real Blob abort propagation", () => {
  it("CONTROL: signal reaches Blob list()", async () => {
    const controller = new AbortController();

    h.list.mockImplementation(
      ({ abortSignal }: { abortSignal?: AbortSignal }) =>
        new Promise((_, reject) => {
          abortSignal?.addEventListener(
            "abort",
            () => reject(new Error("list aborted")),
            { once: true },
          );
        })
    );

    const pending = readRegisteredMarkets(controller.signal);

    await vi.waitFor(() => {
      expect(h.list).toHaveBeenCalledTimes(1);
    });

    expect(h.list.mock.calls[0][0].abortSignal)
      .toBe(controller.signal);

    controller.abort();

    expect(await pending).toEqual([]);

    console.log("REAL_BLOB_LIST_ABORT=PASS");
  });

  it("CONTROL: signal reaches snapshot fetch()", async () => {
    const controller = new AbortController();

    h.list.mockResolvedValue({
      blobs: [{
        pathname:
          "playground/registered-markets/v000000000001.json",
        url: "https://blob.test/v1",
      }],
      hasMore: false,
    });

    const fetchMock = vi.fn(
      (_url: string, options: RequestInit) =>
        new Promise<Response>((_, reject) => {
          options.signal?.addEventListener(
            "abort",
            () => reject(new Error("fetch aborted")),
            { once: true },
          );
        })
    );

    vi.stubGlobal("fetch", fetchMock);

    const pending = readRegisteredMarkets(controller.signal);

    await vi.waitFor(() => {
      expect(fetchMock).toHaveBeenCalledTimes(1);
    });

    expect(h.list.mock.calls[0][0].abortSignal)
      .toBe(controller.signal);

    expect(fetchMock.mock.calls[0][1].signal)
      .toBe(controller.signal);

    controller.abort();

    expect(await pending).toEqual([]);

    console.log("REAL_BLOB_FETCH_ABORT=PASS");
  });
});
