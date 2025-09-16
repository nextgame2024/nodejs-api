# Use bookworm so we get Python 3.11
FROM node:20-bookworm

# System deps for FaceFusion/OpenCV + ffmpeg + git
RUN apt-get update \
 && apt-get install -y --no-install-recommends \
    python3 python3-venv python3-pip \
    ffmpeg git ca-certificates \
    libgl1 libglib2.0-0 \
 && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Install Node deps first (cache-friendly)
COPY package*.json ./
RUN npm ci --omit=dev

# Python venv (this will be 3.11 on bookworm)
RUN python3 -m venv /opt/ffenv
ENV PATH="/opt/ffenv/bin:${PATH}"

# Modern pip/setuptools/wheel
RUN pip install --upgrade pip setuptools wheel

# ---- FaceFusion (CPU) from GitHub ----
    RUN git clone --depth 1 https://github.com/facefusion/facefusion /opt/facefusion \
    && pip install --upgrade pip setuptools wheel \
    && pip install "numpy>=2,<2.3.0" \
    && pip install --no-cache-dir -r /opt/facefusion/requirements.txt \
    && pip install --upgrade onnxruntime


# App code
COPY . .

# Cache dirs (mount a Render disk to /cache for persistence)
ENV FACEFUSION_CACHE_DIR=/cache \
    XDG_CACHE_HOME=/cache/xdg \
    HF_HOME=/cache/hf \
    INSIGHTFACE_HOME=/cache/insightface

# Run one cycle by default; your worker loop/env can override
CMD ["node", "cron/weeklyGenerator.js"]
