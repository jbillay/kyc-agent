# Stage 1: Build
FROM node:20-alpine AS builder

WORKDIR /app

COPY package*.json ./
RUN npm ci

COPY . .
RUN npm run build

# Stage 2: Serve
FROM nginx:alpine

COPY --from=builder /app/dist /usr/share/nginx/html
COPY nginx.conf /etc/nginx/conf.d/default.conf

# Remove default nginx config (it conflicts with our custom one on port 80)
RUN rm -f /etc/nginx/conf.d/default.conf.bak 2>/dev/null || true

EXPOSE 3000

CMD ["nginx", "-g", "daemon off;"]
