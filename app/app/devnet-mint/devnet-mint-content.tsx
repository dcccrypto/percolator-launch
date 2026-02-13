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
import Link from "next/link";
import { ScrollReveal } from "@/components/ui/ScrollReveal";
import { ShimmerSkeleton } from "@/components/ui/ShimmerSkeleton";
import { usePrefersReducedMotion } from "@/hooks/usePrefersReducedMotion";

const HELIUS_RPC = `https://devnet.helius-rpc.com/?api-key=${process.env.NEXT_PUBLIC_HELIUS_API_KEY ?? ""}`;
// Public devnet RPC for airdrop (Helius may not forward airdrop requests)
const PUBLIC_DEVNET_RPC = "https://api.devnet.solana.com";

const DevnetMintContent: FC = () => {
  const { publicKey, signTransaction } = useWallet();
  const prefersReducedMotion = usePrefersReducedMotion();
  const successCardRef = useRef<HTMLDivElement>(null);

  const [balance, setBalance] = useState<number | null>(null);
  const MAX_DECIMALS = 12; // Safe limit for u64 arithmetic on Solana
  const [decimals, setDecimals] = useState(9);
  const [supply, setSupply] = useState("100000");
  const [recipient, setRecipient] = useState("");
  const [mintAddress, setMintAddress] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [airdropping, setAirdropping] = useState(false);
  const [airdropStatus, setAirdropStatus] = useState<string | null>(null);
  const [airdropFailed, setAirdropFailed] = useState(false);
  const [createStatus, setCreateStatus] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const [tokenName, setTokenName] = useState("Test Token");
  const [tokenSymbol, setTokenSymbol] = useState("TEST");
  const [mintColor, setMintColor] = useState<string | null>(null);
  const [lastTxSig, setLastTxSig] = useState<string | null>(null);
  const [nameError, setNameError] = useState<string | null>(null);
  const [symbolError, setSymbolError] = useState<string | null>(null);

  // Mint More state
  const [existingMint, setExistingMint] = useState("");
  const [mintMoreAmount, setMintMoreAmount] = useState("100000");
  const [mintingMore, setMintingMore] = useState(false);
  const [mintMoreStatus, setMintMoreStatus] = useState<string | null>(null);
  const [mintAuthError, setMintAuthError] = useState<string | null>(null);
  const [checkingMintAuth, setCheckingMintAuth] = useState(false);

  const connection = useMemo(() => new Connection(HELIUS_RPC, "confirmed"), []);
  const airdropConnection = useMemo(() => new Connection(PUBLIC_DEVNET_RPC, "confirmed"), []);

  // Set recipient to connected wallet
  useEffect(() => {
    if (publicKey && !recipient) {
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
    gsap.fromTo(el, { opacity: 0, scale: 0.85 }, { opacity: 1, scale: 1, duration: 0.5, ease: "back.out(1.4)" });
  }, [mintAddress, prefersReducedMotion]);

  // Airdrop 2 SOL — uses public devnet RPC (more reliable for airdrops)
  const handleAirdrop = useCallback(async () => {
    if (!publicKey) return;
    setAirdropping(true);
    setAirdropStatus("Requesting 2 SOL airdrop...");
    setAirdropFailed(false);
    try {
      const sig = await airdropConnection.requestAirdrop(publicKey, 2 * LAMPORTS_PER_SOL);
      const startTime = Date.now();
      const TIMEOUT_MS = 60_000;
      let confirmed = false;
      while (Date.now() - startTime < TIMEOUT_MS) {
        const { value } = await airdropConnection.getSignatureStatuses([sig]);
        const s = value?.[0];
        if (s?.confirmationStatus === "confirmed" || s?.confirmationStatus === "finalized") {
          if (s.err) throw new Error(`Transaction failed: ${JSON.stringify(s.err)}`);
          confirmed = true;
          break;
        }
        await new Promise(r => setTimeout(r, 2000));
      }
      if (!confirmed) {
        throw new Error("Transaction confirmation timeout after 60s");
      }
      setAirdropStatus("Airdrop successful!");
      setAirdropFailed(false);
      await refreshBalance();
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e);
      setAirdropStatus(`Airdrop failed: ${msg}`);
      setAirdropFailed(true);
    } finally {
      setAirdropping(false);
    }
  }, [publicKey, airdropConnection, refreshBalance]);

  const webFaucetUrl = publicKey
    ? `https://faucet.solana.com/?address=${publicKey.toBase58()}&cluster=devnet`
    : "https://faucet.solana.com/";

  // Create mint + mint tokens
  const handleCreateAndMint = useCallback(async () => {
    if (!publicKey || !signTransaction) return;
    
    // P-MED-9: Validate token name and symbol
    setNameError(null);
    setSymbolError(null);
    
    const trimmedName = tokenName.trim();
    const trimmedSymbol = tokenSymbol.trim();
    
    if (trimmedName.length === 0) {
      setNameError("Token name cannot be empty");
      return;
    }
    if (trimmedName.length < 2) {
      setNameError("Token name must be at least 2 characters");
      return;
    }
    if (trimmedSymbol.length === 0) {
      setSymbolError("Token symbol cannot be empty");
      return;
    }
    if (trimmedSymbol.length < 2) {
      setSymbolError("Token symbol must be at least 2 characters");
      return;
    }
    if (!/^[A-Za-z0-9\s\-_]+$/.test(trimmedName)) {
      setNameError("Token name can only contain letters, numbers, spaces, hyphens, and underscores");
      return;
    }
    if (!/^[A-Z0-9]+$/.test(trimmedSymbol)) {
      setSymbolError("Token symbol can only contain uppercase letters and numbers");
      return;
    }
    
    setLoading(true);
    setCreateStatus("Creating mint account...");
    setMintAddress(null);

    try {
      // Validate decimals (prevent integer overflow on Solana u64)
      if (decimals < 0 || decimals > MAX_DECIMALS) {
        throw new Error(`Decimals must be between 0 and ${MAX_DECIMALS}. Higher values cause integer overflow on Solana.`);
      }
      
      // Validate supply is positive
      const supplyNum = Number(supply);
      if (!supply || supplyNum <= 0 || !Number.isFinite(supplyNum)) {
        throw new Error("Supply must be a positive number.");
      }
      
      // Validate total raw supply fits in u64 (max 2^64 - 1)
      const U64_MAX = BigInt("18446744073709551615");
      const rawSupplyCheck = BigInt(supply) * BigInt(10) ** BigInt(decimals);
      if (rawSupplyCheck > U64_MAX) {
        throw new Error(`Total supply (${supply} × 10^${decimals}) exceeds Solana's u64 limit. Reduce supply or decimals.`);
      }

      const walletBalance = await connection.getBalance(publicKey);
      if (walletBalance < 0.01 * LAMPORTS_PER_SOL) {
        throw new Error("Not enough SOL. You need at least 0.01 SOL. Use the airdrop button above.");
      }

      const mintKeypair = Keypair.generate();
      
      // P-CRITICAL-1: Validate recipient PublicKey before transaction
      let recipientPubkey: PublicKey;
      try {
        recipientPubkey = new PublicKey(recipient);
      } catch (err) {
        throw new Error(`Invalid recipient address: ${recipient}`);
      }
      
      const lamports = await getMinimumBalanceForRentExemptMint(connection);

      setCreateStatus("Building transaction...");

      const tx = new Transaction();
      tx.add(
        SystemProgram.createAccount({
          fromPubkey: publicKey,
          newAccountPubkey: mintKeypair.publicKey,
          space: MINT_SIZE,
          lamports,
          programId: TOKEN_PROGRAM_ID,
        }),
        createInitializeMintInstruction(mintKeypair.publicKey, decimals, publicKey, publicKey)
      );

      const ata = await getAssociatedTokenAddress(mintKeypair.publicKey, recipientPubkey);
      tx.add(createAssociatedTokenAccountInstruction(publicKey, ata, recipientPubkey, mintKeypair.publicKey));

      const rawSupply = BigInt(supply) * BigInt(10) ** BigInt(decimals);
      tx.add(createMintToInstruction(mintKeypair.publicKey, ata, publicKey, rawSupply));

      // P-HIGH-5: Wrap Metaplex PDA derivation in try-catch
      let metadataPDA: PublicKey;
      try {
        [metadataPDA] = PublicKey.findProgramAddressSync(
          [Buffer.from("metadata"), TOKEN_METADATA_PROGRAM_ID.toBuffer(), mintKeypair.publicKey.toBuffer()],
          TOKEN_METADATA_PROGRAM_ID
        );
      } catch (err) {
        throw new Error("Failed to derive metadata PDA. Please try again.");
      }
      tx.add(
        createCreateMetadataAccountV3Instruction(
          { metadata: metadataPDA, mint: mintKeypair.publicKey, mintAuthority: publicKey, payer: publicKey, updateAuthority: publicKey },
          { createMetadataAccountArgsV3: { data: { name: tokenName, symbol: tokenSymbol, uri: "", sellerFeeBasisPoints: 0, creators: null, collection: null, uses: null }, isMutable: true, collectionDetails: null } }
        )
      );

      const { blockhash } = await connection.getLatestBlockhash("confirmed");
      tx.feePayer = publicKey;
      tx.recentBlockhash = blockhash;
      tx.partialSign(mintKeypair);

      setCreateStatus("Approve in your wallet...");
      const signed = await signTransaction(tx);

      setCreateStatus("Sending transaction...");
      const sig = await connection.sendRawTransaction(signed.serialize(), { skipPreflight: true });
      setLastTxSig(sig);
      setCreateStatus("Confirming on-chain...");

      const startTime = Date.now();
      const TIMEOUT_MS = 60_000;
      while (Date.now() - startTime < TIMEOUT_MS) {
        const { value } = await connection.getSignatureStatuses([sig]);
        const s = value?.[0];
        if (s?.confirmationStatus === "confirmed" || s?.confirmationStatus === "finalized") {
          if (s.err) throw new Error(`Transaction failed: ${JSON.stringify(s.err)}`);
          break;
        }
        await new Promise(r => setTimeout(r, 2000));
      }

      const colorHash = mintKeypair.publicKey.toBuffer().slice(0, 3);
      setMintColor(`#${colorHash[0].toString(16).padStart(2, "0")}${colorHash[1].toString(16).padStart(2, "0")}${colorHash[2].toString(16).padStart(2, "0")}`);
      setMintAddress(mintKeypair.publicKey.toBase58());
      setCreateStatus(null);
      await refreshBalance();
    } catch (e: unknown) {
      setCreateStatus(`Error: ${e instanceof Error ? e.message : String(e)}`);
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

  // Check mint authority when user pastes an existing mint
  useEffect(() => {
    setMintAuthError(null);
    if (!existingMint || existingMint.length < 32 || !publicKey) {
      setCheckingMintAuth(false);
      return;
    }
    let cancelled = false;
    setCheckingMintAuth(true);
    (async () => {
      try {
        const mintPk = new PublicKey(existingMint);
        const mintInfo = await connection.getParsedAccountInfo(mintPk);
        if (!mintInfo.value) { if (!cancelled) { setMintAuthError("Mint not found on devnet"); setCheckingMintAuth(false); } return; }
        const parsed = (mintInfo.value.data as any)?.parsed;
        if (!parsed || parsed.type !== "mint") { if (!cancelled) { setMintAuthError("Not a valid SPL token mint"); setCheckingMintAuth(false); } return; }
        const authority = parsed.info.mintAuthority;
        if (!authority) {
          if (!cancelled) { setMintAuthError("This token has no mint authority (supply is fixed)"); setCheckingMintAuth(false); }
        } else if (authority !== publicKey.toBase58()) {
          if (!cancelled) { setMintAuthError(`You're not the mint authority. Only ${authority.slice(0, 8)}... can mint more.`); setCheckingMintAuth(false); }
        } else {
          if (!cancelled) setCheckingMintAuth(false);
        }
      } catch {
        if (!cancelled) { setMintAuthError("Invalid address"); setCheckingMintAuth(false); }
      }
    })();
    return () => { cancelled = true; setCheckingMintAuth(false); };
  }, [existingMint, publicKey, connection]);

  // Mint more of existing token
  const handleMintMore = useCallback(async () => {
    if (!publicKey || !signTransaction || !existingMint || mintAuthError) return;
    setMintingMore(true);
    setMintMoreStatus("Minting tokens...");
    try {
      const mintPk = new PublicKey(existingMint);
      const recipientPk = new PublicKey(recipient);
      const mintInfo = await connection.getParsedAccountInfo(mintPk);
      if (!mintInfo.value) throw new Error("Mint not found");
      const parsedMint = (mintInfo.value.data as any)?.parsed;
      if (!parsedMint || parsedMint.type !== "mint") throw new Error("Not a valid mint");
      const dec = parsedMint.info.decimals;

      const ata = await getAssociatedTokenAddress(mintPk, recipientPk);
      const tx = new Transaction();
      const ataInfo = await connection.getAccountInfo(ata);
      if (!ataInfo) {
        tx.add(createAssociatedTokenAccountInstruction(publicKey, ata, recipientPk, mintPk));
      }

      // Use safe BigInt exponentiation (10 ** dec can overflow Number for high decimals)
      const rawAmount = BigInt(mintMoreAmount) * BigInt(10) ** BigInt(dec);
      const U64_MAX = BigInt("18446744073709551615");
      if (rawAmount > U64_MAX) {
        throw new Error(`Amount (${mintMoreAmount} × 10^${dec}) exceeds Solana's u64 limit. Reduce the amount.`);
      }
      tx.add(createMintToInstruction(mintPk, ata, publicKey, rawAmount));

      const { blockhash } = await connection.getLatestBlockhash("confirmed");
      tx.feePayer = publicKey;
      tx.recentBlockhash = blockhash;

      setMintMoreStatus("Approve in your wallet...");
      const signed = await signTransaction(tx);
      const sig = await connection.sendRawTransaction(signed.serialize(), { skipPreflight: true });
      setLastTxSig(sig);
      setMintMoreStatus("Confirming...");

      const startTime = Date.now();
      while (Date.now() - startTime < 60_000) {
        const { value } = await connection.getSignatureStatuses([sig]);
        const s = value?.[0];
        if (s?.confirmationStatus === "confirmed" || s?.confirmationStatus === "finalized") {
          if (s.err) throw new Error(`Transaction failed: ${JSON.stringify(s.err)}`);
          break;
        }
        await new Promise(r => setTimeout(r, 2000));
      }
      setMintMoreStatus(`Minted ${Number(mintMoreAmount).toLocaleString()} tokens!`);
      await refreshBalance();
    } catch (e: unknown) {
      setMintMoreStatus(`Error: ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      setMintingMore(false);
    }
  }, [publicKey, signTransaction, existingMint, mintMoreAmount, recipient, refreshBalance]); // eslint-disable-line react-hooks/exhaustive-deps

  const cardClass = "bg-[var(--panel-bg)] border border-[var(--border)] p-6";
  const btnPrimary = "border border-[var(--accent)]/40 text-[var(--accent)] bg-transparent px-5 py-2.5 text-sm font-semibold transition-all duration-200 hover:border-[var(--accent)]/70 hover:bg-[var(--accent)]/[0.08] active:scale-[0.98] disabled:opacity-40 disabled:cursor-not-allowed disabled:hover:scale-100";
  const inputClass = "w-full bg-[var(--panel-bg)] border border-[var(--border)] px-3 py-2 text-sm text-white placeholder-[var(--text-muted)] focus:border-[var(--accent)]/40 focus:outline-none transition-shadow duration-200";

  const lowSol = balance !== null && balance < 0.01;
  const walletReady = !!publicKey && !!signTransaction;

  return (
    <div className="min-h-[calc(100vh-48px)] relative">
      <div className="absolute inset-x-0 top-0 h-48 bg-grid pointer-events-none" />
      <div className="relative mx-auto max-w-4xl px-4 py-10">
        <ScrollReveal>
          <div className="mb-8 text-center">
            <div className="mb-2 text-[10px] font-medium uppercase tracking-[0.25em] text-[var(--accent)]/60">// faucet</div>
            <h1 className="text-xl font-medium tracking-[-0.01em] text-white sm:text-2xl" style={{ fontFamily: "var(--font-heading)" }}>
              <span className="font-normal text-white/50">Devnet </span>Token Factory
            </h1>
            <p className="mt-2 text-[13px] text-[var(--text-secondary)]">Create SPL tokens on devnet for testing with the launch wizard.</p>
          </div>
        </ScrollReveal>

        <div className="max-w-xl mx-auto space-y-6">

          {/* Step 1 — Wallet */}
          <ScrollReveal delay={0}>
            <div className={cardClass}>
              <h2 className="mb-3 text-[10px] font-medium uppercase tracking-[0.15em] text-[var(--text-muted)]">Step 1 · Connect Wallet</h2>
              {walletReady ? (
                <p className="text-sm text-[var(--accent)]">
                  Connected: <span className="font-mono text-xs">{publicKey.toBase58()}</span>
                </p>
              ) : (
                <p className="text-sm text-[var(--warning)]">Connect your wallet using the button in the header</p>
              )}
            </div>
          </ScrollReveal>

          {/* Step 2 — Devnet SOL */}
          <ScrollReveal delay={0.1}>
            <div className={cardClass}>
              <h2 className="mb-3 text-[10px] font-medium uppercase tracking-[0.15em] text-[var(--text-muted)]">Step 2 · Devnet SOL</h2>
              <div className="flex items-center justify-between">
                <span className="text-sm text-white">
                  Balance:{" "}
                  <span className={`font-mono ${lowSol ? "text-[var(--short)]" : "text-[var(--accent)]"}`}>
                    {balance !== null ? `${balance.toFixed(4)} SOL` : "..."}
                  </span>
                </span>
                <button className={btnPrimary} onClick={refreshBalance} disabled={!walletReady}>
                  Refresh
                </button>
              </div>
              {lowSol && (
                <p className="mt-2 text-xs text-[var(--short)]">You need SOL to create tokens.</p>
              )}
              {/* Web faucet — primary method */}
              <div className="mt-3 border border-[var(--accent)]/20 bg-[var(--accent)]/[0.03] p-3">
                <p className="text-xs text-[var(--text-secondary)]">
                  Get devnet SOL from the{" "}
                  <a href={webFaucetUrl} target="_blank" rel="noopener noreferrer" className="text-[var(--accent)] underline hover:text-white">
                    Solana Faucet →
                  </a>
                  {" "}then hit Refresh.
                </p>
              </div>
              {/* Programmatic airdrop — secondary */}
              <div className="mt-2 flex items-center justify-between">
                <span className="text-[10px] text-[var(--text-dim)]">Or try programmatic airdrop (often rate-limited):</span>
                <button className="border border-[var(--border)] px-3 py-1.5 text-[10px] text-[var(--text-muted)] transition-all hover:border-[var(--accent)]/30 hover:text-[var(--text)] disabled:opacity-40" onClick={handleAirdrop} disabled={airdropping || !walletReady}>
                  {airdropping ? "Trying..." : "Airdrop 2 SOL"}
                </button>
              </div>
              {airdropStatus && (
                <p className={`mt-2 text-[10px] ${airdropStatus.startsWith("Airdrop successful") ? "text-[var(--accent)]" : airdropFailed ? "text-[var(--short)]" : "text-[var(--text-muted)]"}`}>
                  {airdropStatus}
                </p>
              )}
            </div>
          </ScrollReveal>

          {/* Step 3 — Token Config */}
          <ScrollReveal delay={0.2}>
            <div className={cardClass}>
              <h2 className="mb-4 text-[10px] font-medium uppercase tracking-[0.15em] text-[var(--text-muted)]">Step 3 · Token Config</h2>
              <div className="space-y-3">
                <div className="flex gap-3">
                  <div className="flex-1">
                    <label className="mb-1 block text-xs text-[var(--text-secondary)]">Token Name</label>
                    <input 
                      type="text" 
                      value={tokenName} 
                      onChange={(e) => { setTokenName(e.target.value); setNameError(null); }} 
                      className={`${inputClass} ${nameError ? "border-[var(--short)]" : ""}`}
                    />
                    {nameError && <p className="mt-1 text-xs text-[var(--short)]">{nameError}</p>}
                  </div>
                  <div className="flex-1">
                    <label className="mb-1 block text-xs text-[var(--text-secondary)]">Symbol</label>
                    <input 
                      type="text" 
                      value={tokenSymbol} 
                      onChange={(e) => { setTokenSymbol(e.target.value.toUpperCase()); setSymbolError(null); }} 
                      className={`${inputClass} ${symbolError ? "border-[var(--short)]" : ""}`}
                    />
                    {symbolError && <p className="mt-1 text-xs text-[var(--short)]">{symbolError}</p>}
                  </div>
                </div>
                <div className="flex gap-3">
                  <div className="flex-1">
                    <label className="mb-1 block text-xs text-[var(--text-secondary)]">Decimals</label>
                    <input type="number" min={0} max={MAX_DECIMALS} value={decimals} onChange={(e) => {
                      const val = Math.min(MAX_DECIMALS, Math.max(0, Math.floor(Number(e.target.value) || 0)));
                      setDecimals(val);
                    }} className={inputClass} />
                  </div>
                  <div className="flex-[2]">
                    <label className="mb-1 block text-xs text-[var(--text-secondary)]">Supply</label>
                    <input type="text" value={supply} onChange={(e) => setSupply(e.target.value.replace(/[^0-9]/g, ""))} className={inputClass} />
                  </div>
                </div>
                <div>
                  <label className="mb-1 block text-xs text-[var(--text-secondary)]">Recipient Address</label>
                  <input type="text" value={recipient} onChange={(e) => setRecipient(e.target.value)} className={inputClass} />
                </div>
              </div>
            </div>
          </ScrollReveal>

          {/* Step 4 — Create & Mint (or show success) */}
          <ScrollReveal delay={0.3}>
            {mintAddress ? (
              /* ── Success card ── */
              <div ref={successCardRef} className={`${cardClass} border-[var(--accent)]/30`} style={prefersReducedMotion ? undefined : { opacity: 0 }}>
                <div className="mb-4 flex items-center gap-2">
                  {mintColor && (
                    <span className="inline-block h-6 w-6 rounded-full border border-[var(--border)]" style={{ backgroundColor: mintColor }} />
                  )}
                  <h2 className="text-[10px] font-medium uppercase tracking-[0.15em] text-[var(--accent)]">
                    {tokenName} ({tokenSymbol}) Created
                  </h2>
                </div>

                <div className="flex items-center gap-2">
                  <code className="flex-1 overflow-hidden text-ellipsis bg-[var(--bg)] border border-[var(--border)] px-3 py-2 text-xs text-white">{mintAddress}</code>
                  <button onClick={copyMint} className="border border-[var(--border)] px-3 py-2 text-xs text-[var(--text-secondary)] transition-all hover:bg-[var(--accent)]/[0.06] hover:text-white active:scale-[0.98]">
                    {copied ? "Copied!" : "Copy"}
                  </button>
                </div>

                <div className="mt-4 flex flex-col gap-2 sm:flex-row sm:items-center sm:gap-3">
                  <Link href={`/create?mint=${mintAddress}`} className={`${btnPrimary} text-center`}>
                    Create Market →
                  </Link>
                  <a href={`https://explorer.solana.com/address/${mintAddress}?cluster=devnet`} target="_blank" rel="noopener noreferrer" className="text-xs text-[var(--text-muted)] hover:text-[var(--accent)] underline">
                    View on Explorer
                  </a>
                  {lastTxSig && (
                    <a href={`https://explorer.solana.com/tx/${lastTxSig}?cluster=devnet`} target="_blank" rel="noopener noreferrer" className="text-xs text-[var(--text-muted)] hover:text-[var(--accent)] underline">
                      View tx
                    </a>
                  )}
                </div>

                <button onClick={() => { setMintAddress(null); setCreateStatus(null); setLastTxSig(null); }} className="mt-4 text-xs text-[var(--text-dim)] hover:text-[var(--text-muted)] underline">
                  Create another token
                </button>
              </div>
            ) : (
              /* ── Create button + progress ── */
              <div className={cardClass}>
                <h2 className="mb-3 text-[10px] font-medium uppercase tracking-[0.15em] text-[var(--text-muted)]">Step 4 · Create &amp; Mint</h2>

                {!walletReady && (
                  <p className="mb-3 text-xs text-[var(--warning)]">Connect your wallet first (Step 1).</p>
                )}
                {walletReady && lowSol && (
                  <p className="mb-3 text-xs text-[var(--short)]">Not enough SOL — you need at least 0.01 SOL. Get some in Step 2.</p>
                )}

                {/* Inline progress */}
                {loading && createStatus && (
                  <div className="mb-3 flex items-center gap-2">
                    <span className="h-3 w-3 animate-spin border border-[var(--border)] border-t-[var(--accent)]" />
                    <span className="text-xs text-[var(--text-muted)]">{createStatus}</span>
                  </div>
                )}

                {/* Error inline */}
                {!loading && createStatus?.startsWith("Error") && (
                  <p className="mb-3 text-xs text-[var(--short)]">{createStatus}</p>
                )}

                <button className={`${btnPrimary} w-full`} onClick={handleCreateAndMint} disabled={loading || !recipient || lowSol || !walletReady}>
                  {!walletReady ? "Connect Wallet First" : loading ? "Creating..." : `Create Mint + Mint ${Number(supply).toLocaleString()} Tokens`}
                </button>
              </div>
            )}
          </ScrollReveal>

          {/* Mint More — existing token */}
          <ScrollReveal delay={0.4}>
            <div className={cardClass}>
              <h2 className="mb-2 text-[10px] font-medium uppercase tracking-[0.15em] text-[var(--text-muted)]">Mint More (Existing Token)</h2>
              <p className="mb-3 text-xs text-[var(--text-muted)]">Already created a market? Need more tokens for trading or deposits? Mint more of a token you own.</p>
              <div className="space-y-3">
                <div>
                  <label className="mb-1 block text-xs text-[var(--text-secondary)]">Existing Mint Address</label>
                  <input type="text" value={existingMint} onChange={(e) => setExistingMint(e.target.value.trim())} placeholder="Paste token mint address..." className={inputClass} />
                </div>
                <div>
                  <label className="mb-1 block text-xs text-[var(--text-secondary)]">Amount to Mint</label>
                  <input type="text" value={mintMoreAmount} onChange={(e) => setMintMoreAmount(e.target.value.replace(/[^0-9]/g, ""))} className={inputClass} />
                </div>
                {checkingMintAuth && (
                  <div className="flex items-center gap-2">
                    <span className="h-3 w-3 animate-spin border border-[var(--border)] border-t-[var(--accent)]" />
                    <span className="text-xs text-[var(--text-muted)]">Checking mint authority...</span>
                  </div>
                )}
                {!checkingMintAuth && mintAuthError && <p className="text-[11px] text-[var(--short)]">{mintAuthError}</p>}
                {mintingMore && mintMoreStatus && (
                  <div className="flex items-center gap-2">
                    <span className="h-3 w-3 animate-spin border border-[var(--border)] border-t-[var(--accent)]" />
                    <span className="text-xs text-[var(--text-muted)]">{mintMoreStatus}</span>
                  </div>
                )}
                {!mintingMore && mintMoreStatus && (
                  <p className={`text-xs ${mintMoreStatus.startsWith("Error") ? "text-[var(--short)]" : "text-[var(--accent)]"}`}>
                    {mintMoreStatus}
                    {lastTxSig && !mintMoreStatus.startsWith("Error") && (
                      <>
                        {" "}
                        <a href={`https://explorer.solana.com/tx/${lastTxSig}?cluster=devnet`} target="_blank" rel="noopener noreferrer" className="underline hover:text-white">
                          View tx →
                        </a>
                      </>
                    )}
                  </p>
                )}
                {/* P-HIGH-4: Disable button during mint authority check */}
                <button className={`${btnPrimary} w-full`} onClick={handleMintMore} disabled={mintingMore || checkingMintAuth || !existingMint || !mintMoreAmount || !!mintAuthError || !walletReady}>
                  {!walletReady ? "Connect Wallet First" : checkingMintAuth ? "Checking..." : mintingMore ? "Minting..." : `Mint ${Number(mintMoreAmount).toLocaleString()} More Tokens`}
                </button>
              </div>
            </div>
          </ScrollReveal>

        </div>
      </div>
    </div>
  );
};

export default DevnetMintContent;
