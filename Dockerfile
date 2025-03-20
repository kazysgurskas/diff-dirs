FROM node:22.14.0-slim

RUN apt-get update && apt-get install -y \
    git \
    diffutils \
    python3 \
    python3-pip \
    jq \
    && apt-get clean \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY package.json package-lock.json* ./
RUN npm ci

COPY src/ ./src/
COPY entrypoint.sh ./
RUN chmod +x entrypoint.sh

ENTRYPOINT ["/app/entrypoint.sh"]
