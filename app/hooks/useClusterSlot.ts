"use client";

import { useEffect, useState } from "react";
import type { Connection } from "@solana/web3.js";
import { useConnectionCompat } from "@/hooks/useWalletCompat";
import { pollWhenVisible } from "@/lib/pollWhenVisible";

const SLOT_POLL_MS = 10_000;

export interface ClusterSlotObservation {
  slot: bigint;
  observedAtMs: number;
}

type ClusterSlotListener = (
  observation: ClusterSlotObservation,
) => void;

let sharedObservation: ClusterSlotObservation | null = null;
let listeners: Set<ClusterSlotListener> | null = null;
let disposer: (() => void) | null = null;
let subscriptionGeneration = 0;

function subscribeSharedSlot(
  connection: Connection,
  listener: ClusterSlotListener,
): () => void {
  if (listeners === null) {
    listeners = new Set();
  }

  listeners.add(listener);

  // Replay the latest known observation immediately to new subscribers.
  if (sharedObservation !== null) {
    listener(sharedObservation);
  }

  if (disposer === null) {
    const poll = () => {
      const generation = subscriptionGeneration;

      let request: Promise<number>;
      try {
        request = connection.getSlot("confirmed");
      } catch {
        // A connection that cannot report a slot (a partial stand-in): keep the last known observation.
        return;
      }
      request
        .then((slot) => {
          // A request started by a previous subscriber generation may finish
          // after the final old subscriber has already unmounted. Never allow
          // that completion to mutate the new generation's shared state.
          if (generation !== subscriptionGeneration) {
            return;
          }

          const nextSlot = BigInt(slot);

          // A cluster slot is monotonic for our freshness purposes. Repeated
          // or older observations must not move the observation timestamp
          // forward or regress the shared slot.
          if (
            sharedObservation !== null &&
            nextSlot <= sharedObservation.slot
          ) {
            return;
          }

          const observation: ClusterSlotObservation = {
            slot: nextSlot,
            observedAtMs: Date.now(),
          };

          sharedObservation = observation;
          listeners?.forEach((cb) => cb(observation));
        })
        .catch(() => {
          // Keep the last known observation on a transient RPC failure.
        });
    };

    poll();
    disposer = pollWhenVisible(poll, SLOT_POLL_MS);
  }

  return () => {
    listeners?.delete(listener);

    if (listeners?.size === 0 && disposer !== null) {
      // Invalidate every in-flight request started by this subscriber
      // generation before allowing a future generation to subscribe.
      subscriptionGeneration += 1;

      disposer();
      disposer = null;
      sharedObservation = null;
    }
  };
}

/**
 * Live cluster-slot observation shared across all consumers.
 *
 * `observedAtMs` is captured when the corresponding slot RPC succeeds, so
 * callers can anchor slot-derived timestamps to the actual observation time
 * instead of to an unrelated later render.
 */
export function useClusterSlotObservation(enabled = true): ClusterSlotObservation | null {
  const { connection } = useConnectionCompat();
  const [observation, setObservation] =
    useState<ClusterSlotObservation | null>(sharedObservation);

  useEffect(
    () => (enabled ? subscribeSharedSlot(connection, setObservation) : undefined),
    [connection, enabled],
  );

  return observation;
}

/**
 * Backward-compatible slot-only view for consumers that do not need the
 * wall-clock observation time.
 */
export function useClusterSlot(enabled = true): bigint | null {
  return useClusterSlotObservation(enabled)?.slot ?? null;
}
