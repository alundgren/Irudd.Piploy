import { describe, expect, it } from "vitest";

import { validateDockerfileImageReferences } from "../../src/dockerImagePolicy.js";

describe("validateDockerfileImageReferences", () => {
  it.each([
    [
      "short-name Docker Official Image",
      "FROM node:current-slim@sha256:deae974a69e140f44f434ab29cb519fb5f8fe250fd364b8ca446bd0761acdc6a",
    ],
    [
      "normalized docker.io/library reference",
      "FROM docker.io/library/nginx@sha256:5a88c9c45479443d7be2eadc894b4ed0a9801bae03d97a5760ae13b5c2005942",
    ],
    [
      "docker.io short name without explicit library segment",
      "FROM docker.io/nginx@sha256:5a88c9c45479443d7be2eadc894b4ed0a9801bae03d97a5760ae13b5c2005942",
    ],
    [
      "mcr.microsoft.com/dotnet image used as a build stage, referenced by name",
      "FROM mcr.microsoft.com/dotnet/core/sdk:3.1@sha256:150d074697d1cda38a0c2185fe43895d84b5745841e9d15c5adba29604a6e4cb AS build\nCOPY --from=build /out /out",
    ],
    [
      "scratch and a prior stage referenced by name",
      "FROM node@sha256:deae974a69e140f44f434ab29cb519fb5f8fe250fd364b8ca446bd0761acdc6a AS build\nFROM scratch\nCOPY --from=build /out /out",
    ],
    [
      "a prior stage referenced by numeric index",
      "FROM node@sha256:deae974a69e140f44f434ab29cb519fb5f8fe250fd364b8ca446bd0761acdc6a\nFROM scratch\nCOPY --from=0 /out /out",
    ],
    [
      "a platform flag before the image reference",
      "FROM --platform=linux/arm64 node@sha256:deae974a69e140f44f434ab29cb519fb5f8fe250fd364b8ca446bd0761acdc6a",
    ],
  ] as const)("accepts %s", (_description, dockerfile) => {
    expect(() => validateDockerfileImageReferences(dockerfile)).not.toThrow();
  });

  it.each([
    ["a mutable tag with no digest", "FROM nginx:latest"],
    [
      "a third-party Docker Hub namespace",
      "FROM somebody/nginx@sha256:5a88c9c45479443d7be2eadc894b4ed0a9801bae03d97a5760ae13b5c2005942",
    ],
    [
      "another registry entirely",
      "FROM ghcr.io/example/image@sha256:5a88c9c45479443d7be2eadc894b4ed0a9801bae03d97a5760ae13b5c2005942",
    ],
    [
      "an mcr.microsoft.com namespace outside dotnet",
      "FROM mcr.microsoft.com/other/image@sha256:150d074697d1cda38a0c2185fe43895d84b5745841e9d15c5adba29604a6e4cb",
    ],
    [
      "a dynamic, ARG-driven reference",
      "ARG IMAGE=node\nFROM ${IMAGE}@sha256:deae974a69e140f44f434ab29cb519fb5f8fe250fd364b8ca446bd0761acdc6a",
    ],
    [
      "an unpinned external COPY --from",
      "FROM scratch\nCOPY --from=nginx:latest /out /out",
    ],
    [
      "a COPY --from an untrusted external image",
      "FROM scratch\nCOPY --from=mcr.microsoft.com/other/image@sha256:150d074697d1cda38a0c2185fe43895d84b5745841e9d15c5adba29604a6e4cb /out /out",
    ],
  ] as const)("rejects %s", (_description, dockerfile) => {
    expect(() => validateDockerfileImageReferences(dockerfile)).toThrow(
      "Dockerfile",
    );
  });

  it("rejects a FROM instruction with no resolvable reference", () => {
    expect(() => validateDockerfileImageReferences("FROM")).toThrow(
      "Dockerfile FROM instruction has no resolvable image reference",
    );
  });
});
