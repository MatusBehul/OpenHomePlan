# Stage 1: render the page in every language (site/i18n/*.json → site/dist/) and the online
# demo of the app (public/ + examples/ + Three.js → site/dist/demo/)
FROM node:22-alpine AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts
COPY site/ site/
COPY public/ public/
COPY examples/ examples/
COPY deploy/site/security-headers.conf deploy/site/security-headers.conf
RUN node site/build.mjs

# Stage 2: serve the static files
FROM nginxinc/nginx-unprivileged:1.27-alpine
COPY deploy/site/nginx.conf /etc/nginx/conf.d/default.conf
COPY deploy/site/security-headers.conf /etc/nginx/security-headers.conf
COPY --from=build /app/site/dist-nginx/demo-headers.conf /etc/nginx/demo-headers.conf
COPY --from=build /app/site/dist/ /usr/share/nginx/html/
EXPOSE 8080
