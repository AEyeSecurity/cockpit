FROM node:24-bookworm-slim AS dependencies
WORKDIR /app
RUN apt-get update && apt-get install -y --no-install-recommends python3 make g++ \
    && rm -rf /var/lib/apt/lists/*
COPY package.json package-lock.json ./
RUN npm ci

FROM dependencies AS build
COPY . .
COPY .env.example .env
RUN npm run build

FROM build AS test
CMD ["npm", "run", "test"]

FROM dependencies AS production-dependencies
RUN npm prune --omit=dev

FROM node:24-bookworm-slim AS terminal
RUN apt-get update && apt-get install -y --no-install-recommends bash openssh-client \
    && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY --from=production-dependencies /app/node_modules ./node_modules
COPY package.json pty-server.js ./
ENV PTY_HOST=0.0.0.0 PTY_CWD=/home/node SHELL=/bin/bash
USER node
EXPOSE 7681
CMD ["node", "pty-server.js"]

FROM nginx:stable-alpine AS web
COPY docker/nginx.conf /etc/nginx/conf.d/default.conf
COPY --from=build /app/dist /usr/share/nginx/html
EXPOSE 80
