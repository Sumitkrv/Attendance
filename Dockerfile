FROM python:3.11-slim

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1

RUN apt-get update && apt-get install -y --no-install-recommends \
    build-essential \
    cmake \
    libgl1 \
    libglib2.0-0 \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Copy full context so this Dockerfile works whether Railway build context is repo root
# or backend/ subdirectory.
COPY . .

# Install dependencies from whichever requirements file exists.
RUN set -eux; \
        if [ -f /app/requirements.txt ]; then \
            pip install --no-cache-dir --prefer-binary -r /app/requirements.txt; \
        elif [ -f /app/backend/requirements.txt ]; then \
            pip install --no-cache-dir --prefer-binary -r /app/backend/requirements.txt; \
        else \
            echo "requirements.txt not found in /app or /app/backend"; \
            exit 1; \
        fi

EXPOSE 5001

CMD ["sh", "-c", "if [ -d /app/src ]; then cd /app; exec gunicorn -w 2 -b 0.0.0.0:${PORT:-5001} src.api.app:app; elif [ -d /app/backend/src ]; then cd /app/backend; exec gunicorn -w 2 -b 0.0.0.0:${PORT:-5001} src.api.app:app; else echo 'Could not find src/ directory'; exit 1; fi"]
