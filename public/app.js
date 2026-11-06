const $ = (id) => document.getElementById(id);
const modal = $('modal');
const modalContent = $('modalContent');
const banner = $('statusBanner');
const storageKey = 'vaultly-demo-wallet-v1';
let wallet = { balance: 7800, withdrawal: null, activity: [] };
try {
  const saved = JSON.parse(localStorage.getItem(storageKey));
  if (saved && Number.isInteger(saved.balance) && saved.balance >= 0 && saved.balance <= 7800 && Array.isArray(saved.activity)) wallet = saved;
} catch (_) { /* Start with a fresh demo wallet if storage is unavailable. */ }
let interval = null;
let lastFocused = null;

$('today').textContent = new Intl.DateTimeFormat('en', { month: 'short', day: 'numeric', year: 'numeric' }).format(new Date());
const formatAmount = (cents) => (cents / 100).toFixed(2);
function saveWallet() {
  try { localStorage.setItem(storageKey, JSON.stringify(wallet)); } catch (_) { /* The wallet still works for this session. */ }
}
function renderBalance() {
  const amount = formatAmount(wallet.balance);
  $('totalBalance').textContent = `$${amount}`;
  $('assetUsd').textContent = `$${amount}`;
  $('assetUsdt').textContent = `${amount} USDT`;
}
function renderActivity() {
  const list = $('activityList');
  if (!wallet.activity.length) return;
  const latest = wallet.activity[0];
  list.className = 'activity-record';
  list.innerHTML = `<div class="activity-leading"><div class="empty-icon"><svg class="icon"><use href="#arrow-up"/></svg></div><div class="activity-details"><strong>USDT withdrawal</strong><p>Polygon / Simulation</p>${latest.state === 'paid' && latest.address ? '<p class="activity-address" id="activityAddress"></p>' : ''}</div></div><div class="activity-result"><strong>${latest.state === 'paid' ? '-' : ''}${formatAmount(latest.amount)} USDT</strong><span class="result-badge ${latest.state}">${latest.state === 'paid' ? 'Paid' : 'Failed'}</span></div>`;
  if (latest.state === 'paid' && latest.address) $('activityAddress').textContent = `To: ${latest.address}`;
}
function openModal() {
  lastFocused = document.activeElement;
  modal.classList.remove('hidden');
  document.body.style.overflow = 'hidden';
  renderWithdrawal();
  $('closeModal').focus();
}
function closeModal() {
  modal.classList.add('hidden');
  document.body.style.overflow = '';
  lastFocused?.focus();
}
function updateStatus() {
  const withdrawal = wallet.withdrawal;
  if (!withdrawal) return;
  const remaining = Math.max(0, Math.ceil((withdrawal.endsAt - Date.now()) / 1000));
  if (remaining === 0 && withdrawal.state === 'pending') {
    withdrawal.state = withdrawal.outcome;
    if (withdrawal.state === 'paid') wallet.balance = Math.max(0, wallet.balance - withdrawal.amount);
    wallet.activity.unshift({ state: withdrawal.state, amount: withdrawal.amount, address: withdrawal.address });
    wallet.activity = wallet.activity.slice(0, 20);
    saveWallet();
    renderBalance();
    renderActivity();
    clearInterval(interval);
    interval = null;
    if (!modal.classList.contains('hidden')) renderWithdrawal();
  }
  banner.classList.remove('hidden');
  banner.classList.toggle('error', withdrawal.state === 'failed');
  banner.textContent = withdrawal.state === 'pending'
    ? `Withdrawal in progress - ${remaining}s remaining.`
    : withdrawal.state === 'paid'
      ? `Simulation: ${formatAmount(withdrawal.amount)} USDT paid.`
      : 'Simulation: withdrawal failed due to a wrong address.';
  const timer = $('timer');
  if (timer && withdrawal.state === 'pending') timer.textContent = `About ${remaining} seconds remaining`;
}
function renderWithdrawal() {
  const withdrawal = wallet.withdrawal;
  if (withdrawal?.state === 'pending') {
    modalContent.innerHTML = `<div class="progress-view"><div class="progress-icon"><div class="spinner"></div></div><div class="modal-kicker">WITHDRAWAL IN PROGRESS</div><h2 id="modalTitle">Withdrawing...</h2><p>Your withdrawal is being processed. You can close this window while you wait.</p><div class="timer" id="timer"></div></div>`;
    updateStatus();
    return;
  }
  if (withdrawal && withdrawal.state !== 'pending') {
    const paid = withdrawal.state === 'paid';
    modalContent.innerHTML = `<div class="progress-view"><div class="progress-icon ${paid ? '' : 'error-icon'}">${paid ? '<svg class="icon"><use href="#check"/></svg>' : '!'}</div><div class="modal-kicker">SIMULATION COMPLETE</div><h2 id="modalTitle">${paid ? 'Paid' : 'Wrong address'}</h2><p>${paid ? `${formatAmount(withdrawal.amount)} USDT was deducted from your balance.` : 'The withdrawal failed. Your balance remains unchanged.'}</p>${paid && withdrawal.address ? '<div class="recipient-details"><span>Recipient address</span><strong id="paidAddress"></strong></div>' : ''}<button class="button modal-submit" id="tryAgain">New withdrawal</button></div>`;
    if (paid && withdrawal.address) $('paidAddress').textContent = withdrawal.address;
    $('tryAgain').addEventListener('click', () => { wallet.withdrawal = null; saveWallet(); banner.classList.add('hidden'); renderWithdrawal(); });
    return;
  }
  const available = formatAmount(wallet.balance);
  modalContent.innerHTML = `<div class="modal-kicker">MOVE YOUR ASSETS</div><h2 id="modalTitle">Withdraw USDT</h2><p class="modal-intro">Enter the details for your withdrawal.</p><form id="withdrawForm"><label class="field-label" for="address">Recipient address</label><div class="input-wrap"><input id="address" autocomplete="off" placeholder="Enter Polygon wallet address" required></div><label class="field-label">Network</label><div class="network-select"><svg class="icon polygon-icon"><use href="#polygon"/></svg> Polygon</div><label class="field-label" for="amount">Amount <span class="available">Available: ${available} USDT</span></label><div class="input-wrap"><input id="amount" type="number" min="0.01" max="${available}" step="0.01" value="${available}" required><span class="input-suffix">USDT</span></div><fieldset class="outcome-field"><legend class="field-label">Simulation outcome</legend><div class="outcome-options"><label><input type="radio" name="outcome" value="paid"><span>Show paid</span></label><label><input type="radio" name="outcome" value="failed" checked><span>Show failed</span></label></div></fieldset><div class="modal-note"><svg class="icon"><use href="#info"/></svg><span>The selected result appears after one minute.</span></div><button class="button modal-submit" type="submit" ${wallet.balance === 0 ? 'disabled' : ''}>Withdraw USDT <svg class="icon"><use href="#arrow-up"/></svg></button>${wallet.balance === 0 ? '<p class="form-error">No balance available to withdraw.</p>' : ''}</form>`;
  $('withdrawForm').addEventListener('submit', (event) => {
    event.preventDefault();
    const address = $('address').value.trim();
    if (!address) { $('address').focus(); return; }
    const amount = Math.round(Number($('amount').value) * 100);
    if (!Number.isInteger(amount) || amount < 1 || amount > wallet.balance) return;
    const outcome = document.querySelector('input[name="outcome"]:checked').value;
    wallet.withdrawal = { state: 'pending', outcome, amount, address, endsAt: Date.now() + 60000 };
    saveWallet();
    renderWithdrawal();
    interval = setInterval(updateStatus, 250);
  });
}
$('withdrawButton').addEventListener('click', openModal);
$('closeModal').addEventListener('click', closeModal);
modal.addEventListener('click', (event) => { if (event.target === modal) closeModal(); });
document.addEventListener('keydown', (event) => { if (event.key === 'Escape' && !modal.classList.contains('hidden')) closeModal(); });
$('receiveButton').addEventListener('click', () => {
  const toast = $('toast');
  toast.textContent = 'Receiving is unavailable in simulation mode.';
  toast.classList.remove('hidden');
  clearTimeout(window.toastTimer);
  window.toastTimer = setTimeout(() => toast.classList.add('hidden'), 4000);
});
renderBalance();
renderActivity();
if (wallet.withdrawal) {
  updateStatus();
  if (wallet.withdrawal.state === 'pending') interval = setInterval(updateStatus, 250);
}
