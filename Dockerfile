# ---- Base: Node + Python + ffmpeg (CPU) ----
    FROM node:20-bullseye

    # System deps (add git, libgl1, libglib2.0-0 for OpenCV)
    RUN apt-get update \
     && apt-get install -y --no-install-recommends \
        python3 python3-pip python3-venv \
        ffmpeg git ca-certificates \
        libgl1 libglib2.0-0 \
     && rm -rf /var/lib/apt/lists/*
    
    # App dir
    WORKDIR /app
    
    # Install Node deps first (cache-friendly)
    COPY package*.json ./
    RUN npm ci --omit=dev
    
    # Python virtualenv for FaceFusion
    RUN python3 -m venv /opt/ffenv
    ENV PATH="/opt/ffenv/bin:${PATH}"
    
    # Upgrade pip toolchain
    RUN pip install --upgrade pip wheel setuptools
    
    # ---- FaceFusion (CPU) from GitHub ----
    # Use shallow clone to keep image smaller
    RUN git clone --depth 1 https://github.com/facefusion/facefusion /opt/facefusion \
     && pip install -r /opt/facefusion/requirements.txt \
     # make sure CPU runtime is present
     && pip install --upgrade onnxruntime
    
    # Copy the rest of the app
    COPY . .
    
    # Cache dirs for models (mount a disk to /cache in Render if you can)
    ENV FACEFUSION_CACHE_DIR=/cache \
        XDG_CACHE_HOME=/cache/xdg \
        HF_HOME=/cache/hf \
        INSIGHTFACE_HOME=/cache/insightface
    
    # Default command – your worker/cron decides if it runs once or loops
    CMD ["node", "cron/weeklyGenerator.js"]
    