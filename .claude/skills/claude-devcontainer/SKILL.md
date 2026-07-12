---
description: Generate a devcontainer.json optimized for Claude Code development (dotfiles, credential sharing via bind mounts, SSH agent forwarding)
metadata:
    github-path: claude-devcontainer
    github-ref: refs/heads/main
    github-repo: https://github.com/chroju/skills
    github-tree-sha: 27cc7e1032d4f1cd66f8da0324436967fc066750
name: claude-devcontainer
---
# Claude Devcontainer

Generate a `.devcontainer/devcontainer.json` optimized for Claude Code development.

## Steps

1. Check if `.devcontainer/devcontainer.json` already exists. If so, ask the user whether to overwrite or skip.

2. Gather the following parameters from the user:
   - **Container runtime**: Container runtime command or path (docker / podman / nerdctl / custom path). Default: docker. The runtime must be a Docker-compatible CLI.
   - **Username**: OS username inside the container (used for home directory path and common-utils)
   - **Dotfiles repository**: GitHub repository for dotfiles (e.g., `user/dotfiles`). Optional — skip dotfiles setup if not provided.
   - **Dotfiles install command**: Script to run after cloning the dotfiles repository (default: `install.sh`). Ask only if dotfiles repository is provided. Optional — omit if using the default.
   - **SSH agent forwarding**: Whether to forward the host's SSH agent into the container (default: yes). If yes, also ask:
     - **SSH agent socket path**: Path to the SSH agent socket on the host (suggest the host's `$SSH_AUTH_SOCK` if set, otherwise `/tmp/ssh-agent.sock`)
     - **Note**: On macOS with Podman, Unix domain sockets cannot be directly bind-mounted into containers because the Podman VM's virtual filesystem (virtio-fs) does not support socket files. See the Notes section for the recommended workaround using `podman machine ssh -R`.
   - **Include AWS mount**: Whether to bind-mount `~/.aws` into the container (default: no)
   - **initializeCommand**: A host-side command to run before container creation (e.g., a script that ensures credential files exist). Optional — omit if not needed.
   - **Timezone**: Container timezone (suggest the host's `$TZ` if set, otherwise `UTC`)
   - **postCreateCommand**: A command to run inside the container after creation (e.g., `gh auth setup-git` for git credential helper). Optional — omit if not needed.
   - **Include GPG mount**: Whether to bind-mount `~/.gnupg` into the container for GPG commit signing (default: no)
   - **Forward ports**: Ports to forward from the container to the host (e.g., `3000, 8080`). Optional — omit if not needed.

3. Resolve the latest patch version of each devcontainer feature before generating the file. For each feature in `ghcr.io/devcontainers/features/` and `ghcr.io/anthropics/devcontainer-features/`, query the GitHub Packages API to get the latest tag pinned to the patch level (e.g., `2.5.9` not `2` or `2.5`):
   ```
   gh api /orgs/<org>/packages/container/features%2F<feature-name>/versions --jq '.[0].metadata.container.tags | map(select(test("^[0-9]+\\.[0-9]+\\.[0-9]+$"))) | .[0]'
   ```
   Use the resolved versions in the generated JSON. Never use versions from this template without verifying they still exist.

4. Create `.devcontainer/devcontainer.json` using the template below, substituting parameters and resolved versions. Set `name` to the current repository or directory name.

5. Ask the user which additional devcontainer features are needed for the project (e.g., Node.js, Python, Go, Terraform, AWS CLI). Look up the latest version for each and add them to the `features` section.

6. Create `.devcontainer/.env.devcontainer` as an empty file if it doesn't exist (required by `--env-file` in runArgs).

7. Create `.devcontainer/.gitignore` with the following content if it doesn't exist:
   ```
   .env.devcontainer
   .env.devcontainer.local
   ```

8. Verify the generated configuration by running `devcontainer up --workspace-folder . [--docker-path <runtime>] [--dotfiles-repository <dotfiles-repo>] [--dotfiles-install-command <command>]` (include `--docker-path` only if a non-default runtime was selected; include dotfiles flags only if the user provided them) and confirm the container starts successfully. If it fails, diagnose the error (missing files for bind mounts, invalid feature versions, etc.), fix the generated `devcontainer.json`, and retry. Once verified, stop and remove the container.

## Template

```json
{
  "name": "<project-name>",
  "image": "ubuntu:24.04",
  "features": {
    "ghcr.io/devcontainers/features/common-utils:<latest>": {
      "configureZshAsDefaultShell": true,
      "username": "<username>"
    },
    "ghcr.io/devcontainers/features/git:<latest>": {},
    "ghcr.io/devcontainers/features/github-cli:<latest>": {},
    "ghcr.io/anthropics/devcontainer-features/claude-code:<latest>": {}
  },
  "mounts": [
    "source=${localEnv:HOME}/.claude/projects,target=/home/<username>/.claude/projects,type=bind",
    "source=${localEnv:HOME}/.claude/sessions,target=/home/<username>/.claude/sessions,type=bind",
    "source=${localEnv:HOME}/.claude/.credentials-devcontainer.json,target=/home/<username>/.claude/.credentials.json,type=bind",
    "source=${localEnv:HOME}/.claude/settings.json,target=/home/<username>/.claude/settings.json,type=bind,readonly",
    "source=${localEnv:HOME}/.claude/history.jsonl,target=/home/<username>/.claude/history.jsonl,type=bind",
    "source=${localEnv:HOME}/.claude.devcontainer.json,target=/home/<username>/.claude.json,type=bind"
  ],
  "containerEnv": {
    "TZ": "<timezone>"
  },
  "remoteEnv": {
    "TERM": "xterm-256color",
    "COLORTERM": "truecolor"
  },
  "runArgs": ["--env-file", ".devcontainer/.env.devcontainer", "--security-opt", "label=disable"],
  "init": true,
  "remoteUser": "<username>"
}
```

### Conditional sections

**If initializeCommand is provided**, add:
```json
{
  "initializeCommand": "<command>"
}
```

**If postCreateCommand is provided**, add:
```json
{
  "postCreateCommand": "<command>"
}
```

**If SSH agent forwarding is enabled**, add to `mounts`:
```json
"source=<ssh-agent-socket>,target=/home/<username>/.ssh-agent.sock,type=bind,relabel=shared"
```

**If AWS mount is included**, add to `mounts`:
```json
"source=${localEnv:HOME}/.aws,target=/home/<username>/.aws,type=bind"
```

**If GPG mount is included**, add to `mounts`:
```json
"source=${localEnv:HOME}/.gnupg,target=/home/<username>/.gnupg,type=bind"
```

**If forward ports are provided**, add:
```json
{
  "forwardPorts": [3000, 8080]
}
```

## Prerequisites

- Dev Containers CLI (`devcontainer` command) must be installed on the host.
- A Docker-compatible container runtime (Docker, Podman, nerdctl, etc.) must be installed and accessible from the host.
- Claude Code must be installed on the host (`~/.claude/` directory exists).

## Notes

- When a dotfiles repository is provided, pass it as `--dotfiles-repository <repo>` to `devcontainer up`. The devcontainer runtime clones the repository and runs `install.sh` by default. To use a different script, also pass `--dotfiles-install-command <command>`.
- `initializeCommand` runs on the host before container creation. Typical uses: ensuring bind-mount target files exist, refreshing credentials, or pulling secrets.
- The Claude Code credentials mount expects `~/.claude/.credentials-devcontainer.json` on the host. This is a separate credential file to avoid conflicts with the host's active session.
- The `--security-opt label=disable` run arg is required for Podman and SELinux environments to allow bind mounts. It is harmless on Docker Desktop, so it is included unconditionally.
- **Podman on macOS: SSH agent socket forwarding** — Podman on macOS runs containers inside a Linux VM (Apple Hypervisor / QEMU). Unix domain sockets on the macOS host cannot be bind-mounted through the VM's virtual filesystem, resulting in `statfs: operation not supported`. The workaround is to use SSH remote forwarding to relay the socket into the VM:
  1. In `initializeCommand`, run `podman machine ssh -- -R /tmp/ssh-agent.sock:"$SSH_AUTH_SOCK" -N &` to forward the host's SSH agent socket into the VM at `/tmp/ssh-agent.sock`.
  2. In `mounts`, use `source=/tmp/ssh-agent.sock` (the VM-side path) instead of the macOS host socket path.
  3. Write `SSH_AUTH_SOCK=/home/<username>/.ssh-agent.sock` to `.env.devcontainer` so the container picks it up.
  4. Optionally wait for the socket to appear and set permissions:
     ```bash
     for i in $(seq 1 10); do
         if podman machine ssh -- test -S /tmp/ssh-agent.sock 2>/dev/null; then
             podman machine ssh -- chmod 777 /tmp/ssh-agent.sock
             break
         fi
         sleep 1
     done
     ```
- This skill uses the Dev Containers CLI (`devcontainer` command) directly. For non-default container runtimes, specify the runtime via `--docker-path` at verification time. VS Code extension-specific settings (e.g., `dev.containers.dockerPath`) are outside the scope of this skill.
