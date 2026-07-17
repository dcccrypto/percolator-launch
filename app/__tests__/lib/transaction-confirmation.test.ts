import { describe, expect, it } from "vitest";
import {
  assertSuccessfulConfirmation,
} from "../../lib/transaction-confirmation";

describe("assertSuccessfulConfirmation", () => {
  it("accepts a confirmation with value.err set to null", () => {
    expect(() =>
      assertSuccessfulConfirmation(
        {
          value: {
            err: null,
          },
        },
        "Test operation",
      ),
    ).not.toThrow();
  });

  it("rejects a confirmation containing an on-chain execution error", () => {
    expect(() =>
      assertSuccessfulConfirmation(
        {
          value: {
            err: {
              InstructionError: [
                0,
                {
                  Custom: 1,
                },
              ],
            },
          },
        },
        "Test operation",
      ),
    ).toThrow(
      /Test operation confirmed but failed on-chain/,
    );
  });

  it("fails closed when value is missing", () => {
    expect(() =>
      assertSuccessfulConfirmation(
        {},
        "Malformed confirmation",
      ),
    ).toThrow(
      /Malformed confirmation confirmed but failed on-chain/,
    );
  });

  it("fails closed when err is missing", () => {
    expect(() =>
      assertSuccessfulConfirmation(
        {
          value: {},
        },
        "Incomplete confirmation",
      ),
    ).toThrow(
      /Incomplete confirmation confirmed but failed on-chain/,
    );
  });
});
