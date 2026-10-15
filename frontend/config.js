/**
 * HZF Inspector Studio - Frontend Runtime Configuration
 *
 * Auto-resolves FastAPI backend on port 8000 / 8001 for local development,
 * while allowing cloud endpoints (Render / Vercel) to be configured seamlessly.
 */
window.ENV = window.ENV || {
  API_BASE_URL: (typeof window !== 'undefined' && (window.location.port === "8000" || window.location.port === "8001") ? "" : "http://127.0.0.1:8000")
};
