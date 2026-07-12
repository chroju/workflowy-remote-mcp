FROM ubuntu:24.04

ARG USERNAME=chroju

RUN apt-get update && apt-get install -y --no-install-recommends \
    zsh sudo ca-certificates \
    && rm -rf /var/lib/apt/lists/*

RUN useradd -m -s /usr/bin/zsh -G sudo "${USERNAME}" \
    && echo "${USERNAME} ALL=(ALL) NOPASSWD:ALL" > "/etc/sudoers.d/${USERNAME}" \
    && chmod 0440 "/etc/sudoers.d/${USERNAME}"

# devcontainers/features の common-utils feature は、podman(buildah) の
# レイヤーコミット時に /tmp のパーミッションを 1777 から 0755 に変えてしまい、
# 後続の git/node feature の apt-get が /tmp に書き込めず失敗する既知の相性問題がある。
# common-utils を使わずここで直接ユーザー作成・zsh設定を行うことで回避している。
RUN chmod 1777 /tmp
