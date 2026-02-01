# Salvium Guardian - Automated 3rd Party for Bounty Escrow
#
# Build:   docker build -t salvium-guardian .
# Run:     docker run -d -p 3012:3012 -v guardian-data:/data -e WALLET_PASSWORD=your_secret salvium-guardian

FROM node:20-slim

WORKDIR /app

# Copy package files
COPY package*.json ./

# Install dependencies
RUN npm install --production

# Copy WASM files
COPY wasm/ ./wasm/

# Copy server and CLI
COPY server.js cli.js ./

# Create data directory
RUN mkdir -p /data

# Environment variables (override at runtime)
ENV PORT=3012
ENV DATA_DIR=/data
ENV NETWORK=mainnet
# WALLET_PASSWORD should be set at runtime, not in Dockerfile

# Expose port
EXPOSE 3012

# Health check
HEALTHCHECK --interval=30s --timeout=10s --start-period=5s --retries=3 \
  CMD node -e "require('http').get('http://localhost:3012/health', (r) => process.exit(r.statusCode === 200 ? 0 : 1))"

# Run server
CMD ["node", "server.js"]
