import { TatumWalletsSdk } from '@tatumio/wallet-sdk';
import { createEncryptedSigningBundle, confirmSavedSigningBundle, createEncryptedRecoveryBundle, confirmSavedRecoveryBundle, recoverSigningBundle, getDevnetAddress, sendTestSol } from './solana-devnet.mjs';

const $ = id => document.getElementById(id);
let csrf = '', clientId = '', client = null, address = '';
const links = new Map();
const info = text => { $('walletInfo').textContent = text; };
const busy = value => ['walletCreate', 'walletBackup', 'walletRecover', 'walletOpen', 'walletSend', 'walletBalance'].forEach(id => { $(id).disabled = value; });
async function request(url, opts = {}) {
  const response = await fetch(url, { credentials:'same-origin', cache:'no-store', ...opts });
  const body = await response.json();
  if (!response.ok) throw new Error('Request failed');
  return body;
}
async function openSession() {
  const session = await request('/api/devnet/wallet/session', { method:'POST', headers:{ 'Content-Type':'application/json', 'x-csrf-token':csrf }, body:'{}' });
  clientId = session.clientId;
  const sdk = new TatumWalletsSdk({ fetch:(url, options) => fetch(url, { ...options, redirect:'error', cache:'no-store', signal:AbortSignal.timeout(30000) }) });
  client = sdk.initClient({ token:session.token });
}
function passphrase() {
  const pass = $('walletPassphrase').value;
  if (pass.length < 12 || pass.length > 1024) throw new Error('Enter your passphrase of at least 12 characters.');
  return pass;
}
async function file(id) {
  const selected = $(id).files?.[0];
  if (!selected || selected.size > 200000) throw new Error('Choose your saved wallet file (maximum 200 KB).');
  return selected.text();
}
function download(id, text, filename, label) {
  const old = links.get(id); if (old) URL.revokeObjectURL(old);
  const url = URL.createObjectURL(new Blob([text], { type:'application/json' })); links.set(id,url);
  const link = document.createElement('a'); link.href = url; link.download = filename; link.textContent = label;
  $(id).replaceChildren(link);
}
function clearOpenWallet() { address = ''; $('walletActions').classList.add('hidden'); $('walletAddress').textContent = ''; $('walletBalanceResult').textContent = ''; $('walletTransferResult').textContent = ''; }
$('walletCreate').addEventListener('click', async () => {
  busy(true); clearOpenWallet();
  try {
    const pass = passphrase();
    if (pass !== $('walletPassphraseConfirm').value) { info('The passphrases do not match.'); return; }
    if (!window.confirm('Create an experimental test wallet? Never use this address for real funds.')) return;
    info('Creating test wallet. Do not close this page...');
    await openSession();
    await request('/api/devnet/wallet/begin', { method:'POST', headers:{ 'Content-Type':'application/json', 'x-csrf-token':csrf }, body:'{}' });
    const bundle = await createEncryptedSigningBundle({ client, clientId, passphrase:pass });
    download('walletSigningDownload', bundle, 'cryply-test-signing.json', 'Save signing file');
    info('Save the signing file, then select it below. Do not close this page until it is saved.');
  } catch (_) { info('Wallet creation could not be confirmed. Do not create another wallet blindly; contact support.'); }
  finally { busy(false); }
});
$('walletBackup').addEventListener('click', async () => {
  busy(true); clearOpenWallet();
  try {
    const pass = passphrase(), signing = await file('walletSigningFile');
    info('Opening signing file and creating recovery file...');
    await openSession();
    await confirmSavedSigningBundle({ client, clientId, passphrase:pass, savedBundle:signing });
    const recovery = await createEncryptedRecoveryBundle({ client, clientId, passphrase:pass, savedSigningBundle:signing });
    download('walletRecoveryDownload', recovery, 'cryply-test-recovery.json', 'Save recovery file');
    info('Save the recovery file separately, then select it below.');
  } catch (_) { info('Could not create the recovery file. Check your passphrase and signing file; contact support if the problem continues.'); }
  finally { busy(false); }
});
$('walletRecover').addEventListener('click', async () => {
  if (!window.confirm('Recover signing shares using the saved recovery file? Do not retry if recovery is interrupted.')) return;
  busy(true); clearOpenWallet();
  try {
    const pass = passphrase(), recovery = await file('walletRecoveryFile');
    info('Recovering signing shares. Do not close this page...');
    await openSession();
    const signing = await recoverSigningBundle({ client, clientId, passphrase:pass, savedRecoveryBundle:recovery });
    download('walletSigningDownload', signing, 'cryply-test-signing-recovered.json', 'Save recovered signing file');
    info('Save the recovered signing file, then select it above and open the wallet.');
  } catch (_) { info('Recovery could not be confirmed. Do not retry blindly; contact support.'); }
  finally { busy(false); }
});
$('walletOpen').addEventListener('click', async () => {
  busy(true); clearOpenWallet();
  try {
    const pass = passphrase(), signing = await file('walletSigningFile'), recovery = await file('walletRecoveryFile');
    info('Checking your saved files...');
    await openSession();
    await confirmSavedSigningBundle({ client, clientId, passphrase:pass, savedBundle:signing });
    await confirmSavedRecoveryBundle({ client, clientId, passphrase:pass, savedRecoveryBundle:recovery });
    const result = await getDevnetAddress({ client, clientId }); address = result.address;
    $('walletAddress').textContent = address; $('walletActions').classList.remove('hidden');
    info('Test wallet open. This address must only receive test SOL.');
  } catch (_) { info('Could not open this wallet. Check both saved files and your passphrase.'); }
  finally { busy(false); }
});
$('walletBalance').addEventListener('click', async () => {
  if (!address) return;
  busy(true);
  try {
    const result = await request('/api/devnet/solana/balance', {method:'POST', headers:{'Content-Type':'application/json','x-csrf-token':csrf}, body:JSON.stringify({address})});
    $('walletBalanceResult').textContent = `${result.balanceSol} test SOL on Solana devnet.`;
  } catch (_) { $('walletBalanceResult').textContent = 'Could not retrieve test balance.'; }
  finally { busy(false); }
});
$('walletSend').addEventListener('click', async () => {
  if (!address) return;
  const to = $('walletTo').value.trim(), amount = $('walletAmount').value.trim();
  if (!window.confirm(`Send ${amount} test SOL on Solana devnet to ${to}? Network fees apply. This cannot be undone.`)) return;
  busy(true);
  try {
    const pass = passphrase(), signing = await file('walletSigningFile');
    await openSession();
    const result = await sendTestSol({ client, clientId, passphrase:pass, savedBundle:signing, to, amount, confirmed:true });
    $('walletTransferResult').textContent = `Submitted to Solana devnet: ${result.transactionHash}. Check network confirmation before retrying.`;
  } catch (_) { $('walletTransferResult').textContent = 'Transfer was not confirmed. It may have been broadcast; check the network before retrying.'; }
  finally { busy(false); }
});
(async () => {
  try {
    const session = await request('/api/session'); if (!session.user || !session.csrf) return;
    csrf = session.csrf;
    const status = await request('/api/devnet/wallet/status');
    if (status.enabled) { $('testWallet').classList.remove('hidden'); info(status.state === 'needs_review' || status.state === 'creating' ? 'Wallet setup needs review. Contact support.' : 'Create a new test wallet, or reopen both saved files to use an existing one.'); }
  } catch (_) { /* The test wallet remains hidden when unavailable. */ }
})();
