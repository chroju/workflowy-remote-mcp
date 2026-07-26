FROM ubuntu:24.04

ARG USERNAME=chroju

RUN apt-get update && apt-get install -y --no-install-recommends \
    zsh sudo ca-certificates \
    && rm -rf /var/lib/apt/lists/*

RUN useradd -m -s /usr/bin/zsh -G sudo "${USERNAME}" \
    && echo "${USERNAME} ALL=(ALL) NOPASSWD:ALL" > "/etc/sudoers.d/${USERNAME}" \
    && chmod 0440 "/etc/sudoers.d/${USERNAME}"

# The common-utils feature from devcontainers/features has a known
# incompatibility with podman (buildah): on layer commit it changes /tmp's
# permissions from 1777 to 0755, after which apt-get in the subsequent
# git/node features cannot write to /tmp and fails. Creating the user and
# configuring zsh directly here, without common-utils, avoids that.
RUN chmod 1777 /tmp
