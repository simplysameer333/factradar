# factradar-core — FastAPI/LangGraph fact-check engine.
# Needs Tesseract (image/frame OCR) + ffmpeg (video-frame sampling, yt-dlp muxing)
# as SYSTEM packages — pip alone doesn't provide them.
FROM python:3.13-slim

RUN apt-get update && apt-get install -y --no-install-recommends \
        tesseract-ocr \
        ffmpeg \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

COPY . .

# Railway injects $PORT at runtime; fall back to 41820 locally.
ENV PORT=41820
EXPOSE 41820
CMD ["sh", "-c", "uvicorn main:app --host 0.0.0.0 --port ${PORT:-41820}"]
