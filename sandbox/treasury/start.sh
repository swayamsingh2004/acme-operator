#!/bin/sh
# Virtual desktop: Xvfb display, VNC + noVNC for live viewing, the computer driver, and the app (auto-restarting).
export DISPLAY=:0
Xvfb :0 -screen 0 1280x800x24 -nolisten tcp &
sleep 1
xsetroot -solid "#008080" 2>/dev/null || true
x11vnc -display :0 -forever -shared -nopw -quiet -rfbport 5900 &
websockify --web /usr/share/novnc 6080 localhost:5900 >/dev/null 2>&1 &
python3 /opt/treasury/driver.py &
while true; do
  python3 /opt/treasury/app.py
  sleep 0.5
done
