# Multi-stage build for gcli2api
FROM python:3.13-slim as base

ARG BUILD_DATE=unknown
ARG VERSION=unknown
ARG REVISION=unknown

# Set environment variables
ENV PYTHONUNBUFFERED=1 \
    PYTHONDONTWRITEBYTECODE=1 \
    PIP_NO_CACHE_DIR=1 \
    PIP_DISABLE_PIP_VERSION_CHECK=1 \
    GCLI2API_BUILD_DATE=${BUILD_DATE} \
    GCLI2API_VERSION=${VERSION} \
    GCLI2API_REVISION=${REVISION} \
    TZ=Asia/Shanghai

# Install tzdata and set timezone
RUN apt-get update && \
    apt-get install -y --no-install-recommends tzdata && \
    ln -sf /usr/share/zoneinfo/Asia/Shanghai /etc/localtime && \
    echo "Asia/Shanghai" > /etc/timezone && \
    apt-get clean && \
    rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Copy only requirements first for better caching
COPY requirements.txt .

# Install Python dependencies
RUN pip install --no-cache-dir -r requirements.txt

# Copy application code
COPY . .

# Expose port
EXPOSE 7861

# Default command
CMD ["python", "web.py"]
