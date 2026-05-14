import { redirect } from "next/navigation";
import { isValidReferralCodeShape } from "@/lib/waitlist/referralCode";

/**
 * Share-link landing: /r/<CODE>
 *
 * The signup confirmation email and the success card both render share
 * URLs of the form `percolator.trade/r/AB23XYZ9`. This route forwards
 * those landings to the waitlist page with the code pre-filled in the
 * referrer input.
 *
 * We do NOT consult the database here to confirm the code exists — that
 * would turn the route into a public oracle for "is code X a real signup".
 * The server-side validation on POST /api/waitlist/signup is the
 * authoritative existence check, and it only runs against an actual
 * signup attempt (i.e. when someone proves intent by signing or by
 * confirming a Privy OTP).
 *
 * Shape filter only: if the path segment isn't a plausibly-real code,
 * drop the parameter and forward to the bare waitlist page.
 */
export default async function ReferralLandingPage({
  params,
}: {
  params: Promise<{ code: string }>;
}) {
  const { code: raw } = await params;
  const normalized = (raw ?? "").trim().toUpperCase();
  if (isValidReferralCodeShape(normalized)) {
    redirect(`/waitlist?referrer=${normalized}#reserve`);
  }
  redirect("/waitlist#reserve");
}
