import fs from "node:fs";
import bs58 from "bs58";
import { Keypair, LAMPORTS_PER_SOL } from "@solana/web3.js";
import { WALLET_FILE } from "./config.js";
import { getConnection } from "./solana.js";
import { log } from "./log.js";

// wallet.json convention shared with bondbot/quant: { publicKey, secretKey: number[] }
//
// THE RULE: the secret never leaves this process. No route returns it, no
// websocket frame carries it, the admin panel only ever sees the pubkey.
//
// TWO SOURCES, and the environment always wins:
//   WALLET_SECRET   — preferred when hosted. The key lives in Railway's variable
//                     store, never touches the volume, and is never typed into a
//                     web page. Managed where it is set, not from the panel.
//   data/wallet.json — written by the admin panel, mode 600.
// The panel refuses to write or delete while WALLET_SECRET is set, rather than
// accepting an edit that the next restart would silently throw away.

let keypair = null;
let announced = false;

/** Parse a secret from any common export shape: base58 (Phantom) or JSON array. */
function keypairFromSecret(raw) {
  const s = String(raw ?? "").trim();
  if (!s) return null;
  try {
    if (s.startsWith("[")) return Keypair.fromSecretKey(Uint8Array.from(JSON.parse(s)));
    return Keypair.fromSecretKey(bs58.decode(s));
  } catch {
    return null;
  }
}

/** Is the key pinned by the environment? Then the panel is read-only for it. */
export function envManaged() {
  return Boolean(String(process.env.WALLET_SECRET ?? "").trim());
}

/** "env" | "file" | "none" — shown in the panel so the operator knows what they
 *  are looking at, and which place to go to change it. */
export function walletSource() {
  if (envManaged() && keypairFromSecret(process.env.WALLET_SECRET)) return "env";
  return fs.existsSync(WALLET_FILE) ? "file" : "none";
}

export function loadWallet() {
  if (keypair) return keypair;
  // Hosting-friendly: the secret can live in an env var instead of on disk.
  const envSecret = process.env.WALLET_SECRET;
  if (envSecret) {
    const kp = keypairFromSecret(envSecret);
    if (kp) {
      keypair = kp;
      if (!announced) {
        announced = true;
        log.ok("wallet", `key loaded from WALLET_SECRET: ${kp.publicKey.toBase58()}`);
      }
      return keypair;
    }
    log.err("wallet", "WALLET_SECRET is set but could not be parsed — falling back to wallet.json");
  }
  try {
    const j = JSON.parse(fs.readFileSync(WALLET_FILE, "utf8"));
    return (keypair = Keypair.fromSecretKey(Uint8Array.from(j.secretKey)));
  } catch {
    return null;
  }
}

/** Admin panel handed us a key. Validate, persist 0600, hot-swap in memory. */
export function setWalletSecret(raw) {
  if (envManaged()) {
    throw new Error(
      "WALLET_SECRET is set in the environment and takes precedence — change it there, not here. " +
        "Saving a key now would be silently ignored on the next restart.",
    );
  }
  const kp = keypairFromSecret(raw);
  if (!kp) throw new Error("could not parse that key (expected base58 or a [1,2,3...] JSON array)");
  fs.writeFileSync(
    WALLET_FILE,
    JSON.stringify(
      { publicKey: kp.publicKey.toBase58(), secretKey: Array.from(kp.secretKey), savedAt: new Date().toISOString() },
      null,
      2,
    ),
    { mode: 0o600 },
  );
  keypair = kp;
  log.ok("wallet", `key installed: ${kp.publicKey.toBase58()}`);
  return kp.publicKey.toBase58();
}

export function clearWallet() {
  if (envManaged()) {
    throw new Error("WALLET_SECRET is set in the environment — remove the variable there to detach the wallet.");
  }
  try {
    fs.rmSync(WALLET_FILE, { force: true });
  } catch {}
  keypair = null;
  log.warn("wallet", "key removed");
}

export function walletPubkey() {
  return loadWallet()?.publicKey ?? null;
}

export async function solBalance() {
  const pk = walletPubkey();
  if (!pk) return 0;
  try {
    return (await getConnection().getBalance(pk, "confirmed")) / LAMPORTS_PER_SOL;
  } catch {
    return 0;
  }
}
