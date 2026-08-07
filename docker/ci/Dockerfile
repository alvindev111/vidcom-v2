# Mirrors the Linux leg of .github/workflows/ci.yml so the same gates can run
# locally when hosted-runner quota is exhausted. Ubuntu 24.04 is what
# `ubuntu-latest` resolves to, and its stock python3 is 3.12 — the version the
# workflow pins through setup-python — so the interpreter the VieNeu sidecar
# contract compiles against is the same one CI uses.
FROM ubuntu:24.04

# Kept in step with the workflow's setup-node and setup-bun pins. A drift here
# is a drift in what the gates prove, so change both together.
ARG NODE_VERSION=24.9.0
ARG BUN_VERSION=1.3.14

ENV DEBIAN_FRONTEND=noninteractive

# git is not incidental: `npm run test:agent-kit` regenerates the embedded
# bundle and asserts `git diff --exit-code`, so the container needs to read the
# working tree's history, not just its files.
RUN apt-get update \
 && apt-get install -y --no-install-recommends \
      ca-certificates curl git gnupg unzip xz-utils python3 ffmpeg \
 && rm -rf /var/lib/apt/lists/*

# Google Chrome rather than the `chromium` apt package: on Ubuntu that package
# is a snap stub that cannot run inside a container, and both Puppeteer suites
# skip themselves when no browser is found. The hosted runner ships Chrome and
# therefore runs them, so omitting it here would be a silent hole rather than a
# visible failure.
RUN curl -fsSL https://dl.google.com/linux/linux_signing_key.pub \
      | gpg --dearmor -o /usr/share/keyrings/google-chrome.gpg \
 && echo "deb [arch=amd64 signed-by=/usr/share/keyrings/google-chrome.gpg] https://dl.google.com/linux/chrome/deb/ stable main" \
      > /etc/apt/sources.list.d/google-chrome.list \
 && apt-get update \
 && apt-get install -y --no-install-recommends google-chrome-stable \
 && rm -rf /var/lib/apt/lists/*

# Node from the official tarball, not a distro package, so the version is the
# exact one the workflow pins instead of whatever Ubuntu happens to carry.
RUN curl -fsSL "https://nodejs.org/dist/v${NODE_VERSION}/node-v${NODE_VERSION}-linux-x64.tar.xz" -o /tmp/node.tar.xz \
 && mkdir -p /usr/local/lib/nodejs \
 && tar -xJf /tmp/node.tar.xz -C /usr/local/lib/nodejs \
 && rm /tmp/node.tar.xz

ENV PATH="/usr/local/lib/nodejs/node-v${NODE_VERSION}-linux-x64/bin:/root/.bun/bin:${PATH}"

RUN curl -fsSL https://bun.sh/install | bash -s "bun-v${BUN_VERSION}"

WORKDIR /work

# The runner is read from the bind-mounted checkout rather than baked in, so
# editing a gate does not mean rebuilding the image.
ENTRYPOINT ["bash", "/work/docker/ci/run-gates.sh"]
CMD ["all"]
