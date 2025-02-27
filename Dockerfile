FROM node:18-slim

# Install required dependencies
RUN apt-get update && apt-get install -y \
    git \
    diffutils \
    python3 \
    python3-pip \
    jq \
    && apt-get clean \
    && rm -rf /var/lib/apt/lists/*

# Install Node.js dependencies
WORKDIR /app
COPY package.json package-lock.json* ./
RUN npm ci

# Copy action code
COPY src/ ./src/
COPY entrypoint.sh ./
RUN chmod +x entrypoint.sh

ENTRYPOINT ["/app/entrypoint.sh"]
