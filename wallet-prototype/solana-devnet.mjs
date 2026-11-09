// Experimental building blocks, not connected to Cryply's website.
// A client token and signing shares are sensitive. Never log either.
// Tatum's SDK sends shares to its MPC endpoint; see README before use.
import { WalletChain } from '@tatumio/wallet-sdk';

const RPC = 'https://solana-devnet.gateway.tatum.io/';
const KDF_ITERATIONS = 600000;
const AAD = new TextEncoder().encode('cryply-tatum-signing-share-bundle-v1');
const b58 = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
const encode = bytes => btoa(Array.from(bytes, byte => String.fromCharCode(byte)).join(''));
function decode(text, expectedLength) {
  if (typeof text !== 'string' || text.length > 200000 || !/^[A-Za-z0-9+/]*={0,2}$/.test(text)) throw new Error('Invalid encrypted bundle.');
  let decoded;
  try { decoded = Uint8Array.from(atob(text), c => c.charCodeAt(0)); } catch { throw new Error('Invalid encrypted bundle.'); }
  if (expectedLength && decoded.length !== expectedLength) throw new Error('Invalid encrypted bundle.');
  return decoded;
}
async function keyFor(password, salt) {
  if (typeof password !== 'string' || password.length < 12 || password.length > 1024) throw new Error('Use a passphrase of at least 12 characters.');
  const base = await crypto.subtle.importKey('raw', new TextEncoder().encode(password), 'PBKDF2', false, ['deriveKey']);
  return crypto.subtle.deriveKey({ name: 'PBKDF2', hash: 'SHA-256', salt, iterations: KDF_ITERATIONS }, base, { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
}
function checkShares(shares) {
  for (const curve of ['ED25519', 'SECP256K1']) {
    const part = shares?.[curve];
    if (typeof part?.id !== 'string' || !part.id || part.id.length > 1024 || typeof part.share !== 'string' || !part.share || part.share.length > 50000) throw new Error('Provider returned invalid signing shares.');
  }
}
function checkClientId(id) {
  if (typeof id !== 'string' || !id || id.length > 256) throw new Error('Invalid wallet client identifier.');
}
function addressValid(address) {
  if (typeof address !== 'string' || address.length < 32 || address.length > 44) return false;
  let n = 0n;
  for (const char of address) { const digit = b58.indexOf(char); if (digit < 0) return false; n = n * 58n + BigInt(digit); }
  let count = 0; while (n) { count++; n >>= 8n; }
  return count + address.match(/^1*/)[0].length === 32;
}
function amountValid(amount) {
  if (typeof amount !== 'string' || !/^(?:0|[1-9]\d{0,9})(?:\.\d{1,9})?$/.test(amount)) return false;
  const [whole, fraction = ''] = amount.split('.');
  return BigInt(whole) * 1000000000n + BigInt(fraction.padEnd(9, '0')) > 0n;
}
async function seal(payload, password) {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const key = await keyFor(password, salt);
  const encrypted = await crypto.subtle.encrypt({ name: 'AES-GCM', iv, additionalData: AAD }, key, new TextEncoder().encode(JSON.stringify(payload)));
  return JSON.stringify({ version: 1, kdf: 'PBKDF2-SHA256-600000', cipher: 'AES-256-GCM', salt: encode(salt), iv: encode(iv), data: encode(new Uint8Array(encrypted)) });
}
async function unlock(bundle, password, expectedClientId, purpose = 'tatum-signing-shares-v1') {
  checkClientId(expectedClientId);
  if (typeof bundle !== 'string' || bundle.length > 200000) throw new Error('Invalid encrypted bundle.');
  let data;
  try { data = JSON.parse(bundle); } catch { throw new Error('Invalid encrypted bundle.'); }
  if (data?.version !== 1 || data.kdf !== 'PBKDF2-SHA256-600000' || data.cipher !== 'AES-256-GCM') throw new Error('Invalid encrypted bundle.');
  const salt = decode(data.salt, 16), iv = decode(data.iv, 12), ciphertext = decode(data.data);
  const key = await keyFor(password, salt);
  let content;
  try { content = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(await crypto.subtle.decrypt({ name: 'AES-GCM', iv, additionalData: AAD }, key, ciphertext))); }
  catch { throw new Error('Unable to unlock wallet bundle.'); }
  if (content?.clientId !== expectedClientId || content?.purpose !== purpose) throw new Error('Wallet bundle does not match this client.');
  checkShares(content.shares);
  return content.shares;
}

async function checkedClientDetails(client, clientId) {
  checkClientId(clientId);
  const details = await client.getClientDetails();
  if (details?.id !== clientId) throw new Error('The wallet session does not match this client.');
  return details;
}

// Caller must supply an SDK client authenticated for this clientId. Encryption
// happens in the caller's environment, not on Cryply's server when browser-wired.
export async function createEncryptedSigningBundle({ client, clientId, passphrase }) {
  checkClientId(clientId);
  // Validate passphrase before creating a remote wallet that could be orphaned.
  if (typeof passphrase !== 'string' || passphrase.length < 12 || passphrase.length > 1024) throw new Error('Use a passphrase of at least 12 characters.');
  const details = await checkedClientDetails(client, clientId);
  if (!Array.isArray(details.wallets)) throw new Error('Unable to verify existing wallets.');
  if (details.wallets.length) throw new Error('This client already has a wallet; do not generate a replacement.');
  const shares = await client.generateWallet();
  checkShares(shares);
  const bundle = await seal({ purpose: 'tatum-signing-shares-v1', clientId, shares }, passphrase);
  return bundle;
}

// Call ONLY after the user has independently saved and re-opened the bundle.
export async function confirmSavedSigningBundle({ client, clientId, passphrase, savedBundle }) {
  const shares = await unlock(savedBundle, passphrase, clientId);
  await checkedClientDetails(client, clientId);
  await client.updateSigningSharePairs({ body: { signingSharePairIds: [shares.SECP256K1.id, shares.ED25519.id], status: 'STORED_CLIENT' } });
}

// Backups use Tatum's distinct recovery shares, not the original signing shares.
// The caller must save and re-open this encrypted bundle before confirming it.
export async function createEncryptedRecoveryBundle({ client, clientId, passphrase, savedSigningBundle }) {
  const shares = await unlock(savedSigningBundle, passphrase, clientId);
  await checkedClientDetails(client, clientId);
  const backup = await client.backupWallet({ body: { generateResponse: JSON.stringify(shares) } });
  checkShares(backup);
  return seal({ purpose: 'tatum-recovery-shares-v1', clientId, shares: backup }, passphrase);
}

export async function confirmSavedRecoveryBundle({ client, clientId, passphrase, savedRecoveryBundle }) {
  const shares = await unlock(savedRecoveryBundle, passphrase, clientId, 'tatum-recovery-shares-v1');
  await checkedClientDetails(client, clientId);
  await client.updateBackupSharePairs({ body: { backupSharePairIds: [shares.SECP256K1.id, shares.ED25519.id], status: 'STORED_CLIENT_BACKUP_SHARE' } });
}

// Recover produces new signing shares. Save, re-open and confirm the returned
// bundle before relying on it; retain the original recovery bundle too.
export async function recoverSigningBundle({ client, clientId, passphrase, savedRecoveryBundle }) {
  const backup = await unlock(savedRecoveryBundle, passphrase, clientId, 'tatum-recovery-shares-v1');
  await checkedClientDetails(client, clientId);
  const shares = await client.recoverWallet({ body: { backupResponse: JSON.stringify(backup) } });
  checkShares(shares);
  return seal({ purpose: 'tatum-signing-shares-v1', clientId, shares }, passphrase);
}

// Call only after an explicit customer confirmation. Never auto-retry: a failed
// or timed-out broadcast may already have reached the network.
export async function sendTestSol({ client, clientId, passphrase, savedBundle, to, amount, confirmed }) {
  if (confirmed !== true || !addressValid(to) || !amountValid(amount)) throw new Error('Review a valid devnet address and test SOL amount before confirming.');
  const shares = await unlock(savedBundle, passphrase, clientId);
  await checkedClientDetails(client, clientId);
  let result;
  try { result = await client.sendAssets({ body: { share: shares.ED25519.share, chain: WalletChain.SOLANA_DEVNET, to, token: 'NATIVE', amount, rpcUrl: RPC, sponsorGas: false } }); }
  catch { throw new Error('Broadcast status unknown. Check the network before retrying.'); }
  if (typeof result?.transactionHash !== 'string' || !result.transactionHash) throw new Error('Broadcast status unknown. Check the network before retrying.');
  return { transactionHash: result.transactionHash, network: 'Solana devnet' };
}

// This is a public address for the provider client, not proof of ownership.
export async function getDevnetAddress({ client, clientId }) {
  const details = await checkedClientDetails(client, clientId);
  const address = details.metadata?.namespaces?.solana?.address;
  if (!addressValid(address)) throw new Error('Provider did not return a valid Solana address.');
  return { address, network: 'Solana devnet' };
}
