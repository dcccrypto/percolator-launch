"use client";

import type { WalletName } from "@solana/wallet-adapter-base";
import { WalletReadyState } from "@solana/wallet-adapter-base";
import type { Wallet } from "@solana/wallet-adapter-react";
import { useWallet } from "@solana/wallet-adapter-react";
import { useWalletModal } from "@solana/wallet-adapter-react-ui";
import {
  FC,
  MouseEvent,
  KeyboardEvent,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { createPortal } from "react-dom";

/**
 * Accessible wallet connection modal that replaces the default
 * @solana/wallet-adapter-react-ui WalletModal.
 *
 * Fixes:
 * - aria-labelledby actually references an element with a matching id
 * - Close button has aria-label
 * - "More options" toggle has aria-expanded + aria-controls
 * - Focus is trapped inside the modal
 * - Focus moves to the modal on open and returns to trigger on close
 * - Overlay has role="presentation"
 */

const MODAL_TITLE_ID = "wallet-adapter-modal-title";
const COLLAPSE_ID = "wallet-adapter-modal-collapse";
const PORTAL_CONTAINER_ID = "wallet-modal-portal";

export const AccessibleWalletModal: FC = () => {
  const ref = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<Element | null>(null);
  const { wallets, select } = useWallet();
  const { setVisible } = useWalletModal();
  const [expanded, setExpanded] = useState(false);
  const [fadeIn, setFadeIn] = useState(false);
  const [portal, setPortal] = useState<Element | null>(null);

  const [listedWallets, collapsedWallets] = useMemo(() => {
    const installed: Wallet[] = [];
    const notInstalled: Wallet[] = [];

    for (const wallet of wallets) {
      if (wallet.readyState === WalletReadyState.Installed) {
        installed.push(wallet);
      } else {
        notInstalled.push(wallet);
      }
    }

    return installed.length ? [installed, notInstalled] : [notInstalled, []];
  }, [wallets]);

  const hideModal = useCallback(() => {
    setFadeIn(false);
    setTimeout(() => {
      setVisible(false);
      // Restore focus to the element that triggered the modal
      if (
        triggerRef.current &&
        triggerRef.current instanceof HTMLElement
      ) {
        triggerRef.current.focus();
      }
    }, 150);
  }, [setVisible]);

  const handleClose = useCallback(
    (event: MouseEvent) => {
      event.preventDefault();
      hideModal();
    },
    [hideModal]
  );

  const handleWalletClick = useCallback(
    (event: MouseEvent, walletName: WalletName) => {
      select(walletName);
      handleClose(event);
    },
    [select, handleClose]
  );

  const handleCollapseClick = useCallback(
    () => setExpanded(!expanded),
    [expanded]
  );

  // Focus trapping
  const handleKeyDown = useCallback(
    (event: globalThis.KeyboardEvent) => {
      if (event.key === "Escape") {
        hideModal();
        return;
      }

      if (event.key !== "Tab") return;

      const node = ref.current;
      if (!node) return;

      const focusable = node.querySelectorAll<HTMLElement>(
        'button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])'
      );
      if (focusable.length === 0) return;

      const first = focusable[0]!;
      const last = focusable[focusable.length - 1]!;

      if (event.shiftKey) {
        if (document.activeElement === first) {
          last.focus();
          event.preventDefault();
        }
      } else {
        if (document.activeElement === last) {
          first.focus();
          event.preventDefault();
        }
      }
    },
    [hideModal]
  );

  // On mount: capture trigger, lock scroll, set up keyboard, move focus
  useLayoutEffect(() => {
    // Remember what triggered the modal so we can restore focus
    triggerRef.current = document.activeElement;

    const { overflow } = window.getComputedStyle(document.body);
    document.body.style.overflow = "hidden";
    window.addEventListener("keydown", handleKeyDown, false);

    // Fade in animation
    setTimeout(() => setFadeIn(true), 0);

    // Move focus into the modal
    setTimeout(() => {
      const node = ref.current;
      if (node) {
        const firstFocusable = node.querySelector<HTMLElement>(
          'button:not([disabled]), [href], input:not([disabled])'
        );
        if (firstFocusable) {
          firstFocusable.focus();
        } else {
          // Fallback: focus the dialog itself
          node.focus();
        }
      }
    }, 50);

    return () => {
      document.body.style.overflow = overflow;
      window.removeEventListener("keydown", handleKeyDown, false);
    };
  }, [handleKeyDown]);

  useLayoutEffect(() => {
    // Create a dedicated container for the portal to avoid React cleanup conflicts
    let container = document.getElementById(PORTAL_CONTAINER_ID);
    if (!container) {
      container = document.createElement("div");
      container.id = PORTAL_CONTAINER_ID;
      document.body.appendChild(container);
    }
    setPortal(container);

    return () => {
      // Clean up the portal container on unmount
      const el = document.getElementById(PORTAL_CONTAINER_ID);
      if (el && el.parentNode) {
        el.parentNode.removeChild(el);
      }
    };
  }, []);

  const hasCollapsed = collapsedWallets.length > 0;
  const hasListed = listedWallets.length > 0;

  return (
    portal &&
    createPortal(
      <div
        aria-labelledby={MODAL_TITLE_ID}
        aria-modal="true"
        className={`wallet-adapter-modal ${fadeIn ? "wallet-adapter-modal-fade-in" : ""}`}
        ref={ref}
        role="dialog"
        tabIndex={-1}
      >
        <div className="wallet-adapter-modal-container">
          <div className="wallet-adapter-modal-wrapper">
            <button
              onClick={handleClose}
              className="wallet-adapter-modal-button-close"
              aria-label="Close wallet selection"
            >
              <svg width="14" height="14" aria-hidden="true">
                <path d="M14 12.461 8.3 6.772l5.234-5.233L12.006 0 6.772 5.234 1.54 0 0 1.539l5.234 5.233L0 12.006l1.539 1.528L6.772 8.3l5.69 5.7L14 12.461z" />
              </svg>
            </button>

            {hasListed ? (
              <>
                <h1
                  id={MODAL_TITLE_ID}
                  className="wallet-adapter-modal-title"
                >
                  Connect a wallet on Solana to continue
                </h1>
                <ul
                  className="wallet-adapter-modal-list"
                  role="list"
                  aria-label="Available wallets"
                >
                  {listedWallets.map((wallet) => (
                    <li key={wallet.adapter.name} role="listitem">
                      <button
                        className="wallet-adapter-button"
                        onClick={(e) =>
                          handleWalletClick(e, wallet.adapter.name)
                        }
                        type="button"
                        tabIndex={0}
                        aria-label={`Connect ${wallet.adapter.name}${wallet.readyState === WalletReadyState.Installed ? " (detected)" : ""}`}
                      >
                        <i className="wallet-adapter-button-start-icon">
                          <img
                            src={wallet.adapter.icon}
                            alt=""
                            aria-hidden="true"
                          />
                        </i>
                        {wallet.adapter.name}
                        {wallet.readyState ===
                          WalletReadyState.Installed && (
                          <span>Detected</span>
                        )}
                      </button>
                    </li>
                  ))}
                </ul>

                {hasCollapsed && (
                  <>
                    <button
                      className="wallet-adapter-modal-list-more"
                      onClick={handleCollapseClick}
                      tabIndex={0}
                      aria-expanded={expanded}
                      aria-controls={COLLAPSE_ID}
                    >
                      <span>
                        {expanded ? "Less " : "More "}options
                      </span>
                      <svg
                        width="13"
                        height="7"
                        viewBox="0 0 13 7"
                        xmlns="http://www.w3.org/2000/svg"
                        aria-hidden="true"
                        className={
                          expanded
                            ? "wallet-adapter-modal-list-more-icon-rotate"
                            : ""
                        }
                      >
                        <path d="M0.71418 1.626L5.83323 6.26188C5.91574 6.33657 6.0181 6.39652 6.13327 6.43762C6.24844 6.47872 6.37371 6.5 6.50048 6.5C6.62725 6.5 6.75252 6.47872 6.8677 6.43762C6.98287 6.39652 7.08523 6.33657 7.16774 6.26188L12.2868 1.626C12.7753 1.1835 12.3703 0.5 11.6195 0.5H1.37997C0.629216 0.5 0.224175 1.1835 0.71418 1.626Z" />
                      </svg>
                    </button>
                    <div
                      id={COLLAPSE_ID}
                      role="region"
                      aria-label="Additional wallet options"
                      hidden={!expanded}
                    >
                      <ul
                        className="wallet-adapter-modal-list"
                        role="list"
                        aria-label="More wallets"
                      >
                        {collapsedWallets.map((wallet) => (
                          <li
                            key={wallet.adapter.name}
                            role="listitem"
                          >
                            <button
                              className="wallet-adapter-button"
                              onClick={(e) =>
                                handleWalletClick(
                                  e,
                                  wallet.adapter.name
                                )
                              }
                              type="button"
                              tabIndex={expanded ? 0 : -1}
                              aria-label={`Connect ${wallet.adapter.name}`}
                            >
                              <i className="wallet-adapter-button-start-icon">
                                <img
                                  src={wallet.adapter.icon}
                                  alt=""
                                  aria-hidden="true"
                                />
                              </i>
                              {wallet.adapter.name}
                            </button>
                          </li>
                        ))}
                      </ul>
                    </div>
                  </>
                )}
              </>
            ) : (
              <>
                <h1
                  id={MODAL_TITLE_ID}
                  className="wallet-adapter-modal-title"
                >
                  You&apos;ll need a wallet on Solana to continue
                </h1>
                <div
                  className="wallet-adapter-modal-middle"
                  aria-hidden="true"
                >
                  {/* Decorative wallet SVG */}
                  <svg
                    xmlns="http://www.w3.org/2000/svg"
                    width="97"
                    height="96"
                    viewBox="0 0 97 96"
                    fill="none"
                  >
                    <circle
                      cx="48.5"
                      cy="48"
                      r="48"
                      fill="url(#paint0_linear_880_5115)"
                      fillOpacity="0.1"
                    />
                    <circle
                      cx="48.5"
                      cy="48"
                      r="47"
                      stroke="url(#paint1_linear_880_5115)"
                      strokeOpacity="0.4"
                      strokeWidth="2"
                    />
                    <g clipPath="url(#clip0_880_5115)">
                      <path
                        d="M65.5769 28.1523H31.4231C29.8077 28.1523 28.5 29.4601 28.5 31.0754V64.9216C28.5 66.5369 29.8077 67.8447 31.4231 67.8447H65.5769C67.1923 67.8447 68.5 66.5369 68.5 64.9216V31.0754C68.5 29.4601 67.1923 28.1523 65.5769 28.1523Z"
                        stroke="url(#paint2_linear_880_5115)"
                        strokeWidth="3"
                        strokeLinecap="round"
                        strokeLinejoin="round"
                      />
                      <path
                        d="M41.1155 42.7686H56.8847"
                        stroke="url(#paint3_linear_880_5115)"
                        strokeWidth="3"
                        strokeLinecap="round"
                        strokeLinejoin="round"
                      />
                    </g>
                    <defs>
                      <linearGradient
                        id="paint0_linear_880_5115"
                        x1="48.5"
                        y1="0"
                        x2="48.5"
                        y2="96"
                        gradientUnits="userSpaceOnUse"
                      >
                        <stop stopColor="white" />
                        <stop
                          offset="1"
                          stopColor="white"
                          stopOpacity="0"
                        />
                      </linearGradient>
                      <linearGradient
                        id="paint1_linear_880_5115"
                        x1="48.5"
                        y1="0"
                        x2="48.5"
                        y2="96"
                        gradientUnits="userSpaceOnUse"
                      >
                        <stop stopColor="white" />
                        <stop
                          offset="1"
                          stopColor="white"
                          stopOpacity="0"
                        />
                      </linearGradient>
                      <linearGradient
                        id="paint2_linear_880_5115"
                        x1="48.5"
                        y1="28.1523"
                        x2="48.5"
                        y2="67.8447"
                        gradientUnits="userSpaceOnUse"
                      >
                        <stop stopColor="white" />
                        <stop
                          offset="1"
                          stopColor="white"
                          stopOpacity="0.82"
                        />
                      </linearGradient>
                      <linearGradient
                        id="paint3_linear_880_5115"
                        x1="49"
                        y1="42.7686"
                        x2="49"
                        y2="43.7686"
                        gradientUnits="userSpaceOnUse"
                      >
                        <stop stopColor="white" />
                        <stop
                          offset="1"
                          stopColor="white"
                          stopOpacity="0.82"
                        />
                      </linearGradient>
                      <clipPath id="clip0_880_5115">
                        <rect
                          width="48"
                          height="48"
                          fill="white"
                          transform="translate(24.5 24)"
                        />
                      </clipPath>
                    </defs>
                  </svg>
                </div>
                {hasCollapsed && (
                  <>
                    <button
                      className="wallet-adapter-modal-list-more"
                      onClick={handleCollapseClick}
                      tabIndex={0}
                      aria-expanded={expanded}
                      aria-controls={COLLAPSE_ID}
                    >
                      <span>
                        {expanded
                          ? "Hide "
                          : "Already have a wallet? View "}
                        options
                      </span>
                      <svg
                        width="13"
                        height="7"
                        viewBox="0 0 13 7"
                        xmlns="http://www.w3.org/2000/svg"
                        aria-hidden="true"
                        className={
                          expanded
                            ? "wallet-adapter-modal-list-more-icon-rotate"
                            : ""
                        }
                      >
                        <path d="M0.71418 1.626L5.83323 6.26188C5.91574 6.33657 6.0181 6.39652 6.13327 6.43762C6.24844 6.47872 6.37371 6.5 6.50048 6.5C6.62725 6.5 6.75252 6.47872 6.8677 6.43762C6.98287 6.39652 7.08523 6.33657 7.16774 6.26188L12.2868 1.626C12.7753 1.1835 12.3703 0.5 11.6195 0.5H1.37997C0.629216 0.5 0.224175 1.1835 0.71418 1.626Z" />
                      </svg>
                    </button>
                    <div
                      id={COLLAPSE_ID}
                      role="region"
                      aria-label="Wallet options"
                      hidden={!expanded}
                    >
                      <ul
                        className="wallet-adapter-modal-list"
                        role="list"
                        aria-label="Available wallets"
                      >
                        {collapsedWallets.map((wallet) => (
                          <li
                            key={wallet.adapter.name}
                            role="listitem"
                          >
                            <button
                              className="wallet-adapter-button"
                              onClick={(e) =>
                                handleWalletClick(
                                  e,
                                  wallet.adapter.name
                                )
                              }
                              type="button"
                              tabIndex={expanded ? 0 : -1}
                              aria-label={`Connect ${wallet.adapter.name}`}
                            >
                              <i className="wallet-adapter-button-start-icon">
                                <img
                                  src={wallet.adapter.icon}
                                  alt=""
                                  aria-hidden="true"
                                />
                              </i>
                              {wallet.adapter.name}
                            </button>
                          </li>
                        ))}
                      </ul>
                    </div>
                  </>
                )}
              </>
            )}
          </div>
        </div>
        <div
          className="wallet-adapter-modal-overlay"
          role="presentation"
          onMouseDown={handleClose}
        />
      </div>,
      portal
    )
  );
};
