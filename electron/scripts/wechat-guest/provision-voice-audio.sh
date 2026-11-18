#!/bin/bash
# Provision the private audio service for the existing DeskPet WeChat guest.
set -euo pipefail
umask 077

[ "$(hostname -s)" = lima-wechat-test ]
[ "$(uname -s)" = Linux ]
[ "$(dpkg --print-architecture)" = arm64 ]
[ "$(id -u)" != 0 ]
[ -x /opt/wechat/wechat ]
[ -x /usr/bin/pulseaudio ] && [ -x /usr/bin/pactl ]

account=$(id -un)
desktop="deskpet-wechat-desktop@$account.service"
audio="deskpet-wechat-audio@$account.service"
[ "$(systemctl show -p User --value "$desktop")" = "$account" ]

stage=$(mktemp -d)
trap 'rm -rf -- "$stage"' EXIT
cat > "$stage/deskpet-wechat-audio@.service" <<'UNIT'
[Unit]
Description=DeskPet WeChat private virtual microphone
Before=deskpet-wechat-desktop@%i.service

[Service]
Type=notify
User=%i
RuntimeDirectory=deskpet-wechat-audio
RuntimeDirectoryMode=0700
Environment=XDG_RUNTIME_DIR=/run/deskpet-wechat-audio
ExecStart=/usr/bin/pulseaudio --daemonize=no --log-target=stderr --exit-idle-time=-1 --use-pid-file=no --high-priority=no --realtime=no -n -F /etc/deskpet-wechat-audio.pa
Restart=on-failure
RestartSec=2
TimeoutStartSec=10
NoNewPrivileges=yes

[Install]
WantedBy=deskpet-wechat-desktop@%i.service
UNIT
cat > "$stage/deskpet-wechat-audio.pa" <<'PULSE'
.fail
load-module module-native-protocol-unix socket=/run/deskpet-wechat-audio/native auth-cookie-enabled=0
load-module module-null-sink sink_name=deskpet_output sink_properties=device.description=DeskPet_WeChat_Output
load-module module-null-sink sink_name=deskpet_voice channels=1 channel_map=mono sink_properties=device.description=DeskPet_Voice_Loop
load-module module-remap-source master=deskpet_voice.monitor source_name=deskpet_voice_mic channels=1 master_channel_map=mono channel_map=mono source_properties=device.description=DeskPet_Virtual_Microphone
set-default-sink deskpet_output
set-default-source deskpet_voice_mic
PULSE
cat > "$stage/50-deskpet-wechat.conf" <<'CONF'
default-server = unix:/run/deskpet-wechat-audio/native
autospawn = no
CONF

# A separate service preserves the existing validated desktop unit and lifecycle.
sudo -n install -m 0644 "$stage/deskpet-wechat-audio@.service" /etc/systemd/system/
sudo -n install -m 0644 "$stage/deskpet-wechat-audio.pa" /etc/
sudo -n systemctl daemon-reload
sudo -n systemctl enable --now "$audio"

client_dir="$HOME/.config/pulse/client.conf.d"
mkdir -p -- "$client_dir"
if [ ! -e "$client_dir/../client.conf" ]; then
    (set -o noclobber; printf '# PulseAudio client defaults for the dedicated WeChat guest.\n' > "$client_dir/../client.conf")
fi
install -m 0600 "$stage/50-deskpet-wechat.conf" "$client_dir/"
[ "$(pactl get-default-sink)" = deskpet_output ]
[ "$(pactl get-default-source)" = deskpet_voice_mic ]
