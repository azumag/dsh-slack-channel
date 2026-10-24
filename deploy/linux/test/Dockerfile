# A stand-in for Muse's VM: Ubuntu 24.04 x86_64 with systemd, /usr/bin/node without npm beside it,
# and no direct way out — only tinyproxy (uid tinyproxy) may connect out; anyone else's :443 lands on a
# plain-text box (the VM answers TLS on :443 with plain text). See run.sh.
# bubblewrap is DSH's command sandbox here (OrbStack's kernel has no Landlock); the scenario hides it
# for the first check to see that check catches a host with no sandbox.
FROM --platform=linux/amd64 ubuntu:24.04
ARG NODE_VERSION=v24.22.1
RUN apt-get update \
 && DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends \
      systemd systemd-sysv dbus ca-certificates curl git iptables tinyproxy python3 openssl xz-utils bubblewrap \
 && rm -rf /var/lib/apt/lists/*
# node in /usr/bin, npm somewhere else (like /opt/hatch-image/bin/npm on the VM)
RUN curl -fsSL https://nodejs.org/dist/$NODE_VERSION/node-$NODE_VERSION-linux-x64.tar.xz | tar -xJ -C /opt \
 && mv /opt/node-$NODE_VERSION-linux-x64 /opt/hatch-image \
 && cp /opt/hatch-image/bin/node /usr/bin/node
RUN useradd -m -s /bin/bash hatch
COPY plaintext-box.py /usr/local/bin/plaintext-box.py
COPY plaintext-box.service /etc/systemd/system/plaintext-box.service
RUN systemctl enable plaintext-box.service tinyproxy.service \
 && sed -i -e 's/^#\?Allow .*/Allow 127.0.0.1/' -e 's/^Port .*/Port 8888/' /etc/tinyproxy/tinyproxy.conf
STOPSIGNAL SIGRTMIN+3
CMD ["/sbin/init"]
