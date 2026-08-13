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

**Register**:
Bringing an Application into Piploy's configuration so Piploy starts keeping
it running. An Application exists only once registered; nothing else creates
one.
_Avoid_: Add, install, onboard, provision, deploy

**Poll**:
One pass in which Piploy brings every Application's repository, image, and
container back in line with the configuration. Polling is Piploy's only
trigger for changing declared Application state; Docker may maintain that
declared container between Polls. Nothing pushes work to Piploy.
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
The single installed file that is both the daemon and the command line client.
_Avoid_: Binary, executable, artifact

## Words from outside

Words other people use that name nothing in this model. Never write them in
our own docs, code, or commits — resolve them first.

**Deploy**:
Means one of two things: registering a new Application, or getting a newer
commit of an existing one running. Resolve it against the configuration before
acting — an Application that is absent must be registered; one that is present
is already handled by the next Poll. It never means shipping a new Bundle;
that is self-update.
