/**
 * OracleBadge Component Tests
 * Tests: ORACLE-001, ORACLE-002, ORACLE-003
 *
 * ORACLE-001: Renders correct label for each oracle mode
 * ORACLE-002: Renders correct status overrides (stale, error)
 * ORACLE-003: Applies pulse animation only when healthy
 */

import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import { OracleBadge } from "@/components/oracle/OracleBadge";

describe("OracleBadge", () => {
  it("ORACLE-001: renders HYPERP label for hyperp mode", () => {
    render(<OracleBadge mode="hyperp" />);
    expect(screen.getByText("HYPERP")).toBeDefined();
  });

  it("ORACLE-001: renders PYTH label for pyth-pinned mode", () => {
    render(<OracleBadge mode="pyth-pinned" />);
    expect(screen.getByText("PYTH")).toBeDefined();
  });

  it("ORACLE-001: renders ADMIN label for admin mode", () => {
    render(<OracleBadge mode="admin" />);
    expect(screen.getByText("ADMIN")).toBeDefined();
  });

  it("ORACLE-001: renders POOL label for pool mode", () => {
    render(<OracleBadge mode="pool" />);
    expect(screen.getByText("POOL")).toBeDefined();
  });

  it("ORACLE-002: renders STALE for stale status", () => {
    render(<OracleBadge mode="hyperp" status="stale" />);
    expect(screen.getByText("STALE")).toBeDefined();
  });

  it("ORACLE-002: renders OFFLINE for error status", () => {
    render(<OracleBadge mode="hyperp" status="error" />);
    expect(screen.getByText("OFFLINE")).toBeDefined();
  });

  it("ORACLE-003: applies oracle-pulse animation when healthy", () => {
    const { container } = render(<OracleBadge mode="hyperp" status="healthy" pulse={true} />);
    const badge = container.firstChild as HTMLElement;
    expect(badge.style.animation).toContain("oracle-pulse");
  });

  it("ORACLE-003: does not apply animation when pulse=false", () => {
    const { container } = render(<OracleBadge mode="hyperp" status="healthy" pulse={false} />);
    const badge = container.firstChild as HTMLElement;
    expect(badge.style.animation).toBeFalsy();
  });

  it("ORACLE-003: does not apply animation for stale status", () => {
    const { container } = render(<OracleBadge mode="hyperp" status="stale" pulse={true} />);
    const badge = container.firstChild as HTMLElement;
    expect(badge.style.animation).toBeFalsy();
  });
});
