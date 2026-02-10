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
      await connection.confirmTransaction(sig, "confirmed");
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

      // Get fresh blockhash with lastValidBlockHeight for proper confirmation
      const { blockhash, lastValidBlockHeight } = await connection.getLatestBlockhash("confirmed");
      tx.feePayer = publicKey;
      tx.recentBlockhash = blockhash;

      // Partially sign with mint keypair
      tx.partialSign(mintKeypair);

      // Sign with wallet, then send raw tx directly via our Helius RPC (bypasses Phantom's RPC)
      if (!signTransaction) throw new Error("Wallet does not support signTransaction");
      const signed = await signTransaction(tx);
      const sig = await connection.sendRawTransaction(signed.serialize(), {
        skipPreflight: false,
        preflightCommitment: "confirmed",
      });
      setStatus(`Tx sent: ${sig.slice(0, 12)}… Confirming…`);
      await connection.confirmTransaction(
        { signature: sig, blockhash, lastValidBlockHeight },
        "confirmed"
      );

      setMintAddress(mintKeypair.publicKey.toBase58());
      setStatus("Done! Token created and minted.");
      await refreshBalance();
    } catch (e: unknown) {
      setStatus(`Error: ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      setLoading(false);
    }
  }, [publicKey, signTransaction, recipient, decimals, supply, refreshBalance]); // eslint-disable-line react-hooks/exhaustive-deps

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

  const handleMintMore = useCallback(async () => {
    if (!publicKey || !signTransaction || !existingMint) return;
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

      const { blockhash, lastValidBlockHeight } = await connection.getLatestBlockhash("confirmed");
      tx.feePayer = publicKey;
      tx.recentBlockhash = blockhash;
      const signed = await signTransaction(tx);
      const sig = await connection.sendRawTransaction(signed.serialize(), {
        skipPreflight: false,
        preflightCommitment: "confirmed",
      });
      await connection.confirmTransaction({ signature: sig, blockhash, lastValidBlockHeight }, "confirmed");
      setStatus(`Minted ${Number(mintMoreAmount).toLocaleString()} more tokens! Tx: ${sig.slice(0, 12)}…`);
      await refreshBalance();
    } catch (e: unknown) {
      setStatus(`Error: ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      setMintingMore(false);
    }
  }, [publicKey, signTransaction, existingMint, mintMoreAmount, recipient, refreshBalance]); // eslint-disable-line react-hooks/exhaustive-deps

  const cardClass =
    "rounded-sm bg-[var(--panel-bg)] border border-[var(--border)] p-6";
  const btnPrimary =
    "rounded-sm bg-[var(--long)] px-5 py-2.5 text-sm font-semibold text-white transition-all duration-150 hover:bg-[var(--long)]/80 hover:scale-[1.02] active:scale-[0.98] disabled:opacity-40 disabled:cursor-not-allowed disabled:hover:scale-100 disabled:hover:shadow-none";
  const inputClass =
    "w-full rounded-sm bg-[var(--panel-bg)] border border-[var(--border)] px-3 py-2 text-sm text-white placeholder-[var(--text-muted)] focus:border-[var(--accent)]/40 focus:outline-none transition-shadow duration-200";

  /* ---- Loading skeleton while wallet connects ---- */
  if (!connected) {
    return (
      <div className="min-h-screen bg-[var(--panel-bg)] px-4 py-12">
        <div className="mx-auto max-w-xl space-y-6">
          <div className="text-center">
            <h1 className="text-3xl font-extrabold text-white">
              Devnet Token Factory
            </h1>
            <p className="mt-2 text-sm text-[var(--text-secondary)]">
              Create SPL tokens on devnet for testing with the launch wizard
            </p>
          </div>

          {/* Step 1 - Connect Wallet (always visible) */}
          <ScrollReveal delay={0}>
            <div className={cardClass}>
              <h2 className="mb-3 text-sm font-bold uppercase tracking-wider text-[var(--text-secondary)]">
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
    );
  }

  /* ---- Step cards data for staggered ScrollReveal ---- */
  const stepCards = [
    // Step 1 - Wallet
    <div key="step1" className={cardClass}>
      <h2 className="mb-3 text-sm font-bold uppercase tracking-wider text-[var(--text-secondary)]">
        Step 1 · Connect Wallet
      </h2>
      <p className="text-sm text-[var(--long)]">
        Connected: <span className="font-mono text-xs">{publicKey?.toBase58()}</span>
      </p>
    </div>,

    // Step 2 - Airdrop
    <div key="step2" className={cardClass}>
      <h2 className="mb-3 text-sm font-bold uppercase tracking-wider text-[var(--text-secondary)]">
        Step 2 · Devnet SOL
      </h2>
      <div className="flex items-center justify-between">
        <span className="text-sm text-white">
          Balance:{" "}
          <span className="font-mono text-[var(--long)]">
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
      <h2 className="mb-4 text-sm font-bold uppercase tracking-wider text-[var(--text-secondary)]">
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
      <h2 className="mb-3 text-sm font-bold uppercase tracking-wider text-[var(--text-secondary)]">
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
      <h2 className="mb-3 text-sm font-bold uppercase tracking-wider text-[var(--text-secondary)]">
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
        <button
          className={`${btnPrimary} w-full`}
          onClick={handleMintMore}
          disabled={mintingMore || !existingMint || !mintMoreAmount}
        >
          {mintingMore ? "Minting…" : `Mint ${Number(mintMoreAmount).toLocaleString()} More Tokens`}
        </button>
      </div>
    </div>,
  ];

  return (
    <div className="min-h-screen bg-[var(--panel-bg)] px-4 py-12">
      <div className="mx-auto max-w-xl space-y-6">
        <div className="text-center">
          <h1 className="text-3xl font-extrabold text-white">
            Devnet Token Factory
          </h1>
          <p className="mt-2 text-sm text-[var(--text-secondary)]">
            Create SPL tokens on devnet for testing with the launch wizard
          </p>
        </div>

        {/* Step cards with staggered scroll reveals */}
        {stepCards.map((card, i) => (
          <ScrollReveal key={i} delay={i * 0.1}>
            {card}
          </ScrollReveal>
        ))}

        {/* Status */}
        {status && (
          <p className="text-center text-sm text-[var(--text-secondary)]">{status}</p>
        )}

        {/* Result - GSAP scale-in animation */}
        {mintAddress && (
          <div
            ref={successCardRef}
            className={`${cardClass} border-[var(--long)]/30`}
            style={prefersReducedMotion ? undefined : { opacity: 0 }}
          >
            <h2 className="mb-3 text-sm font-bold uppercase tracking-wider text-[var(--long)]">
              Token Created
            </h2>
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
              className="mt-3 inline-block text-sm text-[var(--long)] underline hover:text-[var(--long)]/80"
            >
              View on Solana Explorer
            </a>
          </div>
        )}
      </div>
    </div>
  );
};

export default DevnetMintContent;
