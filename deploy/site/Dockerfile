# The public page (site/) as a static site on Cloud Run: nginx, unprivileged, port 8080.
FROM nginxinc/nginx-unprivileged:1.27-alpine
COPY deploy/site/nginx.conf /etc/nginx/conf.d/default.conf
COPY deploy/site/security-headers.conf /etc/nginx/security-headers.conf
COPY site/ /usr/share/nginx/html/
EXPOSE 8080
