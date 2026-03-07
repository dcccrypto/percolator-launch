import { Connection } from "@solana/web3.js";
import { getConfig, getWsEndpoint } from "./config";

let _connection: Connection | null = null;

export function getConnection(): Connection {
  if (!_connection) {
    const wsEndpoint = getWsEndpoint();
    _connection = new Connection(getConfig().rpcUrl, {
      commitment: "confirmed",
      ...(wsEndpoint ? { wsEndpoint } : {}),
    });
  }
  return _connection;
}
