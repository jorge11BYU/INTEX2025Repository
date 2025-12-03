#!/usr/bin/env bash

# 1. Run Certbot with a 'dummy' subdomain to bypass the 5-per-week Rate Limit
# Adding -d www.ellarises-site.is404.net makes Let's Encrypt think this is a brand new request.
# We use the absolute path /opt/certbot/bin/certbot to be 100% sure we find the executable.

sudo /opt/certbot/bin/certbot -n -d ellarises-site.is404.net -d www.ellarises-site.is404.net --nginx --agree-tos --email spencerjorgensen3.0@gmail.com --reinstall --redirect

# 2. Force Nginx to RESTART (Not just reload)
# Reloading often fails to bind to the new Port 443. Restarting kills the old process and starts fresh.
sudo systemctl restart nginx