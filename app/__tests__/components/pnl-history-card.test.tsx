import "@testing-library/jest-dom";
import { afterEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, within } from "@testing-library/react";
import { PnlHistoryCard, type PnlHistoryViewModel } from "@/components/dashboard/pnl-history/PnlHistoryCard";

afterEach(() => vi.unstubAllEnvs());

const demo: PnlHistoryViewModel = {
  kind: "records",
  source: "demo",
  summary: {
    today: 12.06,
    days7: 137.76,
    days30: -64.17,
    ytd: 1284.63,
    lifetime: 2917.4,
  },
  days: {
    "2026-10-05": { kind: "activity", realizedPnlUsd: -11.9 },
    "2026-10-06": { kind: "activity", realizedPnlUsd: 24.81 },
    "2026-10-07": { kind: "no-activity" },
  },
};

const verified = (days: Extract<PnlHistoryViewModel, { kind: "records" }>["days"]): PnlHistoryViewModel => ({
  kind: "records",
  source: "verified",
  summary: { today: null, days7: null, days30: null, ytd: null, lifetime: null },
  days,
});

describe("isolated PnL History Card", () => {
  it("starts unseeded DAILY and WEEKLY at the current UTC day", () => {
    vi.useFakeTimers();

    try {
      vi.setSystemTime(new Date("2026-10-17T12:00:00Z"));

      render(<PnlHistoryCard />);

      fireEvent.click(screen.getByRole("button", { name: "DAILY" }));
      expect(screen.getByText("October 17, 2026")).toBeInTheDocument();

      fireEvent.click(screen.getByRole("button", { name: "WEEKLY" }));
      expect(screen.getByText("Oct 12, 2026 – Oct 18, 2026")).toBeInTheDocument();
    } finally {
      vi.useRealTimers();
    }
  });

  it("fails closed: missing history is unavailable, never $0 or no activity", () => {
    render(<PnlHistoryCard initialMonth="2026-10" />);
    expect(screen.getByRole("status")).toHaveTextContent(/History unavailable/);
    expect(screen.queryByText("$0.00")).not.toBeInTheDocument();
    const unknown = within(screen.getByTestId("pnl-day-2026-10-06"));
    expect(unknown.getByText("—")).toBeInTheDocument();
    expect(screen.getByText("October 2026")).toBeInTheDocument();
  });

  it("shows clearly labeled demo only in non-production, with explicit loss signs", () => {
    render(<PnlHistoryCard initialMonth="2026-10" data={demo} />);
    expect(screen.getByText(/DEMO DATA — not wallet performance/)).toBeInTheDocument();
    expect(within(screen.getByTestId("pnl-day-2026-10-05")).getByText("-$11.90")).toBeInTheDocument();
    expect(within(screen.getByTestId("pnl-day-2026-10-06")).getByText("+$24.81")).toBeInTheDocument();
    expect(within(screen.getByTestId("pnl-day-2026-10-07")).getByText("·")).toBeInTheDocument();
    expect(screen.getByText("-$64.17")).toBeInTheDocument();
  });

  it("does not allow demo records to display in production mode, including other periods", () => {
    vi.stubEnv("NODE_ENV", "production");
    render(<PnlHistoryCard initialMonth="2026-10" data={demo} />);
    expect(screen.getByRole("status")).toHaveTextContent(/History unavailable/);
    expect(screen.queryByText("+$24.81")).not.toBeInTheDocument();
    expect(screen.queryByText(/DEMO DATA/)).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "DAILY" }));
    expect(within(screen.getByLabelText("Daily PnL detail")).getByText("—")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "YEARLY" }));
    expect(within(screen.getByTestId("pnl-year-month-2026-10")).getByText("—")).toBeInTheDocument();
  });

  it("navigates between UTC calendar months, without fetching data", () => {
    render(<PnlHistoryCard initialMonth="2026-10" />);
    fireEvent.click(screen.getByRole("button", { name: "Previous month" }));
    expect(screen.getByText("September 2026")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Next month" }));
    expect(screen.getByText("October 2026")).toBeInTheDocument();
    expect(screen.getByTestId("pnl-day-2026-10-31")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "DAILY" })).toBeEnabled();
  });

  it("makes all four period controls interactive and accessible", () => {
    render(<PnlHistoryCard initialMonth="2026-10" data={demo} />);
    expect(screen.getByRole("button", { name: "MONTHLY" })).toHaveAttribute("aria-pressed", "true");
    for (const range of ["DAILY", "WEEKLY", "YEARLY", "MONTHLY"] as const) {
      fireEvent.click(screen.getByRole("button", { name: range }));
      expect(screen.getByRole("button", { name: range })).toHaveAttribute("aria-pressed", "true");
    }
    expect(screen.getByLabelText("October 2026 calendar")).toBeInTheDocument();
  });

  it("opens a selected day from monthly, then navigates across UTC month boundaries", () => {
    render(<PnlHistoryCard initialMonth="2026-10" data={demo} />);
    fireEvent.click(screen.getByTestId("pnl-day-2026-10-06"));
    expect(screen.getByText("October 6, 2026")).toBeInTheDocument();
    expect(within(screen.getByLabelText("Daily PnL detail")).getByText("+$24.81")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Previous day" }));
    expect(screen.getByText("October 5, 2026")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "MONTHLY" }));
    fireEvent.click(screen.getByTestId("pnl-day-2026-10-01"));
    fireEvent.click(screen.getByRole("button", { name: "Previous day" }));
    expect(screen.getByText("September 30, 2026")).toBeInTheDocument();
  });

  it("shows confirmed no activity as a dot, but never treats unknown dates as zero", () => {
    render(<PnlHistoryCard initialMonth="2026-10" data={demo} />);
    fireEvent.click(screen.getByTestId("pnl-day-2026-10-07"));
    expect(within(screen.getByLabelText("Daily PnL detail")).getByText("·")).toBeInTheDocument();
    expect(screen.getByText("Confirmed no activity")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Next day" }));
    expect(within(screen.getByLabelText("Daily PnL detail")).getByText("—")).toBeInTheDocument();
    expect(screen.getByText(/Unavailable — no verified day record/)).toBeInTheDocument();
  });

  it("fails closed on an incomplete weekly aggregate", () => {
    render(<PnlHistoryCard initialMonth="2026-10" data={demo} />);
    fireEvent.click(screen.getByTestId("pnl-day-2026-10-06"));
    fireEvent.click(screen.getByRole("button", { name: "WEEKLY" }));
    expect(screen.getByText(/Week total · 3\/7 verified days/)).toBeInTheDocument();
    expect(screen.getByText("Incomplete period — total unavailable.")).toBeInTheDocument();
    expect(within(screen.getByTestId("pnl-week-day-2026-10-07")).getByText("·")).toBeInTheDocument();
    expect(within(screen.getByTestId("pnl-week-day-2026-10-08")).getByText("—")).toBeInTheDocument();
  });

  it("sums a fully verified week, including a zero-activity-day record", () => {
    const fullWeek = verified({
      "2026-10-05": { kind: "activity", realizedPnlUsd: 1 },
      "2026-10-06": { kind: "activity", realizedPnlUsd: -2 },
      "2026-10-07": { kind: "no-activity" },
      "2026-10-08": { kind: "activity", realizedPnlUsd: 3 },
      "2026-10-09": { kind: "activity", realizedPnlUsd: 0 },
      "2026-10-10": { kind: "activity", realizedPnlUsd: 2 },
      "2026-10-11": { kind: "activity", realizedPnlUsd: -1 },
    });
    render(<PnlHistoryCard initialMonth="2026-10" data={fullWeek} />);
    fireEvent.click(screen.getByTestId("pnl-day-2026-10-06"));
    fireEvent.click(screen.getByRole("button", { name: "WEEKLY" }));
    const summary = screen.getByText("Week total · 7/7 verified days").parentElement;
    expect(summary).not.toBeNull();
    expect(within(summary as HTMLElement).getByText("+$3.00")).toBeInTheDocument();
    expect(within(screen.getByTestId("pnl-week-day-2026-10-07")).getByText("·")).toBeInTheDocument();
    expect(within(screen.getByTestId("pnl-week-day-2026-10-09")).getByText("$0.00")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Previous week" }));
    expect(screen.getByText(/Sep 28, 2026 – Oct 4, 2026/)).toBeInTheDocument();
  });

  it("displays year and 12 months but never invents totals for incomplete history", () => {
    render(<PnlHistoryCard initialMonth="2026-10" data={demo} />);
    fireEvent.click(screen.getByRole("button", { name: "YEARLY" }));
    expect(screen.getByLabelText("2026 yearly calendar")).toBeInTheDocument();
    expect(screen.getAllByTestId(/pnl-year-month-2026-/)).toHaveLength(12);
    expect(within(screen.getByTestId("pnl-year-month-2026-10")).getByText("—")).toBeInTheDocument();
    expect(within(screen.getByTestId("pnl-year-month-2026-10")).getByText("3/31 verified days")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Next year" }));
    expect(screen.getByLabelText("2027 yearly calendar")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Previous year" }));
    fireEvent.click(screen.getByTestId("pnl-year-month-2026-10"));
    expect(screen.getByLabelText("October 2026 calendar")).toBeInTheDocument();
  });

  it("aggregates leap-year February only if all 29 days are known", () => {
    const febDays: Record<string, { kind: "activity"; realizedPnlUsd: number } | { kind: "no-activity" }> = {};
    for (let day = 1; day <= 29; day++) {
      febDays[`2028-02-${String(day).padStart(2, "0")}`] = day === 29
        ? { kind: "activity", realizedPnlUsd: -2 }
        : { kind: "no-activity" };
    }
    render(<PnlHistoryCard initialMonth="2028-02" data={verified(febDays)} />);
    fireEvent.click(screen.getByRole("button", { name: "YEARLY" }));
    const feb = within(screen.getByTestId("pnl-year-month-2028-02"));
    expect(feb.getByText("29/29 verified days")).toBeInTheDocument();
    expect(feb.getByText("-$2.00")).toBeInTheDocument();
    expect(within(screen.getByTestId("pnl-year-month-2028-01")).getByText("—")).toBeInTheDocument();
  });

  it("preserves deliberate mobile horizontal scroll containment", () => {
    render(<PnlHistoryCard initialMonth="2026-10" data={demo} />);
    expect(screen.getByLabelText("Monthly calendar scroll area")).toHaveClass("overflow-x-auto");
    expect(screen.getByText("Swipe horizontally to view the calendar.")).toBeInTheDocument();
  });
});
