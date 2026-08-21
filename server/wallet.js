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

let keypair = null;

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

export function loadWallet() {
  if (keypair) return keypair;
  // Hosting-friendly: the secret can live in an env var instead of on disk.
  const envSecret = process.env.WALLET_SECRET;
  if (envSecret) {
    const kp = keypairFromSecret(envSecret);
    if (kp) return (keypair = kp);
    log.warn("wallet", "WALLET_SECRET set but unparseable — falling back to wallet.json");
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
