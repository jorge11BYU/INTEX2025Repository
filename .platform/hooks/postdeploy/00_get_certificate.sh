#!/usr/bin/env bash
# .platform/hooks/postdeploy/00_get_certificate.sh

# 1. Run Certbot for the SINGLE domain only.
# We removed 'www' to prevent the "Expand Certificate" conflict that was crashing the script.
# --reinstall tells Certbot: "Even if the cert exists, rewrite the Nginx config to ensure HTTPS is on."
sudo /opt/certbot/bin/certbot -n -d ellarises-site.is404.net --nginx --agree-tos --email spencerjorgensen3.0@gmail.com --reinstall --redirect

# 2. Restart Nginx to load the new configuration
sudo systemctl restart nginx