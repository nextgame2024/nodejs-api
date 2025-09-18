# Python 3.11 + Node 20
FROM node:20-bookworm
ENV PIP_DISABLE_PIP_VERSION_CHECK=1

# System deps for FaceFusion / OpenCV / ffmpeg
RUN apt-get update \
 && apt-get install -y --no-install-recommends \
    python3 python3-venv python3-pip \
    ffmpeg git ca-certificates \
    libgl1 libglib2.0-0 \
 && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Node deps (cache-friendly)
COPY package*.json ./
RUN npm ci --omit=dev

# Python venv
RUN python3 -m venv /opt/ffenv
ENV PATH="/opt/ffenv/bin:${PATH}"
RUN pip install --upgrade pip setuptools wheel

# ---- FaceFusion (CPU) ----
RUN git clone --depth 1 https://github.com/facefusion/facefusion /opt/facefusion \
 && pip install --upgrade pip setuptools wheel \
 && sed -i 's/^numpy==.*/numpy==2.2.6/' /opt/facefusion/requirements.txt \
 && pip install --no-cache-dir -r /opt/facefusion/requirements.txt \
 && rm -rf /root/.cache/pip

# Make repo importable
ENV PYTHONPATH="/opt/facefusion:${PYTHONPATH}"

# ---- Low-RAM defaults (override in Render env if needed) ----
ENV FACE_SWAP_CMD="python3 /opt/facefusion/facefusion.py" \
    FACEFUSION_SUBCOMMAND="headless-run" \
    FACEFUSION_CWD="/opt/facefusion" \
    FACEFUSION_PROVIDERS="cpu" \
    FACEFUSION_THREADS="1" \
    FACE_SELECTOR_MODE="one" \
    FACE_SELECTOR_ORDER="best-worst" \
    FACE_SWAPPER_MODEL="inswapper_128" \
    FACEFUSION_ENABLE_ENHANCER="0" \
    FACE_ENHANCER_MODEL="codeformer" \
    FACEFUSION_CACHE_DIR="/cache" \
    XDG_CACHE_HOME="/cache/xdg" \
    HF_HOME="/cache/hf" \
    INSIGHTFACE_HOME="/cache/insightface" \
    OMP_NUM_THREADS="1" MKL_NUM_THREADS="1" OPENBLAS_NUM_THREADS="1" NUMEXPR_NUM_THREADS="1" \
    # Pre-scale harder + chunking to cap memory
    PRESCALE_MAX_WIDTH="720" \
    PRESCALE_FPS="16" \
    CHUNK_SECONDS="3" \
    # Only valid values are 0,4,8,... (0 omits the flag in our code)
    SYSTEM_MEMORY_LIMIT="0"

# App code
COPY . .

# Background worker entry
CMD ["node", "cron/weeklyGenerator.js"]
