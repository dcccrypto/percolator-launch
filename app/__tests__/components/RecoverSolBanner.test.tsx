import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { RecoverSolBanner } from "@/components/create/RecoverSolBanner";
import { PublicKey, Keypair } from "@solana/web3.js";

// ─── Mocks ───

let mockStuckSlab: {
  publicKey: PublicKey;
  isInitialized: boolean;
  exists: boolean;
  keypair: Keypair | null;
  lamports: number;
  owner: string | null;
} | null = null;

let mockLoading = false;
const mockClearStuck = vi.fn();
const mockRefresh = vi.fn();

vi.mock("@/hooks/useStuckSlabs", () => ({
  useStuckSlabs: () => ({
    stuckSlab: mockStuckSlab,
    loading: mockLoading,
    clearStuck: mockClearStuck,
    refresh: mockRefresh,
  }),
}));

// ─── Helpers ───

function makeStuckSlab(overrides: Partial<typeof mockStuckSlab & object> = {}) {
  const kp = Keypair.generate();
  return {
    publicKey: kp.publicKey,
    isInitialized: false,
    exists: true,
    keypair: kp,
    lamports: 2_000_000_000,
    owner: "ProgramId111111111111111111111111111111111",
    ...overrides,
  };
}

// ─── Tests ───

describe("RecoverSolBanner", () => {
  beforeEach(() => {
    mockStuckSlab = null;
    mockLoading = false;
    vi.clearAllMocks();
  });

  it("renders nothing when loading", () => {
    mockLoading = true;
    const { container } = render(<RecoverSolBanner />);
    expect(container.innerHTML).toBe("");
  });

  it("renders nothing when no stuck slab", () => {
    mockStuckSlab = null;
    const { container } = render(<RecoverSolBanner />);
    expect(container.innerHTML).toBe("");
  });

  it("shows info message for non-existent account (rolled back)", () => {
    mockStuckSlab = makeStuckSlab({ exists: false, lamports: 0 });
    render(<RecoverSolBanner />);
    expect(screen.getByText(/Previous attempt detected/i)).toBeDefined();
    expect(screen.getByText(/No SOL was lost/i)).toBeDefined();
    expect(screen.getByRole("button", { name: /CLEAR/i })).toBeDefined();
  });

  it("shows resume banner for initialized slab", () => {
    mockStuckSlab = makeStuckSlab({ isInitialized: true, exists: true });
    const onResume = vi.fn();
    render(<RecoverSolBanner onResume={onResume} />);
    expect(screen.getByText(/Incomplete Market Found/i)).toBeDefined();
    expect(screen.getByRole("button", { name: /RESUME/i })).toBeDefined();
    expect(screen.getByRole("button", { name: /DISCARD/i })).toBeDefined();
  });

  it("shows warning banner for uninitialized stuck slab", () => {
    mockStuckSlab = makeStuckSlab({ isInitialized: false, exists: true });
    const onResume = vi.fn();
    render(<RecoverSolBanner onResume={onResume} />);
    expect(screen.getByText(/Stuck Slab Account Detected/i)).toBeDefined();
    expect(screen.getByRole("button", { name: /RETRY INITIALIZATION/i })).toBeDefined();
    expect(screen.getByText(/VIEW ON EXPLORER/i)).toBeDefined();
  });

  it("calls onResume with slab address when resume clicked", () => {
    const kp = Keypair.generate();
    mockStuckSlab = makeStuckSlab({ isInitialized: true, exists: true, publicKey: kp.publicKey });
    const onResume = vi.fn();
    render(<RecoverSolBanner onResume={onResume} />);

    fireEvent.click(screen.getByRole("button", { name: /RESUME/i }));
    expect(onResume).toHaveBeenCalledWith(kp.publicKey.toBase58());
  });

  it("calls clearStuck when discard clicked", () => {
    mockStuckSlab = makeStuckSlab({ isInitialized: true, exists: true });
    render(<RecoverSolBanner />);

    fireEvent.click(screen.getByRole("button", { name: /DISCARD/i }));
    expect(mockClearStuck).toHaveBeenCalled();
  });

  it("dismiss button hides the banner", () => {
    mockStuckSlab = makeStuckSlab({ isInitialized: true, exists: true });
    render(<RecoverSolBanner />);

    expect(screen.getByText(/Incomplete Market Found/i)).toBeDefined();

    fireEvent.click(screen.getByRole("button", { name: /Dismiss/i }));

    // After dismissing, the banner should be hidden
    expect(screen.queryByText(/Incomplete Market Found/i)).toBeNull();
  });

  it("shows correct rent amount in SOL", () => {
    mockStuckSlab = makeStuckSlab({
      isInitialized: true,
      exists: true,
      lamports: 3_500_000_000, // 3.5 SOL
    });
    render(<RecoverSolBanner />);
    expect(screen.getByText(/3\.5000 SOL/)).toBeDefined();
  });

  it("shows explorer link for stuck uninitialized slab", () => {
    const kp = Keypair.generate();
    mockStuckSlab = makeStuckSlab({
      isInitialized: false,
      exists: true,
      publicKey: kp.publicKey,
    });
    render(<RecoverSolBanner />);

    // Find the link by its role and name
    const explorerLinks = screen.getAllByRole("link");
    const explorerLink = explorerLinks.find(l => l.textContent?.includes("VIEW ON EXPLORER"));
    expect(explorerLink).toBeDefined();
    expect(explorerLink?.getAttribute("href")).toContain(kp.publicKey.toBase58());
    expect(explorerLink?.getAttribute("target")).toBe("_blank");
  });
});
