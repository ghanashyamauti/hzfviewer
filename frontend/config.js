/**
 * HZF Inspector Studio - Frontend Runtime Configuration
 *
 * Auto-resolves FastAPI backend on port 8000 / 8001 for local development,
 * while automatically pointing to the live Render backend when hosted on Vercel/cloud.
 */
const isLocal = typeof window !== 'undefined' && 
  (window.location.hostname === 'localhost' || window.location.hostname === '127.0.0.1');

window.ENV = window.ENV || {
  API_BASE_URL: isLocal 
    ? ((window.location.port === "8000" || window.location.port === "8001") ? "" : "http://127.0.0.1:8000")
    : "https://hzfviewer.onrender.com"
};
