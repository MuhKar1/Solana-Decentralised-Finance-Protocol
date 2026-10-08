"use client";

import { useCallback, useState } from "react";
import type { TxStatus } from "@/lib/constants";
import { parseErrorMessage } from "@/lib/errors";

/**
 * Standardized transaction lifecycle:
 *   idle -> signing -> submitting -> confirming -> confirmed / failed
 *
 * The program's instruction methods use Anchor's `.rpc()`, which atomically
 * signs, submits, and awaits confirmation. We therefore surface "signing"
 * before the call and "confirming" while awaiting the on-chain result.
 */
export function useTx() {
  const [status, setStatus] = useState<TxStatus>("idle");
  const [error, setError] = useState("");
  const [ok, setOk] = useState("");

  const reset = useCallback(() => {
    setStatus("idle");
    setError("");
    setOk("");
  }, []);

  const run = useCallback(
    async (executor: () => Promise<string>, successMsg?: string) => {
      setError("");
      setOk("");
      setStatus("signing");
      try {
        const signature = await executor();
        // The executor has already submitted; confirmation is in-flight.
        setStatus("confirming");
        setOk(
          successMsg ?? `Transaction confirmed: ${signature.slice(0, 12)}...`
        );
        setStatus("confirmed");
        return signature;
      } catch (e) {
        setStatus("failed");
        setError(parseErrorMessage(e));
        return undefined;
      }
    },
    []
  );

  return { status, error, ok, setOk, reset, run };
}
