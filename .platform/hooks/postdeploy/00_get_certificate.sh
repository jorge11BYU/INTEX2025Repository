#!/usr/bin/env bash
# .platform/hooks/postdeploy/00_get_certificate.sh
sudo certbot -n -d ellarises-site.is404.net --nginx --agree-tos --email spencerjorgensen3.0@gmail.com