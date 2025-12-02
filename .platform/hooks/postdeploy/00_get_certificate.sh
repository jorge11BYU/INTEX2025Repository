#!/usr/bin/env bash
# .platform/hooks/postdeploy/00_get_certificate.sh

# The --reinstall flag is CRITICAL here. 
# It tells Certbot: "I don't care if you think the cert is installed. Edit the nginx config again."
sudo certbot -n -d ellarises-site.is404.net --nginx --agree-tos --email spencerjorgensen3.0@gmail.com --reinstall --redirect

# Force Nginx to wake up and read the new config
sudo service nginx reload