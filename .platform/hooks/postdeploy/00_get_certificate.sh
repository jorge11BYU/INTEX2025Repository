#!/usr/bin/env bash
# This script automatically requests an SSL certificate from Let's Encrypt using Certbot and reloads Nginx to enable HTTPS.

# .platform/hooks/postdeploy/00_get_certificate.sh
sudo /opt/certbot/bin/certbot -n -d ellarises-site.is404.net --nginx --agree-tos --email spencerjorgensen3.0@gmail.com --reinstall --redirect

# Restart Nginx to load the new configuration
sudo systemctl restart nginx