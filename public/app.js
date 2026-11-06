const $ = (id) => document.getElementById(id);
const modal = $('modal');
const modalContent = $('modalContent');
const banner = $('statusBanner');
let withdrawal = null;
let interval = null;
let lastFocused = null;

$('today').textContent = new Intl.DateTimeFormat('en', { month: 'short', day: 'numeric', year: 'numeric' }).format(new Date());

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
  if (!withdrawal) return;
  const remaining = Math.max(0, Math.ceil((withdrawal.endsAt - Date.now()) / 1000));
  if (remaining === 0 && withdrawal.state === 'pending') {
    withdrawal.state = 'failed';
    clearInterval(interval);
    interval = null;
    renderWithdrawal();
  }
  banner.classList.remove('hidden');
  banner.classList.toggle('error', withdrawal.state === 'failed');
  banner.textContent = withdrawal.state === 'pending'
    ? `Simulated withdrawal in progress · ${remaining}s remaining. No funds are being sent.`
    : 'Simulated withdrawal failed: wrong address. No funds were sent and your balance is unchanged.';
  const timer = $('timer');
  if (timer && withdrawal.state === 'pending') timer.textContent = `About ${remaining} seconds remaining`;
}
function renderWithdrawal() {
  if (withdrawal?.state === 'pending') {
    modalContent.innerHTML = `<div class="progress-view"><div class="progress-icon"><div class="spinner"></div></div><div class="modal-kicker">SIMULATION IN PROGRESS</div><h2 id="modalTitle">Withdrawing...</h2><p>Your demo withdrawal is being simulated. You can close this window while you wait.</p><div class="timer" id="timer"></div></div>`;
    updateStatus();
    return;
  }
  if (withdrawal?.state === 'failed') {
    modalContent.innerHTML = `<div class="progress-view"><div class="progress-icon error-icon">!</div><div class="modal-kicker">SIMULATION COMPLETE</div><h2 id="modalTitle">Wrong address</h2><p>This demo withdrawal failed. No funds were sent, and your balance remains unchanged.</p><button class="button modal-submit" id="tryAgain">Try again</button></div>`;
    $('tryAgain').addEventListener('click', () => { withdrawal = null; banner.classList.add('hidden'); renderWithdrawal(); });
    return;
  }
  modalContent.innerHTML = `<div class="modal-kicker">MOVE YOUR ASSETS</div><h2 id="modalTitle">Withdraw USDT</h2><p class="modal-intro">Enter the details below to simulate a withdrawal from your wallet.</p><form id="withdrawForm"><label class="field-label" for="address">Recipient address</label><div class="input-wrap"><input id="address" autocomplete="off" placeholder="Enter Polygon wallet address" required></div><label class="field-label">Network</label><div class="network-select"><span class="polygon-icon">⬡</span> &nbsp; Polygon</div><label class="field-label" for="amount">Amount <span style="float:right;color:#9ba99d;font-weight:400">Available: 78.00 USDT</span></label><div class="input-wrap"><input id="amount" type="number" min="0.01" max="78" step="0.01" value="78.00" required><span class="input-suffix">USDT</span></div><div class="modal-note"><svg class="icon"><use href="#info"/></svg><span>Demo only. This does not validate an address or send real crypto. The withdrawal will simulate an error after one minute.</span></div><button class="button modal-submit" type="submit">Withdraw USDT <svg class="icon"><use href="#arrow-up"/></svg></button></form>`;
  $('withdrawForm').addEventListener('submit', (event) => {
    event.preventDefault();
    if (!$('address').value.trim()) { $('address').focus(); return; }
    withdrawal = { state: 'pending', endsAt: Date.now() + 60000 };
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
  toast.textContent = 'Demo wallet only — receiving real funds is not supported.';
  toast.classList.remove('hidden');
  clearTimeout(window.toastTimer);
  window.toastTimer = setTimeout(() => toast.classList.add('hidden'), 4000);
});
