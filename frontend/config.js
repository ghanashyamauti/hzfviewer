/**
 * HZF Inspector Studio - Frontend Runtime Configuration
 *
 * Dynamically loads and parses all configuration keys directly from the frontend .env file.
 * Zero hardcoded URLs or credentials in code.
 */
(function () {
  'use strict';

  window.ENV = window.ENV || {};

  // 1. Synchronously fetch and parse frontend .env file
  try {
    const xhr = new XMLHttpRequest();
    xhr.open('GET', '.env', false); // Synchronous: ensures variables are loaded before app.js runs
    xhr.send(null);
    if ((xhr.status === 200 || xhr.status === 0) && xhr.responseText) {
      const lines = xhr.responseText.split(/\r?\n/);
      for (const rawLine of lines) {
        const line = rawLine.trim();
        if (!line || line.startsWith('#')) continue;
        const eqIdx = line.indexOf('=');
        if (eqIdx > 0) {
          const key = line.slice(0, eqIdx).trim();
          let val = line.slice(eqIdx + 1).trim();
          if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
            val = val.slice(1, -1);
          }
          if (key) {
            window.ENV[key] = val;
          }
        }
      }
    }
  } catch (err) {
    // Graceful fallback if static server does not serve dotfiles directly
  }

  // 2. Query parameter override (e.g., ?api=https://...)
  if (typeof window !== 'undefined' && window.location && window.location.search) {
    const params = new URLSearchParams(window.location.search);
    if (params.has('api')) {
      window.ENV.API_BASE_URL = params.get('api');
      try { localStorage.setItem('API_BASE_URL', window.ENV.API_BASE_URL); } catch (e) {}
    }
  }

  // 3. Fallback to localStorage if not defined in .env
  try {
    const stored = localStorage.getItem('API_BASE_URL');
    if (stored && !window.ENV.API_BASE_URL) {
      window.ENV.API_BASE_URL = stored;
    }
  } catch (e) {}

  // 4. Default to empty string (same-origin relative paths) if undefined
  if (window.ENV.API_BASE_URL === undefined || window.ENV.API_BASE_URL === null) {
    window.ENV.API_BASE_URL = "";
  }
})();


