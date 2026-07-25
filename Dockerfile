# Production Dockerfile for Shopify Bosta Cloud Integration Engine
FROM node:20-alpine

# Set working directory
WORKDIR /app

# Copy package manifests and install production dependencies
COPY package*.json ./
RUN npm ci --only=production

# Copy application source code
COPY . .

# Expose server port
EXPOSE 3000

# Set environment defaults
ENV NODE_ENV=production
ENV PORT=3000

# Start server & daily cron background service
CMD ["npm", "start"]
