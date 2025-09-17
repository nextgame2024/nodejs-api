# Use bookworm so we get Python 3.11
FROM node:20-bookworm

# Faster/cleaner pip
ENV PIP_DISABLE_PIP_VERSION_CHECK=1

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
 # Force a NumPy compatible with opencv-python 4.12.0.88 (needs <2.3.0)
 && sed -i 's/^numpy==.*/numpy==2.2.6/' /opt/facefusion/requirements.txt \
 # Install repo requirements
 && pip install --no-cache-dir -r /opt/facefusion/requirements.txt \
 # Try to install the repo as a package (creates 'facefusion' console script if supported)
 && (cd /opt/facefusion && { [ -f setup.py ] || [ -f pyproject.toml ]; } && pip install . || true) \
 && rm -rf /root/.cache/pip

# Make repo importable (just in case)
ENV PYTHONPATH="/opt/facefusion:${PYTHONPATH}"

# Sensible defaults (Render env can override)
ENV FACE_SWAP_CMD="facefusion" \
    FACE_SWAP_ARGS_BASE="--headless --execution-provider cpu --face-selector-mode best --seamless --face-enhancer codeformer --color-transfer strong" \
    FACEFUSION_CWD="/opt/facefusion" \
    FACEFUSION_CACHE_DIR=/cache \
    XDG_CACHE_HOME=/cache/xdg \
    HF_HOME=/cache/hf \
    INSIGHTFACE_HOME=/cache/insightface

# App code
COPY . .

# Run the continuous worker loop by default
CMD ["node", "cron/weeklyGenerator.js"]
