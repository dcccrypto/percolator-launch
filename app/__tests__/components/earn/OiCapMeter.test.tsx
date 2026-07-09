import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { OiCapMeter } from '@/components/earn/OiCapMeter';

describe('OiCapMeter', () => {
  it('renders current and max OI values', () => {
    const { container } = render(
      <OiCapMeter currentOI={45000} maxOI={250000} />,
    );
    // formatCompact now comes from the shared lib/formatters.ts (deduped from
    // this component's own local copy) — 2 decimal places on the K tier,
    // matching lib/formatters.ts's canonical formatting used app-wide.
    expect(container.textContent).toContain('$45.00K');
    expect(container.textContent).toContain('$250.00K');
  });

  it('calculates utilization percentage correctly', () => {
    const { container } = render(
      <OiCapMeter currentOI={125000} maxOI={250000} />,
    );
    expect(container.textContent).toContain('50.0%');
  });

  it('shows Healthy status when utilization < 50%', () => {
    const { container } = render(
      <OiCapMeter currentOI={10000} maxOI={250000} />,
    );
    expect(container.textContent).toContain('Healthy');
  });

  it('shows Near Capacity status when utilization >= 90%', () => {
    const { container } = render(
      <OiCapMeter currentOI={230000} maxOI={250000} />,
    );
    expect(container.textContent).toContain('Near Capacity');
  });

  it('shows High Utilization status when utilization >= 75%', () => {
    const { container } = render(
      <OiCapMeter currentOI={200000} maxOI={250000} />,
    );
    expect(container.textContent).toContain('High Utilization');
  });

  it('renders compact variant without labels', () => {
    const { container } = render(
      <OiCapMeter currentOI={45000} maxOI={250000} compact />,
    );
    // Compact variant should not show "Current" or "Max" labels
    expect(container.textContent).not.toContain('Current:');
    expect(container.textContent).not.toContain('OI Capacity');
  });

  it('handles zero maxOI gracefully', () => {
    const { container } = render(
      <OiCapMeter currentOI={0} maxOI={0} />,
    );
    expect(container.textContent).toContain('0.0%');
  });

  it('caps utilization at 100%', () => {
    const { container } = render(
      <OiCapMeter currentOI={300000} maxOI={250000} />,
    );
    expect(container.textContent).toContain('100.0%');
  });
});
