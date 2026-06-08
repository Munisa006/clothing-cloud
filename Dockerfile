# ---- Build/runtime image for the Node.js portal ----
# A small, single-stage image based on a slim Node runtime. In the report this
# is the container image the CI/CD pipeline builds, pushes, and that the
# auto-scaling group launches across the application subnet. Keeping the image
# lean matters: a smaller image starts faster, which lets new instances absorb
# a traffic spike more quickly.

FROM node:20-slim

# Create app directory
WORKDIR /usr/src/app

# Install dependencies first (better layer caching)
COPY backend/package*.json ./
RUN npm install --omit=dev

# Copy application source
COPY backend/ ./

# The app listens on 3000 inside the container; the load balancer / host maps to it
ENV PORT=3000
EXPOSE 3000

# Run as the unprivileged user that the node image already provides
USER node

# Lightweight container healthcheck mirroring the load balancer's health probe
HEALTHCHECK --interval=15s --timeout=3s --start-period=20s --retries=3 \
  CMD node -e "require('http').get('http://localhost:3000/health',r=>process.exit(r.statusCode===200?0:1)).on('error',()=>process.exit(1))"

CMD ["node", "server.js"]
