# HZF & BIN Inspector Studio

Professional Home Inspector Pro (`.hzf` and `.bin`) builder, viewer, and editor.
Directly create, edit, save, and export inspections to `.hzf`, `.bin`, and PDF format without needing HIP desktop software.

---

## Architecture

- **`frontend/`**: Pure static modern Web App (HTML5, CSS3, ES6+ Javascript). Zero build step required. Ready for instant deployment on **Vercel**, Netlify, or Cloudflare Pages.
- **`backend/`**: FastAPI REST API with Home Inspector Pro binary parser and Neon PostgreSQL integration. Ready for containerized deployment on **Render**, Railway, or AWS.

---

## Deploy Backend on Render

1. Go to [Render Dashboard](https://dashboard.render.com/) and click **New +** -> **Web Service**.
2. Connect your Git repository.
3. Configure settings:
   - **Environment**: `Docker`
   - **Root Directory**: `backend` (or leave root with `Dockerfile` at `backend/Dockerfile`)
   - **Docker Context**: `backend`
   - **Docker Command**: default (handled automatically by `Dockerfile`)
4. Add Environment Variables:
   - `DATABASE_URL`: `postgresql://username:password@ep-your-endpoint-pooler.region.aws.neon.tech/neondb?sslmode=require`
   - `CORS_ORIGINS`: `*`
5. Click **Create Web Service**. Render will build and deploy your container. Note your backend URL (e.g., `https://hzf-backend.onrender.com`).

---

## Deploy Frontend on Vercel

1. Go to [Vercel Dashboard](https://vercel.com/) and click **Add New...** -> **Project**.
2. Import your Git repository.
3. Set **Root Directory** to `frontend` (or keep root with included `vercel.json`).
4. Set Environment Variable:
   - In `frontend/config.js`, set `API_BASE_URL` to your Render backend URL:
     ```javascript
     window.ENV = {
       API_BASE_URL: "https://your-render-app.onrender.com"
     };
     ```
   - Alternatively, you can configure it at runtime in the browser console:
     ```javascript
     localStorage.setItem('API_BASE_URL', 'https://your-render-app.onrender.com');
     ```
5. Click **Deploy**.

---

## Local Development

Run the backend and frontend in two separate terminals for clean decoupling:

### Terminal 1: Run Backend API (FastAPI)
```bash
cd backend
python -m venv venv
venv\Scripts\activate      # On Windows
source venv/bin/activate   # On Mac/Linux
pip install -r requirements.txt
python main.py
```
- **API Status**: `http://127.0.0.1:8000`
- **Interactive Swagger Docs**: `http://127.0.0.1:8000/docs`

### Terminal 2: Run Frontend (Vite)
```bash
cd frontend
npm install
npm run dev
```
- **Frontend Studio App**: `http://localhost:5173`
- Communicates with the backend using `API_BASE_URL` defined in `frontend/.env`.

