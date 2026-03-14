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

// Mock useCloseMarket — keeps wallet/connection dependencies out of unit tests.
let mockCloseSlab = vi.fn().mockResolvedValue(null);
let mockCloseLoading = false;
let mockCloseError: string | null = null;

vi.mock("@/hooks/useCloseMarket", () => ({
  useCloseMarket: () => ({
    closeSlab: mockCloseSlab,
    loading: mockCloseLoading,
    error: mockCloseError,
  }),
}));

const mockReclaim = vi.fn();
let mockReclaimStatus: "idle" | "sending" | "success" | "error" = "idle";
let mockReclaimError: string | null = null;
let mockReclaimTxSig: string | null = null;

vi.mock("@/hooks/useReclaimSlabRent", () => ({
  useReclaimSlabRent: () => ({
    status: mockReclaimStatus,
    error: mockReclaimError,
    txSig: mockReclaimTxSig,
    reclaim: mockReclaim,
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
    mockCloseLoading = false;
    mockCloseError = null;
    mockCloseSlab = vi.fn().mockResolvedValue(null);
    mockReclaimStatus = "idle";
    mockReclaimError = null;
    mockReclaimTxSig = null;
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
    // PERC-511: banner text updated to reflect recoverability
    expect(screen.getByText(/Stuck Slab — SOL Recoverable/i)).toBeDefined();
    expect(screen.getByRole("button", { name: /RECLAIM/i })).toBeDefined();
    expect(screen.getByRole("button", { name: /RETRY INITIALIZATION/i })).toBeDefined();
    expect(screen.getByText(/VIEW ON EXPLORER/i)).toBeDefined();
  });

  it("calls reclaim with slab keypair when Reclaim SOL clicked", () => {
    mockStuckSlab = makeStuckSlab({ isInitialized: false, exists: true });
    render(<RecoverSolBanner />);
    fireEvent.click(screen.getByRole("button", { name: /RECLAIM/i }));
    expect(mockReclaim).toHaveBeenCalledWith(mockStuckSlab!.keypair);
  });

  it("calls onResume with slab address and fromStep=1 when resume clicked on initialized slab", () => {
    const kp = Keypair.generate();
    mockStuckSlab = makeStuckSlab({ isInitialized: true, exists: true, publicKey: kp.publicKey });
    const onResume = vi.fn();
    render(<RecoverSolBanner onResume={onResume} />);

    fireEvent.click(screen.getByRole("button", { name: /RESUME/i }));
    expect(onResume).toHaveBeenCalledWith(kp.publicKey.toBase58(), 1);
  });

  it("calls onResume with slab address and fromStep=0 when retry clicked on uninitialized slab", () => {
    const kp = Keypair.generate();
    mockStuckSlab = makeStuckSlab({ isInitialized: false, exists: true, publicKey: kp.publicKey });
    const onResume = vi.fn();
    render(<RecoverSolBanner onResume={onResume} />);

    fireEvent.click(screen.getByRole("button", { name: /RETRY/i }));
    expect(onResume).toHaveBeenCalledWith(kp.publicKey.toBase58(), 0);
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
    // Multiple elements show the SOL amount (banner text + reclaim button)
    expect(screen.getAllByText(/3\.5000 SOL/).length).toBeGreaterThanOrEqual(1);
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

  it("shows RECLAIM button for initialized slab and calls closeSlab on click", async () => {
    const kp = Keypair.generate();
    mockStuckSlab = makeStuckSlab({
      isInitialized: true,
      exists: true,
      publicKey: kp.publicKey,
      lamports: 2_000_000_000,
    });
    mockCloseSlab = vi.fn().mockResolvedValue(null);
    render(<RecoverSolBanner />);

    const reclaimBtn = screen.getByRole("button", { name: /RECLAIM/i });
    expect(reclaimBtn).toBeDefined();
    expect(reclaimBtn.textContent).toMatch(/2\.0000 SOL/);
    fireEvent.click(reclaimBtn);
    expect(mockCloseSlab).toHaveBeenCalledWith(kp.publicKey.toBase58());
  });

  it("shows closeError message when closeSlab fails admin guard", () => {
    mockStuckSlab = makeStuckSlab({ isInitialized: true, exists: true });
    mockCloseError = "Only the market admin can close this slab.";
    render(<RecoverSolBanner />);
    expect(screen.getByText(/Only the market admin/i)).toBeDefined();
  });

  it("disables RECLAIM button while closeLoading is true", () => {
    mockStuckSlab = makeStuckSlab({ isInitialized: true, exists: true });
    mockCloseLoading = true;
    render(<RecoverSolBanner />);
    const reclaimBtn = screen.getByRole("button", { name: /RECLAIMING/i });
    expect(reclaimBtn).toHaveProperty("disabled", true);
  });

  // ── onReclaimSuccess callback ─────────────────────────────────────────────

  it("calls onReclaimSuccess + onReset when 'START NEW MARKET' clicked after reclaim success", () => {
    // Simulate the banner being in the post-reclaim success state
    mockStuckSlab = makeStuckSlab({ isInitialized: false, exists: true });
    mockReclaimStatus = "success";
    mockReclaimTxSig = "abc123txsig";

    const onReclaimSuccess = vi.fn();
    const onReset = vi.fn();
    render(<RecoverSolBanner onReclaimSuccess={onReclaimSuccess} onReset={onReset} />);

    const btn = screen.getByRole("button", { name: /START NEW MARKET/i });
    expect(btn).toBeDefined();
    fireEvent.click(btn);

    expect(onReclaimSuccess).toHaveBeenCalledOnce();
    expect(onReset).toHaveBeenCalledOnce();
    expect(mockClearStuck).toHaveBeenCalledOnce();
  });

  it("shows error message from useReclaimSlabRent when reclaim fails", () => {
    mockStuckSlab = makeStuckSlab({ isInitialized: false, exists: true });
    mockReclaimStatus = "error";
    mockReclaimError = "Transaction cancelled — you rejected the signing request.";

    render(<RecoverSolBanner />);
    expect(screen.getByText(/Transaction cancelled/i)).toBeDefined();
  });

  it("does NOT call onReclaimSuccess if user resets from non-success uninitialized banner", () => {
    mockStuckSlab = makeStuckSlab({ isInitialized: false, exists: true });
    mockReclaimStatus = "idle";

    const onReclaimSuccess = vi.fn();
    const onReset = vi.fn();
    render(<RecoverSolBanner onReclaimSuccess={onReclaimSuccess} onReset={onReset} />);

    fireEvent.click(screen.getByRole("button", { name: /DISCARD/i }));
    // onReset called (wizard reset), but onReclaimSuccess NOT called (no SOL was reclaimed)
    expect(onReset).toHaveBeenCalledOnce();
    expect(onReclaimSuccess).not.toHaveBeenCalled();
  });
});
