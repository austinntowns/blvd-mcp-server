FROM node:22

WORKDIR /app

# Copy package files
COPY package*.json ./

# Install dependencies
RUN npm ci --omit=dev || npm ci

# Copy source
COPY . .

# Expose port
EXPOSE 8080

# Start the server with shell to see output
CMD ["/bin/sh", "-c", "echo '[DOCKER] Container starting...' && echo '[DOCKER] Node version:' && node --version && echo '[DOCKER] Running server...' && npx tsx admin-server.ts"]
