const reference = new URLSearchParams(window.location.search).get('id');
let transaction;
try {
  const wallet = JSON.parse(localStorage.getItem('vaultly-demo-wallet-v1'));
  if (reference && Array.isArray(wallet?.activity)) {
    transaction = wallet.activity.find((item) => item.state === 'paid' && item.reference === reference);
  }
} catch (_) { /* Missing or unavailable local storage means there is no local record. */ }
if (transaction) {
  document.getElementById('reference').textContent = transaction.reference;
  document.getElementById('transactionAmount').textContent = `${(transaction.amount / 100).toFixed(2)} USDT`;
  document.getElementById('recipient').textContent = transaction.address || 'Not available';
  document.getElementById('transactionDetails').hidden = false;
  document.getElementById('message').hidden = true;
} else {
  document.getElementById('message').textContent = 'Transaction not found in this browser.';
}
