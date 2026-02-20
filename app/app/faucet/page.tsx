import { redirect } from "next/navigation";

export default function FaucetRedirect() {
  redirect("/devnet-mint");
}
