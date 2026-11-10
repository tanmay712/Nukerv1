import { TatumWalletsSdk } from '@tatumio/wallet-sdk';
import { createEncryptedSigningBundle, confirmSavedSigningBundle, createEncryptedRecoveryBundle, confirmSavedRecoveryBundle } from './solana-devnet.mjs';

const $ = (id) => document.getElementById(id);
let csrf = '', clientId = '', client = null, addresses = null;
const downloads = new Map();
const info = (message) => { $('mainnetDepositStatus').textContent = message; };
const controls = ['mainnetWalletCreate', 'mainnetWalletBackup', 'mainnetWalletActivate', 'mainnetRefreshDeposits'];
function setBusy(value) { controls.forEach((id) => { const element = $(id); if (element) element.disabled = value; }); }
async function request(url, options = {}) {
  const response = await fetch(url, { credentials: 'same-origin', cache: 'no-store', ...options });
  const body = await response.json();
  if (!response.ok) throw new Error(body.error || 'Request failed.');
  return body;
}
function csrfPost(url, body = {}) {
  return request(url, { method: 'POST', headers: { 'Content-Type': 'application/json', 'x-csrf-token': csrf }, body: JSON.stringify(body) });
}
async function openSession() {
  const result = await csrfPost('/api/mainnet/solana/wallet/session');
  clientId = result.clientId;
  const sdk = new TatumWalletsSdk({ fetch: (url, options) => fetch(url, { ...options, redirect: 'error', cache: 'no-store', signal: AbortSignal.timeout(30000) }) });
  client = sdk.initClient({ token: result.token });
}
function passphrase() {
  const value = $('mainnetPassphrase').value;
  if (value.length < 12 || value.length > 1024) throw new Error('Use a passphrase with at least 12 characters.');
  return value;
}
async function readFile(id) {
  const file = $(id).files?.[0];
  if (!file || file.size > 200000) throw new Error('Choose the saved encrypted wallet file (maximum 200 KB).');
  return file.text();
}
function offerDownload(id, text, filename) {
  const previous = downloads.get(id); if (previous) URL.revokeObjectURL(previous);
  const url = URL.createObjectURL(new Blob([text], { type: 'application/json' })); downloads.set(id, url);
  const link = document.createElement('a'); link.href = url; link.download = filename; link.textContent = 'Download encrypted file';
  $(id).replaceChildren(link);
}
function validAddresses(value) {
  return value && typeof value.solana === 'string' && /^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(value.solana) &&
    typeof value.litecoin === 'string' && value.litecoin.length >= 26 && value.litecoin.length <= 90 &&
    typeof value.polygon === 'string' && /^0x[0-9a-fA-F]{40}$/.test(value.polygon);
}
function showAddresses(value) {
  addresses = value;
  $('mainnetSolanaAddress').textContent = value.solana;
  $('mainnetLitecoinAddress').textContent = value.litecoin;
  $('mainnetPolygonAddress').textContent = value.polygon;
  $('mainnetAddressPanel').classList.remove('hidden');
}
function showDeposits(rows) {
  const list = $('mainnetDepositHistory');
  if (!rows.length) { list.textContent = 'No matching deposits found yet. Solana records appear at finalized commitment; Litecoin uses 6 confirmations; Polygon USDT uses 128 confirmations.'; return; }
  const heading = document.createElement('h3'); heading.textContent = 'Confirmed deposits';
  const table = document.createElement('div'); table.className = 'mainnet-deposit-list';
  for (const row of rows) {
    const item = document.createElement('article'); item.className = 'mainnet-deposit-row';
    const amount = document.createElement('strong'); amount.textContent = `${row.amount} ${row.asset}`;
    const detail = document.createElement('span'); detail.textContent = `${row.chain} · block ${row.blockHeight ?? '—'} · ${row.blockTime ? new Date(row.blockTime * 1000).toLocaleString() : row.state}`;
    const explorer = row.chain === 'solana' ? `https://explorer.solana.com/tx/${encodeURIComponent(row.txHash)}` : row.chain === 'litecoin' ? `https://litecoinspace.org/tx/${encodeURIComponent(row.txHash)}` : `https://polygonscan.com/tx/${encodeURIComponent(row.txHash)}`;
    const tx = document.createElement('a'); tx.href = explorer; tx.target = '_blank'; tx.rel = 'noopener noreferrer'; tx.textContent = `${row.txHash.slice(0, 12)}…${row.txHash.slice(-8)} · View on explorer`;
    item.append(amount, detail, tx); table.append(item);
  }
  list.replaceChildren(heading, table);
}
async function refreshDeposits() {
  if (!addresses) return;
  $('mainnetRefreshDeposits').disabled = true;
  info('Checking finalized Solana mainnet transactions…');
  try {
    const result = await request('/api/mainnet/solana/deposits');
    showDeposits(result.deposits || []);
    info(result.scanWarnings?.length ? `Some networks could not be scanned: ${result.scanWarnings.join(', ')}. Existing history remains available; retry later.` : 'Scan complete. SOL is finalized, LTC has 6 confirmations, and Polygon USDT has 128 confirmations. No Cryply balance is credited.');
  } catch (error) { info(error.message || 'Could not refresh deposits. Please retry shortly.'); }
  finally { $('mainnetRefreshDeposits').disabled = false; }
}

$('mainnetWalletCreate').addEventListener('click', async () => {
  setBusy(true);
  try {
    const secret = passphrase();
    if (secret !== $('mainnetPassphraseConfirm').value) throw new Error('Passphrases do not match.');
    if (!window.confirm('This creates a separate Solana MAINNET wallet. It can receive real SOL. Never reuse your devnet wallet files. Continue?')) return;
    info('Creating a separate Tatum mainnet wallet. Do not close this page…');
    await openSession();
    await csrfPost('/api/mainnet/solana/wallet/begin');
    const bundle = await createEncryptedSigningBundle({ client, clientId, passphrase: secret });
    offerDownload('mainnetSigningDownload', bundle, 'cryply-solana-mainnet-signing.json');
    info('Download the encrypted signing file, save it safely, then select it below. Do not use the address until both backup files have been reopened and verified.');
  } catch (error) { info(error.message || 'Wallet creation could not be confirmed. Do not retry blindly.'); }
  finally { $('mainnetPassphrase').value = ''; $('mainnetPassphraseConfirm').value = ''; setBusy(false); }
});

$('mainnetWalletBackup').addEventListener('click', async () => {
  setBusy(true);
  try {
    const secret = passphrase(), signing = await readFile('mainnetSigningFile');
    info('Confirming the saved signing file and creating a separate recovery file…');
    await openSession();
    await confirmSavedSigningBundle({ client, clientId, passphrase: secret, savedBundle: signing });
    const recovery = await createEncryptedRecoveryBundle({ client, clientId, passphrase: secret, savedSigningBundle: signing });
    offerDownload('mainnetRecoveryDownload', recovery, 'cryply-solana-mainnet-recovery.json');
    info('Download the recovery file, store it separately from the signing file, then select it below.');
  } catch (error) { info(error.message || 'Could not create the recovery file. Check the selected file and passphrase.'); }
  finally { $('mainnetPassphrase').value = ''; setBusy(false); }
});

$('mainnetWalletActivate').addEventListener('click', async () => {
  setBusy(true);
  try {
    const secret = passphrase(), signing = await readFile('mainnetSigningFile'), recovery = await readFile('mainnetRecoveryFile');
    info('Reopening both encrypted files and verifying the Tatum wallet address…');
    await openSession();
    await confirmSavedSigningBundle({ client, clientId, passphrase: secret, savedBundle: signing });
    await confirmSavedRecoveryBundle({ client, clientId, passphrase: secret, savedRecoveryBundle: recovery });
    const details = await client.getClientDetails();
    const namespace = details?.metadata?.namespaces || {};
    const publicAddresses = {
      solana: namespace.solana?.address,
      litecoin: namespace.bip122?.address || namespace.litecoin?.address,
      polygon: namespace.eip155?.address || namespace.polygon?.address,
    };
    if (details?.id !== clientId || !validAddresses(publicAddresses)) throw new Error('Tatum did not return valid addresses for all three supported networks. Do not activate or deposit.');
    const result = await csrfPost('/api/mainnet/solana/wallet/activate', { addresses: publicAddresses });
    $('mainnetWalletSetup').classList.add('hidden');
    showAddresses(result.addresses);
    info('Addresses active. SOL is recorded at finalized commitment, LTC after 6 confirmations, and Polygon USDT after 128 confirmations. Withdrawals and Cryply balance crediting are not enabled.');
    await refreshDeposits();
  } catch (error) { info(error.message || 'Could not verify both backups and activate the address. Do not retry if the provider status is unclear.'); }
  finally { $('mainnetPassphrase').value = ''; setBusy(false); }
});

$('mainnetRefreshDeposits').addEventListener('click', refreshDeposits);
document.querySelectorAll('[data-copy-address]').forEach((button) => button.addEventListener('click', async () => {
  const value = $(button.dataset.copyAddress)?.textContent || '';
  if (!value) return;
  try { await navigator.clipboard.writeText(value); info('Address copied. Double-check the asset and network before sending.'); }
  catch { info('Copy failed. Select and copy the address manually.'); }
}));

(async () => {
  try {
    const session = await request('/api/session');
    if (!session.user || !session.csrf) return;
    csrf = session.csrf;
    const status = await request('/api/mainnet/solana/deposits/status');
    if (!status.enabled) return;
    $('mainnetDepositCard').classList.remove('hidden');
    if (status.state === 'active' && validAddresses(status.addresses)) {
      $('mainnetWalletSetup').classList.add('hidden');
      showAddresses(status.addresses);
      showDeposits(status.deposits || []);
      info('Deposit addresses active. Refresh to scan the three networks. Keep both wallet files and your passphrase backed up.');
    } else if (status.state === 'needs_review' || status.state === 'creating' || status.generation === 'claimed') {
      info('Wallet setup is incomplete or needs provider review. Do not create another wallet; contact support.');
      $('mainnetWalletCreate').disabled = true;
    } else {
      info('No Solana mainnet receive wallet is active yet. Create one only if you understand the real-funds and recovery risks above.');
    }
  } catch { /* Fail closed: do not show a mainnet deposit address if status is unavailable. */ }
})();
