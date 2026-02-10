"use client";

import { FC } from "react";
export const Footer: FC = () => {
  return (
    <footer className="border-t border-[#1a1a1f] py-6">
      <div className="mx-auto flex max-w-7xl items-center justify-center gap-4 px-4 text-[11px] text-[#3f3f46]">
        <span>percolator</span>
        <span>&middot;</span>
        <a href="https://github.com/dcccrypto/percolator-launch" target="_blank" rel="noopener noreferrer" className="transition-colors hover:text-[#71717a]">github</a>
        <span>&middot;</span>
        <span>devnet</span>
        <span>&middot;</span>
        <span>built on solana</span>
      </div>
    </footer>
  );
};
