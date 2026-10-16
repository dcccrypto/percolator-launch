/**
 * v2.2 QA NB-2: a v2.2 transaction is only ever built from a DEVNET connection.
 *
 * The app has one tx connection (getConfig().rpcUrl, the same-origin /api/rpc proxy, which refuses mainnet routing on a
 * devnet deployment), so this cannot fire in a correct deployment. It is the runtime proof: once per connection the
 * cluster's genesis hash is read and compared with devnet's; anything else refuses BEFORE a blockhash is fetched or a
 * wallet opens. An RPC failure does not block (nothing is proven wrong, and the proxy is the primary guard) and is not
 * cached. Flag off: no-op.
 */
import type { Connection } from "@solana/web3.js";
import { isDevnetV22Enabled } from "./flag";

export const DEVNET_GENESIS_HASH = "EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG";
export const WRONG_CLUSTER_COPY = "This build only sends on Solana devnet, and the connection is on another network. Nothing was sent. Refresh and try again.";

export class WrongClusterError extends Error {
  constructor() {
    super(WRONG_CLUSTER_COPY);
    this.name = "WrongClusterError";
  }
}

const verdicts = new WeakMap<object, Promise<string | null>>();

export async function assertDevnetConnection(connection: Pick<Connection, "getGenesisHash">, v22: boolean = isDevnetV22Enabled()): Promise<void> {
  if (!v22) return;
  let p = verdicts.get(connection);
  if (!p) {
    p = Promise.resolve().then(() => connection.getGenesisHash()).catch(() => null);
    verdicts.set(connection, p);
  }
  const hash = await p;
  if (hash === null) {
    verdicts.delete(connection); // unproven: ask again next time
    return;
  }
  if (hash !== DEVNET_GENESIS_HASH) throw new WrongClusterError();
}
