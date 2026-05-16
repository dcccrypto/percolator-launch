/**
 * Transactional email template — light theme, maximum email-client
 * compatibility. Previously dark-themed; switched after Apple Mail /
 * iOS Mail / a few other clients force-rendered the dark bg as light
 * but left the light-on-dark text colors alone, producing unreadable
 * light-on-light copy. Light theme dodges that whole class of failure.
 *
 * Constraints baked into this design:
 *   - All CSS inline. Email clients strip <style> blocks.
 *   - Table-based layout (one outer <table>) for legacy Outlook.
 *   - No CSS vars, no flexbox, no grid.
 *   - No web fonts. System sans + system mono.
 *   - Sharp corners (`border-radius: 0`) to match the product.
 *   - Solid colors only — no gradients (uneven cross-client).
 *   - Explicit colors on EVERY text element (some clients break
 *     color inheritance on container darkening).
 *   - No `color-scheme: dark` hint — let the client render in its
 *     default mode; we've made sure both light + dark forced-mode
 *     renderings stay readable.
 *
 * Brand palette (light):
 *   page bg:   #F8F8FC (very light cool gray)
 *   panel bg:  #FFFFFF (white card)
 *   border:    #E0E0EC
 *   text:      #0D0E15 (near-black for body)
 *   muted:     #4A4B62 (warm dark grey — readable on both light + inverted)
 *   dim:       #8A8BA8 (mid grey for chrome)
 *   accent:    #9945FF (Solana purple)
 *   cyan:      #14BB6F (slightly darker green than --cyan so it stays readable on white)
 *
 * Logo:
 *   Hosted public asset at percolator.trade/images/logo-icon.png.
 *   Width-constrained inline; works in all clients.
 */

const SANS = `-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif`;
const MONO = `ui-monospace, SFMono-Regular, "SF Mono", Consolas, monospace`;

const COLOR = {
  bg: "#F8F8FC",
  panel: "#FFFFFF",
  border: "#E0E0EC",
  text: "#0D0E15",
  muted: "#4A4B62",
  dim: "#8A8BA8",
  accent: "#9945FF",
  cyan: "#14BB6F",
  long: "#23C47C",
};

const LOGO_URL = "https://percolator.trade/images/logo-icon.png";

export interface EmailLayout {
  /** Window-bar label — top-left, monospaced, dim. */
  preheader: string;
  /** Hidden preview text shown by mail clients in the inbox list. */
  previewText: string;
  /** Plain-text-only subject. Used by the caller when sending. */
  subject: string;
  /** Big headline at top of card. Plain text. */
  headline: string;
  /** Optional intro line shown immediately under the headline. */
  intro?: string;
  /** Inner content — pre-rendered HTML fragments. */
  contentHtml: string;
  /** Optional CTA button rendered above the footer. */
  cta?: { label: string; href: string };
}

/**
 * Renders a paragraph in the product's body-copy style.
 */
export function renderParagraph(text: string): string {
  return `<p style="margin:0 0 16px 0; font-family:${SANS}; font-size:14.5px; line-height:1.65; color:${COLOR.muted};">${text}</p>`;
}

/**
 * Renders the referral-code block — outlined sharp box, label in
 * accent-purple uppercase mono, code in big bold mono, share URL below.
 *
 * Background is set to a very light gray tint so the box stands out
 * against the white card on light clients, AND keeps usable contrast
 * if a client force-inverts the panel.
 */
export function renderCodeBlock(code: string, shareUrl: string): string {
  return `
    <table role="presentation" cellspacing="0" cellpadding="0" border="0" width="100%" style="margin:0 0 22px 0; border-collapse:collapse;">
      <tr>
        <td style="padding:18px 18px 16px 18px; background:#F8F8FC; border:1px solid ${COLOR.accent};">
          <div style="font-family:${MONO}; font-size:10.5px; letter-spacing:0.18em; text-transform:uppercase; color:${COLOR.accent}; margin:0 0 8px 0; font-weight:700;">
            Your referral code
          </div>
          <div style="font-family:${MONO}; font-size:26px; font-weight:700; letter-spacing:0.08em; color:${COLOR.text}; line-height:1;">
            ${code}
          </div>
          <div style="height:14px; line-height:14px; font-size:0;">&nbsp;</div>
          <div style="font-family:${MONO}; font-size:11.5px; color:${COLOR.muted}; word-break:break-all;">
            <span style="color:${COLOR.dim};">$&nbsp;</span><a href="${shareUrl}" style="color:${COLOR.accent}; text-decoration:underline;">${shareUrl.replace(/^https?:\/\//, "")}</a>
          </div>
        </td>
      </tr>
    </table>
  `.trim();
}

/**
 * Renders a `prefix · text` status line in the terminal-prompt style.
 */
export function renderStatusLine(prefix: string, text: string, color: string = COLOR.cyan): string {
  return `
    <div style="font-family:${MONO}; font-size:11.5px; color:${COLOR.dim}; margin:0 0 14px 0;">
      <span style="color:${COLOR.dim};">${prefix}</span> <span style="color:${color}; font-weight:600;">${text}</span>
    </div>
  `.trim();
}

/**
 * Renders a CTA button. Sharp accent-purple block, white uppercase
 * mono label. Uses bgcolor attribute + inline style for legacy Outlook.
 */
export function renderCta(label: string, href: string): string {
  return `
    <table role="presentation" cellspacing="0" cellpadding="0" border="0" style="margin:0 0 20px 0; border-collapse:collapse;">
      <tr>
        <td bgcolor="${COLOR.accent}" style="background:${COLOR.accent}; padding:0;">
          <a href="${href}" target="_blank" rel="noopener noreferrer" style="display:inline-block; padding:12px 24px; font-family:${MONO}; font-size:12px; font-weight:700; letter-spacing:0.16em; text-transform:uppercase; color:#FFFFFF; text-decoration:none;">
            ${label}&nbsp;&rarr;
          </a>
        </td>
      </tr>
    </table>
  `.trim();
}

export function renderDivider(): string {
  return `<div style="height:1px; line-height:1px; font-size:0; background:${COLOR.border}; margin:22px 0;">&nbsp;</div>`;
}

/**
 * Composes the full HTML email. Top logo row → window-bar header →
 * headline → intro → content → CTA → divider → footer.
 */
export function renderEmail(layout: EmailLayout): string {
  const { preheader, previewText, headline, intro, contentHtml, cta } = layout;

  const introHtml = intro
    ? `<p style="margin:0 0 18px 0; font-family:${SANS}; font-size:15px; line-height:1.6; color:${COLOR.muted};">${intro}</p>`
    : "";
  const ctaHtml = cta ? renderCta(cta.label, cta.href) : "";

  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <meta name="x-apple-disable-message-reformatting">
  <title>Percolator</title>
</head>
<body style="margin:0; padding:0; background:${COLOR.bg}; color:${COLOR.text}; font-family:${SANS}; -webkit-font-smoothing:antialiased; -moz-osx-font-smoothing:grayscale;">
  <!-- Preview text — shown in inbox preview, hidden from email body. -->
  <div style="display:none; max-height:0; max-width:0; overflow:hidden; opacity:0; mso-hide:all;">
    ${previewText}&nbsp;&zwnj;&nbsp;&zwnj;&nbsp;&zwnj;&nbsp;&zwnj;&nbsp;&zwnj;&nbsp;&zwnj;&nbsp;&zwnj;&nbsp;&zwnj;&nbsp;&zwnj;&nbsp;&zwnj;&nbsp;&zwnj;&nbsp;&zwnj;&nbsp;&zwnj;&nbsp;&zwnj;&nbsp;&zwnj;&nbsp;&zwnj;&nbsp;&zwnj;&nbsp;&zwnj;
  </div>

  <table role="presentation" cellspacing="0" cellpadding="0" border="0" width="100%" bgcolor="${COLOR.bg}" style="background:${COLOR.bg}; border-collapse:collapse;">
    <tr>
      <td align="center" style="padding:32px 16px 28px 16px;">

        <!-- Logo row, sits above the card so it survives card-bg inversions. -->
        <table role="presentation" cellspacing="0" cellpadding="0" border="0" width="600" style="max-width:600px; width:100%; border-collapse:collapse; margin-bottom:14px;">
          <tr>
            <td align="center" style="padding:0 0 4px 0;">
              <a href="https://percolator.trade" style="text-decoration:none;">
                <img src="${LOGO_URL}" alt="Percolator" width="40" height="40" style="display:block; margin:0 auto; width:40px; height:40px; border:0;">
              </a>
            </td>
          </tr>
          <tr>
            <td align="center" style="padding:6px 0 0 0; font-family:${MONO}; font-size:11px; letter-spacing:0.22em; text-transform:uppercase; color:${COLOR.dim};">
              percolator trade
            </td>
          </tr>
        </table>

        <table role="presentation" cellspacing="0" cellpadding="0" border="0" width="600" style="max-width:600px; width:100%; border-collapse:collapse; background:${COLOR.panel}; border:1px solid ${COLOR.border};">

          <!-- Window-bar header: traffic-light dots + mono label, matches the SignupCard frame. -->
          <tr>
            <td style="padding:14px 22px 12px 22px; border-bottom:1px solid ${COLOR.border}; background:${COLOR.panel};">
              <table role="presentation" cellspacing="0" cellpadding="0" border="0" width="100%" style="border-collapse:collapse;">
                <tr>
                  <td align="left" style="font-family:${MONO}; font-size:10.5px; letter-spacing:0.18em; text-transform:uppercase; color:${COLOR.muted};">
                    <span style="display:inline-block; width:8px; height:8px; background:#EE5050; margin-right:4px; vertical-align:middle; line-height:8px;">&nbsp;</span><span style="display:inline-block; width:8px; height:8px; background:#FBBF24; margin-right:4px; vertical-align:middle; line-height:8px;">&nbsp;</span><span style="display:inline-block; width:8px; height:8px; background:${COLOR.cyan}; margin-right:10px; vertical-align:middle; line-height:8px;">&nbsp;</span>${preheader}
                  </td>
                  <td align="right" style="font-family:${MONO}; font-size:10.5px; letter-spacing:0.12em; text-transform:uppercase; color:${COLOR.dim};">
                    v1
                  </td>
                </tr>
              </table>
            </td>
          </tr>

          <!-- Body -->
          <tr>
            <td style="padding:26px 28px 24px 28px; background:${COLOR.panel};">
              <h1 style="margin:0 0 12px 0; font-family:${SANS}; font-size:26px; line-height:1.18; font-weight:700; letter-spacing:-0.015em; color:${COLOR.text};">
                ${headline}
              </h1>
              ${introHtml}
              ${contentHtml}
              ${ctaHtml}
              ${renderDivider()}

              <!-- Footer: monospace social row -->
              <table role="presentation" cellspacing="0" cellpadding="0" border="0" width="100%" style="border-collapse:collapse;">
                <tr>
                  <td style="font-family:${MONO}; font-size:11px; letter-spacing:0.08em; color:${COLOR.dim};">
                    <a href="https://x.com/percolatortrade" style="color:${COLOR.muted}; text-decoration:none;">@percolatortrade</a>
                    &nbsp;·&nbsp;
                    <a href="https://github.com/dcccrypto" style="color:${COLOR.muted}; text-decoration:none;">github</a>
                    &nbsp;·&nbsp;
                    <a href="https://percolator.trade/pitch" style="color:${COLOR.muted}; text-decoration:none;">pitch</a>
                  </td>
                </tr>
              </table>
            </td>
          </tr>
        </table>

        <!-- Outside-card disclaimer -->
        <table role="presentation" cellspacing="0" cellpadding="0" border="0" width="600" style="max-width:600px; width:100%; border-collapse:collapse;">
          <tr>
            <td align="center" style="padding:16px 24px 0 24px; font-family:${SANS}; font-size:11px; line-height:1.55; color:${COLOR.dim};">
              You received this because you joined the Percolator waitlist at percolator.trade. Reply &ldquo;remove&rdquo; to be removed.
            </td>
          </tr>
        </table>

      </td>
    </tr>
  </table>

</body>
</html>`;
}

export function renderPlainText(opts: {
  preheader: string;
  headline: string;
  body: string;
  cta?: { label: string; href: string };
}): string {
  const ctaLine = opts.cta ? `\n\n${opts.cta.label}: ${opts.cta.href}` : "";
  return `${opts.preheader}\n\n${opts.headline}\n\n${opts.body}${ctaLine}\n\n—\n@percolatortrade · github.com/dcccrypto · percolator.trade/pitch\n\nYou received this because you joined the Percolator waitlist at percolator.trade. Reply "remove" to be removed.`;
}

// ────────────────────────────────────────────────────────────────────────
// Specific email renderers
// ────────────────────────────────────────────────────────────────────────

export function renderReferralCodeEmail(code: string): { html: string; text: string; subject: string } {
  const shareUrl = `https://percolator.trade/r/${code}`;
  const html = renderEmail({
    preheader: "Percolator · waitlist",
    previewText: "Your referral code is ready.",
    subject: "Your Percolator referral code",
    headline: "Your referral code is ready.",
    intro:
      "You're already on the Percolator waitlist — we just shipped referral codes and here's yours. Share the link below and every signup that lands through it gets attributed to you.",
    contentHtml: [
      renderStatusLine("$", "referral_code_assigned", COLOR.cyan),
      renderCodeBlock(code, shareUrl),
      renderParagraph(
        "Mainnet opens after our external audit clears (targeting Q3 2026). We'll email you here when it does.",
      ),
    ].join("\n"),
    cta: { label: "Visit waitlist", href: "https://percolator.trade/waitlist" },
  });
  const text = renderPlainText({
    preheader: "PERCOLATOR · WAITLIST",
    headline: "Your referral code is ready.",
    body: `You're already on the Percolator waitlist — we just shipped referral codes and here's yours.\n\nCode:  ${code}\nLink:  ${shareUrl}\n\nWhen someone joins through your link, you get attribution. Mainnet opens after our external audit clears (targeting Q3 2026).`,
    cta: { label: "Visit waitlist", href: "https://percolator.trade/waitlist" },
  });
  return { html, text, subject: "Your Percolator referral code" };
}

export function renderWelcomeEmail(opts: {
  position: number | null;
  referralCode: string | null;
  hasWallet: boolean;
}): { html: string; text: string; subject: string } {
  const positionLine = opts.position
    ? `<p style="margin:0 0 18px 0; font-family:${SANS}; font-size:14.5px; line-height:1.6; color:${COLOR.muted};">You're <span style="font-family:${MONO}; color:${COLOR.accent}; font-weight:700;">#${opts.position.toLocaleString()}</span> on the list.</p>`
    : "";

  const referralBlock = opts.referralCode
    ? renderCodeBlock(opts.referralCode, `https://percolator.trade/r/${opts.referralCode}`)
    : "";

  const secondary = opts.hasWallet
    ? renderParagraph(
        "We also created a Solana wallet under your email (Privy embedded). When mainnet opens, the dApp at percolator.trade will recognise that wallet and unlock your priority access automatically — no extra step.",
      )
    : renderParagraph(
        `Have a Solana wallet? <a href="https://percolator.trade/#reserve" style="color:${COLOR.accent}; text-decoration:underline;">Sign up with your wallet too</a> — we send a wallet-native notification on chain when mainnet opens, so you get pinged in Phantom even if you miss this email.`,
      );

  const html = renderEmail({
    preheader: "Percolator · waitlist",
    previewText: "You're on the Percolator waitlist.",
    subject: "You're on the Percolator waitlist",
    headline: "You're on the list.",
    contentHtml: [
      renderStatusLine("$", "waitlist_confirmed", COLOR.cyan),
      positionLine,
      referralBlock,
      renderParagraph(
        "Mainnet opens after our external audit clears (targeting Q3 2026). We'll email you here when it does.",
      ),
      secondary,
    ]
      .filter(Boolean)
      .join("\n"),
  });

  const text = renderPlainText({
    preheader: "PERCOLATOR · WAITLIST",
    headline: "You're on the list.",
    body: `${opts.position ? `You're #${opts.position} on the list.\n\n` : ""}${
      opts.referralCode
        ? `Your referral code: ${opts.referralCode}\nShare your link: https://percolator.trade/r/${opts.referralCode}\n\n`
        : ""
    }Mainnet opens after our external audit clears (targeting Q3 2026). We'll email you here when it does.\n\n${
      opts.hasWallet
        ? "We also created a Solana wallet under your email (Privy embedded)."
        : "Have a Solana wallet? Sign up with your wallet too at https://percolator.trade/#reserve."
    }`,
  });
  return { html, text, subject: "You're on the Percolator waitlist" };
}
