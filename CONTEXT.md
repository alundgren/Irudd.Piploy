# Piploy

Piploy keeps a set of applications running on a single Raspberry Pi. It clones
each application's Git repository, builds it into a Docker image, runs it as a
container, and re-checks on a timer that reality still matches the
configuration.

## Language

**Application**:
One Git repository that Piploy turns into exactly one running container. An
Application is never a group of containers — two containers means two
Applications.
_Avoid_: Service, app, stack, deployment

**Poll**:
One pass in which Piploy brings every Application's repository, image, and
container back in line with the configuration. Polling is Piploy's only
trigger; nothing pushes work to it.
_Avoid_: Sync, deploy, tick, reconcile loop

**Application data**:
State an Application writes and expects to outlive its own container. Piploy
never deletes Application data.
_Avoid_: State, storage, persistent data

**Volume**:
A named directory Piploy creates and mounts into an Application's container to
hold that Application's data. A Volume names the data, not a location — Piploy
owns where it lives.
_Avoid_: Mount, bind mount, Docker volume

**Root directory**:
Where Piploy keeps everything it can rebuild from nothing: clones and logs.
Safe to delete.
_Avoid_: Working directory, workspace

**Data directory**:
Where Piploy keeps everything it cannot rebuild: Application data. Distinct
from the root directory precisely because it is never deleted.

**Bundle**:
The single deployed file that is both the daemon and the command line client.
_Avoid_: Binary, executable, artifact
