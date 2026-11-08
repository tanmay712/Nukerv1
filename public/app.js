const $ = (id) => document.getElementById(id);
let csrfToken = '';
let currentUser = null;
const page = ({ '/': 'dashboard', '/dashboard': 'dashboard', '/withdraw': 'withdraw', '/giveaways': 'giveaways', '/buy': 'buy', '/owner': 'owner' })[location.pathname] || 'dashboard';
const pageLabels = { dashboard: 'Dashboard', withdraw: 'Withdraw', giveaways: 'Giveaways', buy: 'Buy crypto', owner: 'Owner panel' };
document.querySelector(`[data-page="${page}"]`).classList.remove('hidden');
document.querySelector(`[data-nav="${page}"]`)?.classList.add('active');
$('pageName').textContent = pageLabels[page];
$('today').textContent = new Intl.DateTimeFormat('en', { month: 'short', day: 'numeric', year: 'numeric' }).format(new Date());
async function jsonRequest(url, options = {}) {
  const response = await fetch(url, { credentials: 'same-origin', ...options });
  const data = await response.json();
  if (!response.ok) throw new Error(data.error || 'Request failed.');
  return data;
}
const post = (url, data) => jsonRequest(url, { method: 'POST', headers: { 'Content-Type': 'application/json', 'x-csrf-token': csrfToken }, body: JSON.stringify(data || {}) });
function showText(container, text) { container.replaceChildren(); const p = document.createElement('p'); p.textContent = text; container.append(p); }
function node(tag, className, text) { const el = document.createElement(tag); if (className) el.className = className; if (text != null) el.textContent = text; return el; }
function row(container, primary, secondary) {
  const div = node('div', 'data-row');
  div.append(node('strong', '', primary || 'Unavailable'), node('span', '', secondary || '')); container.append(div);
}
const dateText = (date) => new Date(date).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });
async function loadOwner() {
  try {
    const data = await jsonRequest('/api/admin');
    $('supportEmail').value = data.supportEmail;
    $('notificationEmail').value = data.notificationEmail;
    $('mailStatus').textContent = data.mailConfigured ? 'SMTP settings are configured. Send a test to verify delivery.' : 'Configure SMTP on the server to enable email delivery.';
    $('testEmail').disabled = !data.mailConfigured;
    $('primeStatus').textContent = data.primeConfigured ? 'API credentials are configured. Portfolio access is read-only.' : 'Add read-only API credentials in your server configuration.';
    $('loadPrime').disabled = !data.primeConfigured;
    $('loadPrimeAssets').disabled = !data.primeAssetsConfigured;
    const list = $('usersList'); list.replaceChildren();
    if (!data.users.length) showText(list, 'No sign-ins yet.');
    data.users.forEach((user) => row(list, user.name, `${user.provider} / ${new Date(user.last_login).toLocaleDateString()}`));
    await loadAdminGiveaways();
  } catch (error) { $('primeStatus').textContent = error.message; }
}
async function loadNotifications() {
  const list = $('notifications');
  try {
    const data = await jsonRequest('/api/notifications'); list.replaceChildren();
    if (!data.notifications.length) return showText(list, 'No notifications yet.');
    data.notifications.forEach((item) => {
      const line = node('div', 'notification-row');
      const detail = node('div'); detail.append(node('strong', '', item.message), node('p', '', dateText(item.created_at))); line.append(detail);
      if (!item.read_at) { const button = node('button', 'button secondary', 'Mark read'); button.addEventListener('click', async () => { button.disabled = true; try { await post(`/api/notifications/${encodeURIComponent(item.id)}/read`); await loadNotifications(); } catch (error) { $('notice').textContent = error.message; button.disabled = false; } }); line.append(button); }
      list.append(line);
    });
  } catch (error) { showText(list, error.message); }
}
function statusText(g) {
  if (g.state === 'cancelled') return 'Cancelled';
  if (g.state === 'drawn') return g.won ? 'Selected as winner - fulfillment pending' : 'Winner selected';
  return g.ends_at <= Date.now() ? 'Entries closed - awaiting draw' : 'Open for entries';
}
function giveawayCard(g, admin) {
  const card = node('article', 'giveaway-card');
  const top = node('div', 'giveaway-top');
  const title = node('div'); title.append(node('div', 'section-kicker', statusText(g).toUpperCase()), node('h3', '', g.title));
  top.append(title, node('strong', 'prize-tag', `${g.prize} LTC`)); card.append(top);
  card.append(node('p', 'giveaway-meta', `Closes ${dateText(g.ends_at)} / ${g.entries} ${g.entries === 1 ? 'entry' : 'entries'}`));
  card.append(node('p', 'giveaway-terms', g.terms));
  card.append(node('p', 'giveaway-disclosure', 'No purchase or deposit required. One entry per account. Prize fulfillment is pending after selection; no transfer is automatic.'));
  const actions = node('div', 'giveaway-actions');
  if (admin) {
    if (g.state === 'drawn') actions.append(node('span', 'giveaway-meta', `Selected: ${g.winner_name || 'Unavailable'} / Payout pending`));
    if (g.state === 'open') {
      const draw = node('button', 'button primary', 'Draw winner'); draw.disabled = g.ends_at > Date.now() || !g.entries;
      draw.addEventListener('click', async () => {
        if (!window.confirm('Draw a random winner? Prize fulfillment will remain pending.')) return;
        draw.disabled = true;
        try { const result = await post(`/api/admin/giveaways/${encodeURIComponent(g.id)}/draw`); $('giveawayFormStatus').textContent = result.emailQueued ? 'Winner selected. Email queued and payout pending.' : 'Winner selected. No verified email was available; dashboard notification created. Payout pending.'; await loadAdminGiveaways(); }
        catch (error) { $('giveawayFormStatus').textContent = error.message; draw.disabled = false; }
      });
      const cancel = node('button', 'button secondary', 'Cancel giveaway');
      cancel.addEventListener('click', async () => {
        if (!window.confirm('Cancel this giveaway? No winner will be selected.')) return;
        cancel.disabled = true;
        try { await post(`/api/admin/giveaways/${encodeURIComponent(g.id)}/cancel`); $('giveawayFormStatus').textContent = 'Giveaway cancelled.'; await loadAdminGiveaways(); } catch (error) { $('giveawayFormStatus').textContent = error.message; cancel.disabled = false; }
      });
      actions.append(draw, cancel);
    }
  } else if (g.state === 'open' && g.ends_at > Date.now()) {
    const enter = node('button', 'button primary', g.entered ? 'Entered' : 'Enter giveaway'); enter.disabled = Boolean(g.entered);
    enter.addEventListener('click', async () => { enter.disabled = true; try { await post(`/api/giveaways/${encodeURIComponent(g.id)}/enter`); await loadGiveaways(); } catch (error) { $('notice').textContent = error.message; enter.disabled = false; } }); actions.append(enter);
  } else if (g.entered) actions.append(node('span', 'giveaway-meta', 'You entered this giveaway.'));
  card.append(actions); return card;
}
async function loadGiveaways() {
  const list = $('giveawayList');
  try {
    const data = await jsonRequest('/api/giveaways'); list.replaceChildren();
    if (!data.giveaways.length) return showText(list, 'No giveaways are available right now.');
    data.giveaways.forEach((g) => list.append(giveawayCard(g, false)));
  } catch (error) { showText(list, error.message); }
}
async function loadAdminGiveaways() {
  const list = $('adminGiveaways');
  try {
    const data = await jsonRequest('/api/admin/giveaways'); list.replaceChildren();
    if (!data.giveaways.length) return showText(list, 'No giveaways created yet.');
    data.giveaways.forEach((g) => list.append(giveawayCard(g, true)));
  } catch (error) { showText(list, error.message); }
}
async function loadSession() {
  try {
    const data = await jsonRequest('/api/session');
    if (!data.user) return;
    currentUser = data.user; csrfToken = data.csrf;
    $('loginPanel').classList.add('hidden'); $('logout').classList.remove('hidden');
    $('greeting').textContent = `Welcome, ${data.user.name}`;
    $('profileName').textContent = data.user.name;
    $('profileProvider').textContent = `Signed in with ${data.user.provider}`;
    $('avatar').textContent = data.user.name.slice(0, 1).toUpperCase();
    $('notice').textContent = data.user.verifiedEmail ? 'Your account is connected. Wallet services are not enabled yet.' : 'No verified email is available from your sign-in provider. Giveaway results will appear in dashboard notifications.';
    if (data.user.owner) { document.querySelectorAll('.owner-only').forEach(el => el.classList.remove('hidden')); $('ownerDenied').classList.add('hidden'); if (page === 'owner') await loadOwner(); }
    if (page === 'dashboard') await loadNotifications();
    if (page === 'giveaways') await loadGiveaways();
  } catch (_) { $('notice').textContent = 'Unable to load account information. Please try again.'; }
}
$('logout').addEventListener('click', async () => { try { await post('/api/logout'); window.location.assign('/dashboard'); } catch (error) { $('notice').textContent = error.message; } });
$('settingsForm').addEventListener('submit', async (event) => {
  event.preventDefault();
  try { await post('/api/admin/settings', { supportEmail: $('supportEmail').value, notificationEmail: $('notificationEmail').value }); $('settingsStatus').textContent = 'Settings saved.'; } catch (error) { $('settingsStatus').textContent = error.message; }
});
$('giveawayForm').addEventListener('submit', async (event) => {
  event.preventDefault();
  try {
    const endsAt = new Date($('giveawayEnd').value);
    if (Number.isNaN(endsAt.getTime())) throw new Error('Enter a valid closing date.');
    await post('/api/admin/giveaways', { title: $('giveawayTitle').value, prize: $('giveawayPrize').value, endsAt: endsAt.toISOString(), terms: $('giveawayTerms').value });
    event.target.reset(); $('giveawayFormStatus').textContent = 'Giveaway published.'; await loadAdminGiveaways();
  } catch (error) { $('giveawayFormStatus').textContent = error.message; }
});
$('testEmail').addEventListener('click', async () => {
  const button = $('testEmail'); button.disabled = true; $('mailTestStatus').textContent = 'Sending test email...';
  try { await post('/api/admin/email/test'); $('mailTestStatus').textContent = 'Test accepted by the mail server. Check your inbox.'; }
  catch (error) { $('mailTestStatus').textContent = error.message; }
  finally { button.disabled = false; }
});
$('loadPrimeAssets').addEventListener('click', async () => {
  const list = $('primeAssetData'); showText(list, 'Loading provider metadata...');
  try {
    const data = await jsonRequest('/api/admin/prime/assets'); list.replaceChildren();
    if (!data.assets.length) return showText(list, 'No requested assets were returned by the provider.');
    data.assets.forEach((asset) => {
      if (!asset.networks.length) return row(list, asset.symbol, 'Network metadata not returned');
      asset.networks.forEach((network) => {
        const statuses = [`Trading: ${network.tradingSupported === null ? 'unknown' : network.tradingSupported ? 'yes' : 'no'}`, `Vault: ${network.vaultSupported === null ? 'unknown' : network.vaultSupported ? 'yes' : 'no'}`, `Prime custody: ${network.custodySupported === null ? 'unknown' : network.custodySupported ? 'yes' : 'no'}`];
        row(list, `${asset.symbol} / ${network.name || network.networkType || 'Network unspecified'}`, statuses.join(' / '));
      });
    });
  } catch (error) { showText(list, error.message); }
});
$('loadPrime').addEventListener('click', async () => {
  const list = $('primeData'); showText(list, 'Loading portfolio...');
  try {
    const data = await jsonRequest('/api/admin/prime'); list.replaceChildren();
    if (!data.balances.length && !data.wallets.length) return showText(list, 'No balances or wallets returned for this portfolio.');
    data.balances.forEach((balance) => row(list, `${balance.symbol || 'Asset'} balance`, String(balance.amount ?? 'Unavailable')));
    data.wallets.forEach((wallet) => row(list, wallet.name || wallet.symbol || 'Wallet', [wallet.type, wallet.primary_address || wallet.id].filter(Boolean).join(' / ')));
    if (data.pagination?.has_next) row(list, 'Additional results', 'Only the first page is shown.');
  } catch (error) { showText(list, error.message); }
});
loadSession();
