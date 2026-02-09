"use client";

import { FC } from "react";

const PHRASES = [
  "don't trust, verify.",
  "read the code before you ape.",
  "check the slab. check the oracle. check everything.",
  "open source. on-chain. auditable.",
  "verify the program ID. always.",
  "your collateral, your responsibility.",
  "inspect every transaction before signing.",
  "no admin keys on mainnet. verify it yourself.",
  "dyor is not a meme — it's a lifestyle.",
  "trust math, not promises.",
];

export const TickerBar: FC = () => {
  const content = [...PHRASES, ...PHRASES, ...PHRASES, ...PHRASES];

  return (
    <div className="sticky top-0 z-[60] h-7 overflow-hidden border-b border-[#1a1a1f] bg-[#0a0a0f]">
      <div
        className="ticker-scroll flex h-full items-center text-xs"
        style={{ fontFamily: "var(--font-jetbrains-mono)" }}
      >
        {content.map((phrase, i) => (
          <span
            key={i}
            className="inline-flex items-center whitespace-nowrap px-6"
          >
            <span className="text-[#00FFB2]/70">{phrase}</span>
            <span className="ml-6 text-[#1a1a1f]">✦</span>
          </span>
        ))}
      </div>

      <style jsx>{`
        .ticker-scroll {
          animation: ticker-slide 50s linear infinite;
          width: max-content;
        }
        @keyframes ticker-slide {
          0% { transform: translateX(0); }
          100% { transform: translateX(-50%); }
        }
        .ticker-scroll:hover {
          animation-play-state: paused;
        }
      `}</style>
    </div>
  );
};
