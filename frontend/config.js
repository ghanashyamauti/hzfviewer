/**
 * HZF Inspector Studio - Frontend Runtime Configuration
 *
 * For local development: Leave API_BASE_URL empty to use relative routes ("/api/...").
 * For Vercel deployment: Set API_BASE_URL to your Render backend URL (e.g. "https://hzf-backend.onrender.com").
 * You can also set it dynamically at runtime in browser console or settings:
 *   localStorage.setItem('API_BASE_URL', 'https://your-render-app.onrender.com');
 */
window.ENV = window.ENV || {
  API_BASE_URL: ""
};
