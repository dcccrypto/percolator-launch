/**
 * Disposable / throwaway email-domain blocklist.
 *
 * Shared by:
 *   • `app/api/waitlist/signup/route.ts` — rejects the signup at the
 *     door so the row never lands in the table.
 *   • `app/api/admin/waitlist/stats/route.ts` — flags rows that
 *     pre-date the signup-time block (legacy entries) so the operator
 *     can bulk-archive on the next maintenance pass.
 *
 * Both callers used to define this list inline and would drift the
 * moment one updated and the other didn't. One source of truth keeps
 * the admin panel's count consistent with what the signup route would
 * have rejected.
 *
 * Match semantics: the part after the LAST `@` in the lowercased
 * email is checked for exact membership. Subdomains are intentionally
 * NOT matched — a legit forwarder occasionally lives at e.g.
 * `family.mailbox.org`. Operators who want stricter matching can swap
 * `has(domain)` for a `Set.prototype.intersection` check.
 *
 * Maintenance: when adding entries, keep alphabetical-ish grouping and
 * one line per ~4 entries to keep diffs minimal. The numbered count in
 * the JSDoc above the export below is informational — kept loosely
 * accurate but not asserted-in-test.
 */

/**
 * Throwaway-domain list (89 entries), captured from the long-tail of
 * disposable-mail providers commonly used by bot farms. Coverage
 * focuses on the 10minutemail / mailinator / guerrillamail families
 * and their many ccTLD / wildcard mirrors.
 */
export const DISPOSABLE_EMAIL_DOMAINS: ReadonlySet<string> = new Set<string>([
  // Jun-2026 bot-wave: attacker-controlled catch-all domains. Script signups
  // to these (random/sequential local-parts) drove most of the wave;
  // akaikadot.com surfaced Jun 6 (sequential aster1..N).
  "tirtamulya.xyz","wshu.net","minitts.net","mtupu.com","akaikadot.com",
  "mailinator.com","guerrillamail.com","guerrillamail.net","guerrillamail.org",
  "guerrillamailblock.com","sharklasers.com","grr.la","tempmail.com",
  "temp-mail.org","temp-mail.io","tempmailo.com","10minutemail.com",
  "10minutemail.net","yopmail.com","yopmail.net","throwawaymail.com",
  "trashmail.com","trashmail.de","dispostable.com","fakeinbox.com",
  "emailondeck.com","mailnesia.com","getnada.com","nada.email",
  "mintemail.com","mohmal.com","tmail.ws","tmpmail.org","mailpoof.com",
  "emaildrop.io","tempr.email","mailcatch.com","spam4.me","mvrht.com",
  "owlpic.com","spamgourmet.com","maildrop.cc","mailtemporaire.fr",
  "mailtemp.info","my10minutemail.com","mailbox.in.ua","disbox.net",
  "fakemail.net","tempinbox.com","temp-mail.ru","mailto.plus",
  "fexpost.com","fexbox.org","inboxbear.com","linshiyouxiang.net",
  "monemail.fr.nf","incognitomail.com","spambog.com","spambox.us",
  "tafmail.com","tempmail.dev","tempmail.email","tempmail.us.com",
  "tempmail.de","tempmail.plus","minutemail.com","jetable.org",
  "anonbox.net","throwam.com","mailcuk.com","mailsac.com","spambox.org",
  "byom.de","mytemp.email","tempemail.net","mvrht.net","clrmail.com",
  "boximail.com","emltmp.com","mailsink.com","mfsa.ru","kepfree.com",
  "boltbox.com","forexnews.bz","fivemail.de","spamavert.com",
  "rcpt.at","tempemail.com","tempemail.co","instant-mail.de",
  "thraml.com","trash-mail.com","fudgerub.com","mailimate.com",
]);

/**
 * True iff `email`'s domain is in the disposable blocklist.
 *
 * The caller should already have validated the email shape (this
 * helper doesn't re-check). The domain is extracted from after the
 * LAST `@` so display-name-format strings like `"Alice <a@x>"` won't
 * accidentally bypass; the signup route lowercases before validation
 * so this helper assumes lowercase input and does NOT re-lowercase.
 *
 * Returns `false` for malformed input (no `@`, trailing `@`,
 * leading `@`) — the route's email-shape check rejects those first;
 * this helper is purely the disposable-vs-real distinction.
 */
export function isDisposableEmail(email: string): boolean {
  const at = email.lastIndexOf("@");
  if (at <= 0 || at >= email.length - 1) return false;
  const domain = email.slice(at + 1);
  return DISPOSABLE_EMAIL_DOMAINS.has(domain);
}
