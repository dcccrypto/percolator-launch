import { Connection } from "@solana/web3.js";
import { getConfig } from "./config";

let _connection: Connection | null = null;

export function getConnection(): Connection {
  if (!_connection) {
    _connection = new Connection(getConfig().rpcUrl, "confirmed");
  }
  return _connection;
}
