# Stage 1: render the page in every language (site/i18n/*.json → site/dist/)
FROM node:22-alpine AS build
WORKDIR /app
COPY site/ site/
RUN node site/build.mjs

# Stage 2: serve the static files
FROM nginxinc/nginx-unprivileged:1.27-alpine
COPY deploy/site/nginx.conf /etc/nginx/conf.d/default.conf
COPY deploy/site/security-headers.conf /etc/nginx/security-headers.conf
COPY --from=build /app/site/dist/ /usr/share/nginx/html/
EXPOSE 8080
