# Piploy

Piploy registers a git repository plus the Docker commands that run it as a
service, and keeps that service running. It is a background daemon on a single
host — a Raspberry Pi.

## Language

**Bundle**:
The single JavaScript file (`piploy.cjs`) that is the whole of Piploy on the
host. It is what a release publishes, what self-update swaps, and what systemd
executes — there is no accompanying `node_modules` or install tree.
_Avoid_: build output, artifact, distribution, package

**Application**:
A git repository plus the Docker configuration that runs it, registered in
`piploy.json`, which Piploy keeps deployed and running.
_Avoid_: service, project, deployment, app
