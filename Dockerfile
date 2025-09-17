# Use bookworm so we get Python 3.11
FROM node:20-bookworm

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

# Python venv (3.11 on bookworm)
RUN python3 -m venv /opt/ffenv
ENV PATH="/opt/ffenv/bin:${PATH}"

# Modern pip/setuptools/wheel
RUN pip install --upgrade pip setuptools wheel

# ---- FaceFusion (CPU) from GitHub ----
RUN git clone --depth 1 https://github.com/facefusion/facefusion /opt/facefusion \
 && pip install --upgrade pip setuptools wheel \
 && sed -i 's/^numpy==.*/numpy==2.2.6/' /opt/facefusion/requirements.txt \
 && pip install --no-cache-dir -r /opt/facefusion/requirements.txt \
 && rm -rf /root/.cache/pip

# Let Python find the repo
ENV PYTHONPATH="/opt/facefusion:${PYTHONPATH}"

# ✅ Correct, supported defaults for this FaceFusion variant
ENV FACE_SWAP_CMD="python3 /opt/facefusion/facefusion.py" \
    FACE_SWAP_ARGS_BASE="--headless --execution-provider cpu --processors face_swapper face_enhancer --face-swapper-model inswapper_128 --face-enhancer-model codeformer" \
    FACEFUSION_CWD="/opt/facefusion" \
    FACEFUSION_CACHE_DIR=/cache \
    XDG_CACHE_HOME=/cache/xdg \
    HF_HOME=/cache/hf \
    INSIGHTFACE_HOME=/cache/insightface

# App code
COPY . .

# Run the continuous worker loop by default
CMD ["node", "cron/weeklyGenerator.js"]
