# ---- Base: Node + Python + ffmpeg (CPU) ----
    FROM node:20-bullseye

    # System deps
    RUN apt-get update \
     && apt-get install -y --no-install-recommends \
          python3 python3-pip python3-venv \
          ffmpeg \
     && rm -rf /var/lib/apt/lists/*
    
    # App dir
    WORKDIR /app
    
    # Install Node deps first (cache friendly)
    COPY package*.json ./
    RUN npm ci --omit=dev
    
    # Python virtualenv for FaceFusion
    RUN python3 -m venv /opt/ffenv
    ENV PATH="/opt/ffenv/bin:${PATH}"
    
    # FaceFusion (CPU)
    RUN pip install --upgrade pip \
     && pip install facefusion
    
    # Copy the rest of the app
    COPY . .
    
    # Cache dirs for models (we'll mount a persistent disk here in Render)
    ENV FACEFUSION_CACHE_DIR=/cache \
        XDG_CACHE_HOME=/cache/xdg \
        HF_HOME=/cache/hf \
        INSIGHTFACE_HOME=/cache/insightface
    
    # Default command; Render Cron overrides with your command/schedule
    CMD ["node", "cron/weeklyGenerator.js", "--once"]
    