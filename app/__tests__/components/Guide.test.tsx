/**
 * Guide Page Component Tests
 * 
 * Test Coverage:
 * - P-MED-6: Table of contents rendering and navigation
 * - Section headers and content structure
 * - Internal navigation links
 * - Responsive table rendering
 */

import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import GuidePage from '../../app/guide/page';

// Mock next/link
vi.mock('next/link', () => ({
  default: ({ children, href, ...props }: any) => <a href={href} {...props}>{children}</a>,
}));

// Mock ScrollReveal component
vi.mock('@/components/ui/ScrollReveal', () => ({
  ScrollReveal: ({ children }: any) => <div>{children}</div>,
}));

describe('Guide Page', () => {
  /**
   * P-MED-6: Table of Contents
   * Should render a navigable table of contents with all sections
   */
  it('should render table of contents with all sections', () => {
    render(<GuidePage />);

    // Check for ToC heading
    expect(screen.getByText(/Contents/i)).toBeInTheDocument();

    // Check for all expected ToC links
    const expectedSections = [
      'What is Percolator?',
      'Devnet vs Mainnet',
      'How Markets Work',
      'Oracle Modes',
      'Market Tiers',
      'Getting Started',
      'FAQ',
    ];

    expectedSections.forEach((section) => {
      expect(screen.getByText(section)).toBeInTheDocument();
    });
  });

  it('should have correct navigation links in table of contents', () => {
    render(<GuidePage />);

    // Check that ToC links have correct href attributes
    const overviewLink = screen.getByRole('link', { name: /What is Percolator/i });
    expect(overviewLink).toHaveAttribute('href', '#overview');

    const environmentsLink = screen.getByRole('link', { name: /Devnet vs Mainnet/i });
    expect(environmentsLink).toHaveAttribute('href', '#environments');

    const mechanicsLink = screen.getByRole('link', { name: /How Markets Work/i });
    expect(mechanicsLink).toHaveAttribute('href', '#mechanics');

    const oraclesLink = screen.getByRole('link', { name: /Oracle Modes/i });
    expect(oraclesLink).toHaveAttribute('href', '#oracles');

    const capacityLink = screen.getByRole('link', { name: /Market Tiers/i });
    expect(capacityLink).toHaveAttribute('href', '#capacity');

    const quickstartLink = screen.getByRole('link', { name: /Getting Started/i });
    expect(quickstartLink).toHaveAttribute('href', '#quickstart');

    const faqLink = screen.getByRole('link', { name: /FAQ/i });
    expect(faqLink).toHaveAttribute('href', '#faq');
  });

  /**
   * Section Structure Tests
   */
  it('should render all major sections with correct IDs', () => {
    const { container } = render(<GuidePage />);

    // Check that all sections have correct IDs for anchor navigation
    expect(container.querySelector('#overview')).toBeInTheDocument();
    expect(container.querySelector('#environments')).toBeInTheDocument();
    expect(container.querySelector('#mechanics')).toBeInTheDocument();
    expect(container.querySelector('#oracles')).toBeInTheDocument();
    expect(container.querySelector('#capacity')).toBeInTheDocument();
    expect(container.querySelector('#quickstart')).toBeInTheDocument();
    expect(container.querySelector('#faq')).toBeInTheDocument();
  });

  it('should render Overview section with key content', () => {
    render(<GuidePage />);

    expect(screen.getByText(/What is Percolator\?/i)).toBeInTheDocument();
    expect(screen.getByText(/pump\.fun for perps/i)).toBeInTheDocument();
    expect(screen.getByText(/No approvals, no gatekeepers/i)).toBeInTheDocument();
  });

  /**
   * Table Rendering Tests
   */
  it('should render Devnet vs Mainnet comparison table', () => {
    render(<GuidePage />);

    // Check for table headers
    expect(screen.getByText('Devnet')).toBeInTheDocument();
    expect(screen.getByText('Mainnet')).toBeInTheDocument();

    // Check for table content
    expect(screen.getByText(/Admin pushes prices manually/i)).toBeInTheDocument();
    expect(screen.getByText(/Live Pyth \/ DexScreener \/ Jupiter feeds/i)).toBeInTheDocument();
    expect(screen.getByText(/Test tokens from faucet/i)).toBeInTheDocument();
    expect(screen.getByText(/Real SPL tokens with DEX pools/i)).toBeInTheDocument();
  });

  it('should render Market Tiers table with cost information', () => {
    render(<GuidePage />);

    // Check for tier information
    expect(screen.getByText(/Small/i)).toBeInTheDocument();
    expect(screen.getByText(/Medium/i)).toBeInTheDocument();
    expect(screen.getByText(/Large/i)).toBeInTheDocument();

    // Check for slot counts
    expect(screen.getByText('256')).toBeInTheDocument();
    expect(screen.getByText('1,024')).toBeInTheDocument();
    expect(screen.getByText('4,096')).toBeInTheDocument();

    // Check for cost estimates
    expect(screen.getByText(/~\$65/i)).toBeInTheDocument();
    expect(screen.getByText(/~\$260/i)).toBeInTheDocument();
    expect(screen.getByText(/~\$1,000/i)).toBeInTheDocument();
  });

  /**
   * How Markets Work Section
   */
  it('should render How Markets Work section with mechanics', () => {
    render(<GuidePage />);

    // Check for key concepts
    expect(screen.getByText(/Coin-Margined/i)).toBeInTheDocument();
    expect(screen.getByText(/vAMM Liquidity/i)).toBeInTheDocument();
    expect(screen.getByText(/Crank Service/i)).toBeInTheDocument();
    expect(screen.getByText(/Insurance Fund/i)).toBeInTheDocument();

    // Check descriptions
    expect(screen.getByText(/You deposit the same token you are trading/i)).toBeInTheDocument();
    expect(screen.getByText(/virtual AMM/i)).toBeInTheDocument();
  });

  /**
   * Oracle Modes Section
   */
  it('should render Oracle Modes section with all modes', () => {
    render(<GuidePage />);

    expect(screen.getByText(/Admin Oracle/i)).toBeInTheDocument();
    expect(screen.getByText(/Pyth Oracle/i)).toBeInTheDocument();
    expect(screen.getByText(/DexScreener \/ Jupiter/i)).toBeInTheDocument();

    // Check for mode descriptions
    expect(screen.getByText(/Market creator pushes prices manually/i)).toBeInTheDocument();
    expect(screen.getByText(/Automatic real-time prices from the Pyth network/i)).toBeInTheDocument();
  });

  /**
   * Getting Started Section
   */
  it('should render Getting Started section with step-by-step guide', () => {
    render(<GuidePage />);

    expect(screen.getByText(/Connect Phantom/i)).toBeInTheDocument();
    expect(screen.getByText(/Get Test SOL/i)).toBeInTheDocument();
    expect(screen.getByText(/Create a Test Token/i)).toBeInTheDocument();
    expect(screen.getByText(/Launch a Market/i)).toBeInTheDocument();
    expect(screen.getByText(/Push Oracle Prices/i)).toBeInTheDocument();
    expect(screen.getByText(/Open Trades/i)).toBeInTheDocument();

    // Check for step numbers
    expect(screen.getByText('01')).toBeInTheDocument();
    expect(screen.getByText('02')).toBeInTheDocument();
    expect(screen.getByText('03')).toBeInTheDocument();
    expect(screen.getByText('04')).toBeInTheDocument();
    expect(screen.getByText('05')).toBeInTheDocument();
    expect(screen.getByText('06')).toBeInTheDocument();
  });

  /**
   * FAQ Section
   */
  it('should render FAQ section with collapsible questions', () => {
    render(<GuidePage />);

    // Check for FAQ questions
    expect(screen.getByText(/What happens if the oracle price is not updated/i)).toBeInTheDocument();
    expect(screen.getByText(/Can I recover the rent from a market/i)).toBeInTheDocument();
    expect(screen.getByText(/What is the insurance fund for/i)).toBeInTheDocument();
    expect(screen.getByText(/Can I use any Solana token/i)).toBeInTheDocument();
    expect(screen.getByText(/What is coin-margined trading/i)).toBeInTheDocument();
    expect(screen.getByText(/How do I switch between devnet and mainnet/i)).toBeInTheDocument();
  });

  it('should have expandable FAQ details elements', () => {
    const { container } = render(<GuidePage />);

    // Check that FAQ items are rendered as details elements
    const detailsElements = container.querySelectorAll('details');
    expect(detailsElements.length).toBeGreaterThanOrEqual(6);
  });

  /**
   * Call-to-Action Section
   */
  it('should render CTA buttons at the bottom', () => {
    render(<GuidePage />);

    const launchMarketButton = screen.getByRole('link', { name: /Launch a Market/i });
    expect(launchMarketButton).toBeInTheDocument();
    expect(launchMarketButton).toHaveAttribute('href', '/create');

    const browseMarketsButton = screen.getByRole('link', { name: /Browse Markets/i });
    expect(browseMarketsButton).toBeInTheDocument();
    expect(browseMarketsButton).toHaveAttribute('href', '/markets');
  });

  /**
   * Page Header
   */
  it('should render page header with title and description', () => {
    render(<GuidePage />);

    expect(screen.getByText(/Percolator/i)).toBeInTheDocument();
    expect(screen.getByText(/Guide/i)).toBeInTheDocument();
    expect(screen.getByText(/Everything you need to know about launching and trading/i)).toBeInTheDocument();
  });

  /**
   * Accessibility
   */
  it('should have semantic HTML structure', () => {
    const { container } = render(<GuidePage />);

    // Check for main element
    const main = container.querySelector('main');
    expect(main).toBeInTheDocument();

    // Check for nav element (table of contents)
    const nav = container.querySelector('nav');
    expect(nav).toBeInTheDocument();

    // Check for section elements
    const sections = container.querySelectorAll('section');
    expect(sections.length).toBeGreaterThanOrEqual(7);
  });

  it('should have proper heading hierarchy', () => {
    const { container } = render(<GuidePage />);

    // Check for h1 (main title)
    const h1 = container.querySelector('h1');
    expect(h1).toBeInTheDocument();
    expect(h1?.textContent).toContain('Guide');

    // Check for h2 elements (section titles and ToC)
    const h2Elements = container.querySelectorAll('h2');
    expect(h2Elements.length).toBeGreaterThanOrEqual(7);
  });

  /**
   * Visual Indicators
   */
  it('should render oracle mode indicators with correct colors', () => {
    const { container } = render(<GuidePage />);

    // Oracle section should have colored indicators for devnet/mainnet
    const oracleSection = container.querySelector('#oracles');
    expect(oracleSection).toBeInTheDocument();

    // Check for environment badges
    expect(screen.getByText('devnet')).toBeInTheDocument();
    const mainnetBadges = screen.getAllByText('mainnet');
    expect(mainnetBadges.length).toBeGreaterThanOrEqual(2); // Pyth and DexScreener
  });

  /**
   * Navigation Interaction
   */
  it('should support keyboard navigation for ToC links', () => {
    render(<GuidePage />);

    const firstToCLink = screen.getByRole('link', { name: /What is Percolator/i });
    
    // Should be focusable
    firstToCLink.focus();
    expect(document.activeElement).toBe(firstToCLink);
  });

  it('should have scroll-margin classes for anchor targets', () => {
    const { container } = render(<GuidePage />);

    // Sections should have scroll-margin for proper anchor scrolling
    const sections = container.querySelectorAll('section');
    sections.forEach(section => {
      const classList = Array.from(section.classList);
      expect(classList.some(cls => cls.includes('scroll'))).toBe(true);
    });
  });
});
