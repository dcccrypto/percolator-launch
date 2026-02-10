"use client";

import { FC, useCallback, useState, useEffect, useMemo, useRef } from "react";
import { useWallet } from "@solana/wallet-adapter-react";
import {
  Connection,
  Keypair,
  PublicKey,
  SystemProgram,
  Transaction,
  LAMPORTS_PER_SOL,
} from "@solana/web3.js";
import {
  MINT_SIZE,
  TOKEN_PROGRAM_ID,
  getMinimumBalanceForRentExemptMint,
  createInitializeMintInstruction,
  getAssociatedTokenAddress,
  createAssociatedTokenAccountInstruction,
  createMintToInstruction,
} from "@solana/spl-token";
import {
  createCreateMetadataAccountV3Instruction,
  PROGRAM_ID as TOKEN_METADATA_PROGRAM_ID,
} from "@metaplex-foundation/mpl-token-metadata";
import gsap from "gsap";
import { ScrollReveal } from "@/components/ui/ScrollReveal";
import { ShimmerSkeleton } from "@/components/ui/ShimmerSkeleton";
import { usePrefersReducedMotion } from "@/hooks/usePrefersReducedMotion";

const DEVNET_RPC = `https://devnet.helius-rpc.com/?api-key=${process.env.NEXT_PUBLIC_HELIUS_API_KEY ?? ""}`;
const DEFAULT_RECIPIENT = "HoibauLv7EPDTr3oCAwE1UETuUio6w8DZjKM5AoTWsUM";

const DevnetMintContent: FC = () => {
  const { publicKey, signTransaction, connected } = useWallet();
  const prefersReducedMotion = usePrefersReducedMotion();
  const successCardRef = useRef<HTMLDivElement>(null);

  const [balance, setBalance] = useState<number | null>(null);
  const [decimals, setDecimals] = useState(9);
  const [supply, setSupply] = useState("100000");
  const [recipient, setRecipient] = useState(DEFAULT_RECIPIENT);
  const [mintAddress, setMintAddress] = useState<string | null>(null);
  const [status, setStatus] = useState("");
  const [loading, setLoading] = useState(false);
  const [airdropping, setAirdropping] = useState(false);
  const [copied, setCopied] = useState(false);
  const [tokenName, setTokenName] = useState("Test Token");
  const [tokenSymbol, setTokenSymbol] = useState("TEST");
  const [mintColor, setMintColor] = useState<string | null>(null);
  const [lastTxSig, setLastTxSig] = useState<string | null>(null);

  const connection = useMemo(() => new Connection(DEVNET_RPC, "confirmed"), []);

  // Set recipient to connected wallet if available
  useEffect(() => {
    if (publicKey && recipient === DEFAULT_RECIPIENT) {
      setRecipient(publicKey.toBase58());
    }
  }, [publicKey]); // eslint-disable-line react-hooks/exhaustive-deps

  // Fetch devnet balance
  const refreshBalance = useCallback(async () => {
    if (!publicKey) return;
    try {
      const bal = await connection.getBalance(publicKey);
      setBalance(bal / LAMPORTS_PER_SOL);
    } catch {
      setBalance(null);
    }
  }, [publicKey]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    refreshBalance();
  }, [refreshBalance]);

  // GSAP scale-in for success card
  useEffect(() => {
    const el = successCardRef.current;
    if (!el || !mintAddress) return;

    if (prefersReducedMotion) {
      gsap.set(el, { opacity: 1, scale: 1 });
      return;
    }

    gsap.fromTo(
      el,
      { opacity: 0, scale: 0.85 },
      { opacity: 1, scale: 1, duration: 0.5, ease: "back.out(1.4)" }
    );
  }, [mintAddress, prefersReducedMotion]);

  // Airdrop 2 SOL
  const handleAirdrop = useCallback(async () => {
    if (!publicKey) return;
    setAirdropping(true);
    setStatus("Requesting 2 SOL airdrop…");
    try {
      const sig = await connection.requestAirdrop(publicKey, 2 * LAMPORTS_PER_SOL);
      // Poll for confirmation using getSignatureStatuses (more reliable than confirmTransaction)
      const startTime = Date.now();
      const TIMEOUT_MS = 60_000;
      while (Date.now() - startTime < TIMEOUT_MS) {
        const { value } = await connection.getSignatureStatuses([sig]);
        const status = value?.[0];
        if (status?.confirmationStatus === "confirmed" || status?.confirmationStatus === "finalized") {
          if (status.err) throw new Error(`Transaction failed: ${JSON.stringify(status.err)}`);
          break;
        }
        await new Promise(r => setTimeout(r, 2000));
      }
      setStatus("Airdrop successful!");
      await refreshBalance();
    } catch (e: unknown) {
      setStatus(`Airdrop failed: ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      setAirdropping(false);
    }
  }, [publicKey, refreshBalance]); // eslint-disable-line react-hooks/exhaustive-deps

  // Create mint + mint tokens
  const handleCreateAndMint = useCallback(async () => {
    if (!publicKey || !signTransaction) return;
    setLoading(true);
    setStatus("Creating mint…");
    setMintAddress(null);

    try {
      // Check SOL balance before attempting — prevents silent freeze on empty wallets
      const walletBalance = await connection.getBalance(publicKey);
      if (walletBalance < 0.01 * LAMPORTS_PER_SOL) {
        throw new Error("Not enough SOL. You need at least 0.01 SOL to create a mint. Use the airdrop button above.");
      }

      const mintKeypair = Keypair.generate();
      const recipientPubkey = new PublicKey(recipient);
      const lamports = await getMinimumBalanceForRentExemptMint(connection);

      // Build transaction: create account + init mint
      const tx = new Transaction();
      tx.add(
        SystemProgram.createAccount({
          fromPubkey: publicKey,
          newAccountPubkey: mintKeypair.publicKey,
          space: MINT_SIZE,
          lamports,
          programId: TOKEN_PROGRAM_ID,
        }),
        createInitializeMintInstruction(
          mintKeypair.publicKey,
          decimals,
          publicKey,
          publicKey
        )
      );

      // ATA + mint to
      const ata = await getAssociatedTokenAddress(mintKeypair.publicKey, recipientPubkey);
      tx.add(
        createAssociatedTokenAccountInstruction(publicKey, ata, recipientPubkey, mintKeypair.publicKey)
      );

      const rawSupply = BigInt(supply) * BigInt(10 ** decimals);
      tx.add(
        createMintToInstruction(mintKeypair.publicKey, ata, publicKey, rawSupply)
      );

      // Add Metaplex metadata
      const [metadataPDA] = PublicKey.findProgramAddressSync(
        [Buffer.from("metadata"), TOKEN_METADATA_PROGRAM_ID.toBuffer(), mintKeypair.publicKey.toBuffer()],
        TOKEN_METADATA_PROGRAM_ID
      );
      const metadataIx = createCreateMetadataAccountV3Instruction(
        { metadata: metadataPDA, mint: mintKeypair.publicKey, mintAuthority: publicKey, payer: publicKey, updateAuthority: publicKey },
        { createMetadataAccountArgsV3: { data: { name: tokenName, symbol: tokenSymbol, uri: "", sellerFeeBasisPoints: 0, creators: null, collection: null, uses: null }, isMutable: true, collectionDetails: null } }
      );
      tx.add(metadataIx);

      // Get fresh blockhash
      const { blockhash } = await connection.getLatestBlockhash("confirmed");
      tx.feePayer = publicKey;
      tx.recentBlockhash = blockhash;

      // Partially sign with mint keypair
      tx.partialSign(mintKeypair);

      // Sign with wallet, then send raw tx directly via our Helius RPC (bypasses Phantom's RPC)
      if (!signTransaction) throw new Error("Wallet does not support signTransaction");
      const signed = await signTransaction(tx);
      const sig = await connection.sendRawTransaction(signed.serialize(), {
        skipPreflight: true,
      });
      setStatus(`Tx sent: ${sig.slice(0, 12)}… Confirming…`);

      // Poll for confirmation using getSignatureStatuses (more reliable than confirmTransaction)
      const startTime = Date.now();
      const TIMEOUT_MS = 60_000;
      while (Date.now() - startTime < TIMEOUT_MS) {
        const { value } = await connection.getSignatureStatuses([sig]);
        const status = value?.[0];
        if (status?.confirmationStatus === "confirmed" || status?.confirmationStatus === "finalized") {
          if (status.err) throw new Error(`Transaction failed: ${JSON.stringify(status.err)}`);
          break;
        }
        await new Promise(r => setTimeout(r, 2000));
      }

      // Generate deterministic color from mint address
      const colorHash = mintKeypair.publicKey.toBuffer().slice(0, 3);
      const color = `#${colorHash[0].toString(16).padStart(2,'0')}${colorHash[1].toString(16).padStart(2,'0')}${colorHash[2].toString(16).padStart(2,'0')}`;
      setMintColor(color);

      setMintAddress(mintKeypair.publicKey.toBase58());
      setLastTxSig(sig);
      setStatus("Done! Token created and minted.");
      await refreshBalance();
    } catch (e: unknown) {
      setStatus(`Error: ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      setLoading(false);
    }
  }, [publicKey, signTransaction, recipient, decimals, supply, tokenName, tokenSymbol, refreshBalance]); // eslint-disable-line react-hooks/exhaustive-deps

  const copyMint = () => {
    if (mintAddress) {
      navigator.clipboard.writeText(mintAddress);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    }
  };

  // Mint more of an existing token
  const [existingMint, setExistingMint] = useState("");
  const [mintMoreAmount, setMintMoreAmount] = useState("100000");
  const [mintingMore, setMintingMore] = useState(false);
  const [mintAuthError, setMintAuthError] = useState<string | null>(null);

  // Check mint authority when user pastes an address
  useEffect(() => {
    setMintAuthError(null);
    if (!existingMint || existingMint.length < 32 || !publicKey) return;
    let cancelled = false;
    (async () => {
      try {
        const mintPk = new PublicKey(existingMint);
        const mintInfo = await connection.getParsedAccountInfo(mintPk);
        if (!mintInfo.value) { if (!cancelled) setMintAuthError("Mint not found on devnet"); return; }
        const parsed = (mintInfo.value.data as any)?.parsed;
        if (!parsed || parsed.type !== "mint") { if (!cancelled) setMintAuthError("Not a valid SPL token mint"); return; }
        const authority = parsed.info.mintAuthority;
        if (!authority) {
          if (!cancelled) setMintAuthError("This token has no mint authority (supply is fixed)");
        } else if (authority !== publicKey.toBase58()) {
          if (!cancelled) setMintAuthError(`You're not the mint authority. Only ${authority.slice(0, 8)}... can mint more. Create your own token above instead.`);
        }
      } catch {
        if (!cancelled) setMintAuthError("Invalid address");
      }
    })();
    return () => { cancelled = true; };
  }, [existingMint, publicKey, connection]);

  const handleMintMore = useCallback(async () => {
    if (!publicKey || !signTransaction || !existingMint || mintAuthError) return;
    setMintingMore(true);
    setStatus("Minting more tokens…");
    try {
      const mintPk = new PublicKey(existingMint);
      const recipientPk = new PublicKey(recipient);
      // Fetch mint info to get decimals
      const mintInfo = await connection.getParsedAccountInfo(mintPk);
      if (!mintInfo.value) throw new Error("Mint not found");
      const parsedMint = (mintInfo.value.data as any)?.parsed;
      if (!parsedMint || parsedMint.type !== "mint") throw new Error("Not a valid mint");
      const dec = parsedMint.info.decimals;

      const ata = await getAssociatedTokenAddress(mintPk, recipientPk);
      const tx = new Transaction();

      // Create ATA if it doesn't exist
      const ataInfo = await connection.getAccountInfo(ata);
      if (!ataInfo) {
        tx.add(createAssociatedTokenAccountInstruction(publicKey, ata, recipientPk, mintPk));
      }

      const rawAmount = BigInt(mintMoreAmount) * BigInt(10 ** dec);
      tx.add(createMintToInstruction(mintPk, ata, publicKey, rawAmount));

      const { blockhash } = await connection.getLatestBlockhash("confirmed");
      tx.feePayer = publicKey;
      tx.recentBlockhash = blockhash;
      const signed = await signTransaction(tx);
      const sig = await connection.sendRawTransaction(signed.serialize(), {
        skipPreflight: true,
      });
      // Poll for confirmation using getSignatureStatuses (more reliable than confirmTransaction)
      const startTimeMM = Date.now();
      const TIMEOUT_MS_MM = 60_000;
      while (Date.now() - startTimeMM < TIMEOUT_MS_MM) {
        const { value } = await connection.getSignatureStatuses([sig]);
        const status = value?.[0];
        if (status?.confirmationStatus === "confirmed" || status?.confirmationStatus === "finalized") {
          if (status.err) throw new Error(`Transaction failed: ${JSON.stringify(status.err)}`);
          break;
        }
        await new Promise(r => setTimeout(r, 2000));
      }
      setLastTxSig(sig);
      setStatus(`Minted ${Number(mintMoreAmount).toLocaleString()} more tokens!`);
      await refreshBalance();
    } catch (e: unknown) {
      setStatus(`Error: ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      setMintingMore(false);
    }
  }, [publicKey, signTransaction, existingMint, mintMoreAmount, recipient, refreshBalance]); // eslint-disable-line react-hooks/exhaustive-deps

  const cardClass =
    "bg-[var(--panel-bg)] border border-[var(--border)] p-6";
  const btnPrimary =
    "border border-[var(--accent)]/40 text-[var(--accent)] bg-transparent px-5 py-2.5 text-sm font-semibold transition-all duration-200 hover:border-[var(--accent)]/70 hover:bg-[var(--accent)]/[0.08] active:scale-[0.98] disabled:opacity-40 disabled:cursor-not-allowed disabled:hover:scale-100";
  const inputClass =
    "w-full bg-[var(--panel-bg)] border border-[var(--border)] px-3 py-2 text-sm text-white placeholder-[var(--text-muted)] focus:border-[var(--accent)]/40 focus:outline-none transition-shadow duration-200";

  /* ---- Loading skeleton while wallet connects ---- */
  if (!connected) {
    return (
      <div className="min-h-[calc(100vh-48px)] relative">
        <div className="absolute inset-x-0 top-0 h-48 bg-grid pointer-events-none" />
        <div className="relative mx-auto max-w-4xl px-4 py-10">
          <div className="mb-2 text-[10px] font-medium uppercase tracking-[0.25em] text-[var(--accent)]/60">
            // faucet
          </div>
          <h1 className="text-xl font-medium tracking-[-0.01em] text-white sm:text-2xl" style={{ fontFamily: "var(--font-heading)" }}>
            <span className="font-normal text-white/50">Devnet </span>Token Factory
          </h1>
          <p className="mt-2 mb-8 text-[13px] text-[var(--text-secondary)]">
            Create SPL tokens on devnet for testing with the launch wizard.
          </p>

          <div className="max-w-xl space-y-6">
            {/* Step 1 - Connect Wallet (always visible) */}
            <ScrollReveal delay={0}>
              <div className={cardClass}>
                <h2 className="mb-3 text-[10px] font-medium uppercase tracking-[0.15em] text-[var(--text-muted)]">
                  Step 1 · Connect Wallet
                </h2>
                <p className="text-sm text-[var(--warning)]">
                  Connect your wallet using the button in the header
                </p>
              </div>
            </ScrollReveal>

            {/* Shimmer skeleton placeholders for remaining steps */}
            <ShimmerSkeleton className="h-[88px]" />
            <ShimmerSkeleton className="h-[200px]" />
            <ShimmerSkeleton className="h-[100px]" />
            <ShimmerSkeleton className="h-[220px]" />
          </div>
        </div>
      </div>
    );
  }

  /* ---- Step cards data for staggered ScrollReveal ---- */
  const stepCards = [
    // Step 1 - Wallet
    <div key="step1" className={cardClass}>
      <h2 className="mb-3 text-[10px] font-medium uppercase tracking-[0.15em] text-[var(--text-muted)]">
        Step 1 · Connect Wallet
      </h2>
      <p className="text-sm text-[var(--accent)]">
        Connected: <span className="font-mono text-xs">{publicKey?.toBase58()}</span>
      </p>
    </div>,

    // Step 2 - Airdrop
    <div key="step2" className={cardClass}>
      <h2 className="mb-3 text-[10px] font-medium uppercase tracking-[0.15em] text-[var(--text-muted)]">
        Step 2 · Devnet SOL
      </h2>
      <div className="flex items-center justify-between">
        <span className="text-sm text-white">
          Balance:{" "}
          <span className="font-mono text-[var(--accent)]">
            {balance !== null ? `${balance.toFixed(4)} SOL` : "…"}
          </span>
        </span>
        <button className={btnPrimary} onClick={handleAirdrop} disabled={airdropping}>
          {airdropping ? "Airdropping…" : "Airdrop 2 SOL"}
        </button>
      </div>
    </div>,

    // Step 3 - Config
    <div key="step3" className={cardClass}>
      <h2 className="mb-4 text-[10px] font-medium uppercase tracking-[0.15em] text-[var(--text-muted)]">
        Step 3 · Token Config
      </h2>
      <div className="space-y-3">
        <div className="flex gap-3">
          <div className="flex-1">
            <label className="mb-1 block text-xs text-[var(--text-secondary)]">Decimals</label>
            <input
              type="number"
              min={0}
              max={18}
              value={decimals}
              onChange={(e) => setDecimals(Number(e.target.value))}
              className={inputClass}
            />
          </div>
          <div className="flex-[2]">
            <label className="mb-1 block text-xs text-[var(--text-secondary)]">Supply</label>
            <input
              type="text"
              value={supply}
              onChange={(e) => setSupply(e.target.value.replace(/[^0-9]/g, ""))}
              className={inputClass}
            />
          </div>
        </div>
        <div className="flex gap-3">
          <div className="flex-1">
            <label className="mb-1 block text-xs text-[var(--text-secondary)]">Token Name</label>
            <input
              type="text"
              value={tokenName}
              onChange={(e) => setTokenName(e.target.value)}
              className={inputClass}
            />
          </div>
          <div className="flex-1">
            <label className="mb-1 block text-xs text-[var(--text-secondary)]">Symbol</label>
            <input
              type="text"
              value={tokenSymbol}
              onChange={(e) => setTokenSymbol(e.target.value)}
              className={inputClass}
            />
          </div>
        </div>
        <div>
          <label className="mb-1 block text-xs text-[var(--text-secondary)]">Recipient Address</label>
          <input
            type="text"
            value={recipient}
            onChange={(e) => setRecipient(e.target.value)}
            className={inputClass}
          />
        </div>
      </div>
    </div>,

    // Step 4 - Create
    <div key="step4" className={cardClass}>
      <h2 className="mb-3 text-[10px] font-medium uppercase tracking-[0.15em] text-[var(--text-muted)]">
        Step 4 · Create &amp; Mint
      </h2>
      <button
        className={`${btnPrimary} w-full`}
        onClick={handleCreateAndMint}
        disabled={loading || !recipient}
      >
        {loading ? "Creating…" : `Create Mint + Mint ${Number(supply).toLocaleString()} Tokens`}
      </button>
    </div>,

    // Mint More - existing token
    <div key="mintmore" className={cardClass}>
      <h2 className="mb-3 text-[10px] font-medium uppercase tracking-[0.15em] text-[var(--text-muted)]">
        Mint More (Existing Token)
      </h2>
      <p className="mb-3 text-xs text-[var(--text-muted)]">Already deployed a market? Mint more of the same token to your wallet.</p>
      <div className="space-y-3">
        <div>
          <label className="mb-1 block text-xs text-[var(--text-secondary)]">Existing Mint Address</label>
          <input
            type="text"
            value={existingMint}
            onChange={(e) => setExistingMint(e.target.value)}
            placeholder="Paste token mint address..."
            className={inputClass}
          />
        </div>
        <div>
          <label className="mb-1 block text-xs text-[var(--text-secondary)]">Amount to Mint</label>
          <input
            type="text"
            value={mintMoreAmount}
            onChange={(e) => setMintMoreAmount(e.target.value.replace(/[^0-9]/g, ""))}
            className={inputClass}
          />
        </div>
        {mintAuthError && (
          <p className="text-[11px] text-[var(--short)]">{mintAuthError}</p>
        )}
        <button
          className={`${btnPrimary} w-full`}
          onClick={handleMintMore}
          disabled={mintingMore || !existingMint || !mintMoreAmount || !!mintAuthError}
        >
          {mintingMore ? "Minting…" : `Mint ${Number(mintMoreAmount).toLocaleString()} More Tokens`}
        </button>
      </div>
    </div>,
  ];

  return (
    <div className="min-h-[calc(100vh-48px)] relative">
      <div className="absolute inset-x-0 top-0 h-48 bg-grid pointer-events-none" />
      <div className="relative mx-auto max-w-4xl px-4 py-10">
        <ScrollReveal>
          <div className="mb-8">
            <div className="mb-2 text-[10px] font-medium uppercase tracking-[0.25em] text-[var(--accent)]/60">
              // faucet
            </div>
            <h1 className="text-xl font-medium tracking-[-0.01em] text-white sm:text-2xl" style={{ fontFamily: "var(--font-heading)" }}>
              <span className="font-normal text-white/50">Devnet </span>Token Factory
            </h1>
            <p className="mt-2 text-[13px] text-[var(--text-secondary)]">
              Create SPL tokens on devnet for testing with the launch wizard.
            </p>
          </div>
        </ScrollReveal>

      <div className="max-w-xl space-y-6">

        {/* Step cards with staggered scroll reveals */}
        {stepCards.map((card, i) => (
          <ScrollReveal key={i} delay={i * 0.1}>
            {card}
          </ScrollReveal>
        ))}

        {/* Status */}
        {status && (
          <p className="text-center text-sm text-[var(--text-secondary)]">
            {status}
            {lastTxSig && !status.startsWith("Error") && (
              <>
                {" "}
                <a
                  href={`https://explorer.solana.com/tx/${lastTxSig}?cluster=devnet`}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="text-[var(--accent)] hover:underline break-all"
                >
                  View tx →
                </a>
              </>
            )}
          </p>
        )}

        {/* Result - GSAP scale-in animation */}
        {mintAddress && (
          <div
            ref={successCardRef}
            className={`${cardClass} border-[var(--accent)]/30`}
            style={prefersReducedMotion ? undefined : { opacity: 0 }}
          >
            <div className="mb-3 flex items-center gap-2">
              {mintColor && (
                <span
                  className="inline-block h-6 w-6 rounded-full border border-[var(--border)]"
                  style={{ backgroundColor: mintColor }}
                />
              )}
              <h2 className="text-[10px] font-medium uppercase tracking-[0.15em] text-[var(--accent)]">
                {tokenName} ({tokenSymbol}) Created
              </h2>
            </div>
            <div className="flex items-center gap-2">
              <code className="flex-1 overflow-hidden text-ellipsis rounded bg-[var(--panel-bg)] px-3 py-2 text-xs text-white">
                {mintAddress}
              </code>
              <button
                onClick={copyMint}
                className="rounded-sm border border-[var(--border)] px-3 py-2 text-xs text-[var(--text-secondary)] transition-all duration-150 hover:bg-[var(--accent)]/[0.06] hover:text-white hover:scale-[1.02] active:scale-[0.98]"
              >
                {copied ? "Copied!" : "Copy"}
              </button>
            </div>
            <a
              href={`https://explorer.solana.com/address/${mintAddress}?cluster=devnet`}
              target="_blank"
              rel="noopener noreferrer"
              className="mt-3 inline-block text-sm text-[var(--accent)] underline hover:text-[var(--accent)]/80"
            >
              View on Solana Explorer
            </a>
          </div>
        )}
      </div>
      </div>
    </div>
  );
};

export default DevnetMintContent;
