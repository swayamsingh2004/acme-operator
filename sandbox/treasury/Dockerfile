FROM debian:bookworm-slim
RUN apt-get update && apt-get install -y --no-install-recommends \
      python3 python3-tk python3-pil xvfb x11vnc novnc websockify xdotool x11-xserver-utils \
      fonts-dejavu-core procps ca-certificates \
    && rm -rf /var/lib/apt/lists/*
COPY app.py driver.py start.sh /opt/treasury/
ENV TREASURY_DB=/data/treasury.db
RUN mkdir -p /data
EXPOSE 6080 6090
CMD ["/opt/treasury/start.sh"]
