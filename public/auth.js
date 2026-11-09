const $ = (id) => document.getElementById(id);
const signup = location.pathname.replace(/\/$/, '') === '/signup';
$('authTitle').textContent = signup ? 'Make yourself at home.' : 'Welcome back.';
$('authSubtitle').textContent = signup ? 'Create your account to get started.' : 'Sign in to pick up where you left off.';
$('switchText').textContent = signup ? 'Already have an account?' : 'New to Cryply?';
$('switchLink').textContent = signup ? 'Log in' : 'Create an account';
$('switchLink').href = signup ? '/signin' : '/signup';
document.title = `${signup ? 'Get started' : 'Log in'} | Cryply`;
if (new URLSearchParams(location.search).has('login')) { $('authError').textContent = 'Sign-in could not be completed. Please try again.'; $('authError').classList.remove('hidden'); }
fetch('/api/session', { credentials: 'same-origin' }).then((response) => { if (!response.ok) throw new Error('Unavailable'); return response.json(); }).then((session) => {
  if (session.user) { $('accountActions').classList.add('hidden'); $('signedIn').classList.remove('hidden'); return; }
  let available = 0;
  for (const provider of ['google', 'discord']) {
    if (!session.providers[provider]) continue;
    const link = $(`${provider}Auth`); link.href = `/auth/${provider}`; link.classList.remove('disabled'); link.removeAttribute('aria-disabled'); available++;
  }
  $('providerStatus').textContent = available ? 'Choose a provider to continue.' : 'Sign-in is not configured yet. Please contact the site owner.';
}).catch(() => { $('providerStatus').textContent = 'Unable to check sign-in availability. Please try again later.'; });
