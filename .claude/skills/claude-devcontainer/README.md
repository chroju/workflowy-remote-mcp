# claude-devcontainer

Claude Code skill to generate a devcontainer.json optimized for Claude Code development.

## Install

```bash
gh skill install chroju/skills claude-devcontainer
```

## Usage

In a Claude Code session:

```
/claude-devcontainer
```

## What it does

Generates a `.devcontainer/devcontainer.json` with:

- Host credentials shared via bind mounts (SSH, AWS, Claude Code sessions/settings)
- Automatic dotfiles setup via your dotfiles repository
- SSH agent forwarding for git commit signing (Podman compatible)
- Project-specific devcontainer features (Node.js, Python, Go, etc.)

## Parameters

The skill will ask you for:

| Parameter | Description | Default |
|-----------|-------------|---------|
| Username | OS username inside the container | — |
| Dotfiles repository | GitHub repo for dotfiles (e.g., `user/dotfiles`) | none (optional) |
| SSH agent forwarding | Forward host SSH agent into container | yes (optional) |
| SSH agent socket path | Host path to SSH agent socket (if forwarding enabled) | host `$SSH_AUTH_SOCK` if set, otherwise `/tmp/ssh-agent.sock` |
| Include AWS mount | Bind-mount `~/.aws` into the container | no |
| Include GPG mount | Bind-mount `~/.gnupg` into the container for GPG signing | no |
| initializeCommand | Host-side command to run before container creation | none (optional) |
| postCreateCommand | Command to run inside the container after creation (e.g., `gh auth setup-git`) | none (optional) |
| Forward ports | Ports to forward from container to host | none (optional) |
| Timezone | Container timezone | host `$TZ` if set, otherwise `UTC` |

## Prerequisites

- [Dev Containers CLI](https://github.com/devcontainers/cli) (`devcontainer` command) or a compatible runtime (VS Code Dev Containers extension, GitHub Codespaces, etc.)
- Claude Code installed on the host (`~/.claude/` directory exists)
- If using `dotfiles.repository` with an `initializeCommand`, ensure the init script is available on the host.
- For Claude Code mounts, `~/.claude/.credentials-devcontainer.json` must exist on the host (separate from the host's active credentials).
