# HZF & BIN Inspector Studio - Production Backend Dockerfile
FROM python:3.12-slim

# Set working directory
WORKDIR /app

# Install system dependencies for PostgreSQL and packaging
RUN apt-get update && apt-get install -y --no-install-recommends \
    build-essential \
    libpq-dev \
    curl \
    && rm -rf /var/lib/apt/lists/*

# Copy requirements and install python packages
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

# Copy all backend source files
COPY . .

# Ensure saved reports storage directory exists
RUN mkdir -p saved_reports

# Expose default port
EXPOSE 8000

# Start Uvicorn binding to 0.0.0.0 with Render's dynamic PORT
CMD ["sh", "-c", "exec uvicorn main:app --host 0.0.0.0 --port ${PORT:-8000}"]
