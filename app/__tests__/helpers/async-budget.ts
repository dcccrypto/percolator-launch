/**
 * Per-suite Testing Library async budget (waitFor / findBy* default to 1000 ms wall clock).
 *
 * The Privy bridge suites wait on two or more React state transitions per assertion and miss that
 * budget on a loaded machine (full parallel run) while passing alone. The budget is raised for
 * THOSE files only: a global raise would also stretch every other suite's failure path and could
 * hide a real slowness regression elsewhere. A passing waitFor still resolves on its first
 * successful poll, so nothing gets slower. 5 s stays under the 10 s testTimeout, so a stuck test
 * still fails with its own assertion error.
 *
 * Call at module top level of the test file. The previous value is restored afterAll.
 */
import { configure, getConfig } from "@testing-library/react";
import { afterAll, beforeAll } from "vitest";

export function useAsyncUtilTimeout(ms = 5000): void {
  let previous = 1000;
  beforeAll(() => {
    previous = getConfig().asyncUtilTimeout;
    configure({ asyncUtilTimeout: ms });
  });
  afterAll(() => {
    configure({ asyncUtilTimeout: previous });
  });
}
