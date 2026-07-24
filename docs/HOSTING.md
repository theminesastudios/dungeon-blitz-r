# Hosting Dungeon Blitz R

## Production (PM2) deployment — how the live multiplayer server runs

The live multiplayer server runs under **PM2**, not a container. It executes the
**compiled** output: `node src/server/dist/main.js` (via
`src/server/tools/startMultiplayerServer.js`).

> **Critical:** the multiplayer server runs compiled code in `src/server/dist`.
> The dev server runs the TypeScript sources directly, so it always reflects the
> latest edits — but production does **not** until you rebuild. `dist/` is
> git-ignored, so `git pull` never updates it. **Every deploy must run
> `npm run build` after pulling, or production silently keeps serving stale
> code** (fixes appear to "not sync" to the hosted server).

### Deploying an update

Always use the deploy script — it builds *before* touching the running server, so
a failed build leaves the current server serving the old (working) build:

```sh
cd ~/dungeon-blitz-r        # the checked-out repo on the host
./tools/deploy-multiplayer.sh
```

Equivalent manual steps (only if the script is unavailable):

```sh
cd ~/dungeon-blitz-r
git pull --ff-only origin main
npm ci
cd src/server && npm ci && npm run build   # <-- the step that is easy to forget
pm2 restart dungeon-blitz-multiplayer --update-env
pm2 save
```

### Verifying a deploy actually took effect

```sh
# dist should be newer than the newest source file, and the process should have
# just restarted:
stat -c '%y' src/server/dist/main.js
pm2 list
pm2 logs dungeon-blitz-multiplayer --lines 20 --nostream
```

`startMultiplayerServer.js` also prints a loud `[BUILD WARNING]` banner at startup
if `dist/` is older than the sources, so a stale build is visible in `pm2 logs`.

---

# Running dedicated server on Linux (container / podman)

The following podman flow is an alternative for containerized hosts. Note the live
production server described above does **not** use it.


### Prerequisites

Warning: Run everything here within a tmux session if you'd like it to continue running once you log out of ssh

Ensure the following dependencies are installed on your host:

* podman
* tmux
* git
* text editor (e.g. vim)

### Podman Setup

On the machine that will host the dedicated server, execute the following commands individually:

```sh
mkdir -p $HOME/Games/dungeon-blitz-r
git clone https://github.com/minesa-org/dungeon-blitz-r $HOME/Games/dungeon-blitz-r
cd $HOME/Games/dungeon-blitz-r/Container
podman build --no-cache -t dungeon-blitz-r:latest .
```

### Running the Container

Run the container with:

```sh
podman run --replace -it \
  --name dungeon-blitz-r \
  --network=host \
  -v $HOME/Games:/opt/games \
  dungeon-blitz-r:latest
```

Type exit once it gets into a shell.

Start the container by running

```sh
podman start -ai dungeon-blitz-r
```

To start your server, run:
```sh
entrypoint.sh
```
