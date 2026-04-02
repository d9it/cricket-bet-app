// =============================================
//  Shared utilities — included in every page
// =============================================

const API_BASE = '/api';

// ── Token helpers ──────────────────────────
function getToken()  { return localStorage.getItem('cb_token'); }
function getUser()   { return JSON.parse(localStorage.getItem('cb_user') || 'null'); }
function saveAuth(token, user) {
  localStorage.setItem('cb_token', token);
  localStorage.setItem('cb_user', JSON.stringify(user));
}
function clearAuth() {
  localStorage.removeItem('cb_token');
  localStorage.removeItem('cb_user');
}
function requireAuth() {
  if (!getToken()) { window.location.href = '/'; return false; }
  return true;
}
function requireGuest() {
  if (getToken()) { window.location.href = '/dashboard.html'; return false; }
  return true;
}

// ── API fetch wrapper ─────────────────────
async function apiFetch(path, opts = {}) {
  const headers = { 'Content-Type': 'application/json', ...(opts.headers || {}) };
  const token = getToken();
  if (token) headers['Authorization'] = `Bearer ${token}`;
  const res = await fetch(API_BASE + path, { ...opts, headers });
  const data = await res.json();
  if (!res.ok) throw new Error(data.error || 'Request failed');
  return data;
}

// ── Render helpers ────────────────────────
function showAlert(containerId, message, type = 'error') {
  const el = document.getElementById(containerId);
  if (!el) return;
  el.innerHTML = `<div class="alert alert-${type}">${escHtml(message)}</div>`;
  el.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
}
function clearAlert(containerId) {
  const el = document.getElementById(containerId);
  if (el) el.innerHTML = '';
}

function escHtml(str) {
  return String(str).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}

function formatBadge(fmt) {
  return `<span class="badge badge-${fmt}">${fmt.toUpperCase()}</span>`;
}

function formatPoints(n) {
  return Number(n).toLocaleString() + ' pts';
}

function copyToClipboard(text) {
  navigator.clipboard.writeText(text).catch(() => {
    const el = document.createElement('textarea');
    el.value = text; document.body.appendChild(el);
    el.select(); document.execCommand('copy'); document.body.removeChild(el);
  });
}

// ── Navbar ────────────────────────────────
function renderNavbar() {
  const user = getUser();
  const navEl = document.getElementById('navbar');
  if (!navEl) return;

  navEl.innerHTML = `
    <nav class="navbar">
      <div class="container">
        <a href="/dashboard.html" class="navbar-brand">
          <span class="emoji">🏏</span> CricketBet
        </a>
        <div class="navbar-nav">
          ${user ? `
            <span class="nav-user">Hi, <strong>${escHtml(user.username)}</strong></span>
            <span class="nav-wallet" id="nav-wallet">💰 ${formatPoints(user.wallet_balance)}</span>
            <button class="btn btn-outline btn-sm" onclick="logout()">Logout</button>
          ` : ''}
        </div>
      </div>
    </nav>
  `;

  // Refresh wallet from server
  if (user) {
    apiFetch('/auth/me').then(data => {
      const wEl = document.getElementById('nav-wallet');
      if (wEl) wEl.textContent = '💰 ' + formatPoints(data.wallet_balance);
      const stored = getUser();
      if (stored) { stored.wallet_balance = data.wallet_balance; localStorage.setItem('cb_user', JSON.stringify(stored)); }
    }).catch(() => {});
  }
}

function logout() {
  clearAuth();
  window.location.href = '/';
}

// ── Init ──────────────────────────────────
document.addEventListener('DOMContentLoaded', renderNavbar);
