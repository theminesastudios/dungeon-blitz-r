# Running dedicated server on Linux

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

### Optional MongoDB wallet authority

Character saves, inventory, gear, missions, pets, and level state remain JSON-backed. MongoDB is used only for high-value wallet fields when explicitly enabled.

Supported wallet fields:

* `gold`
* `mammothIdols`
* `DragonKeys`
* `DragonOre`
* `SilverSigils`
* `RoyalSigils`
* lockbox counts only

Example `.env`:

```sh
MONGODB_URI=mongodb+srv://user:password@example.mongodb.net/?retryWrites=true&w=majority
MONGODB_DB_NAME=dungeon_blitz_r
MONGODB_WALLET_COLLECTION=wallets
ENABLE_MONGO_WALLET=true
```

`MONGODB_DB_NAME` defaults to `dungeon_blitz_r`, and `MONGODB_WALLET_COLLECTION` defaults to `wallets`. `ENABLE_MONGO_WALLET` defaults to true when `MONGODB_URI` is present and false otherwise. If Mongo wallet mode is enabled but the server cannot connect at startup, the game server refuses to start instead of falling back to stale JSON wallet values.

Wallet documents follow the Discord bot database convention of string user identity fields. Each wallet document has a deterministic `_id` of `<gameUserId>:<characterNameKey>`, a string `userId`, and the numeric `gameUserId`. When the game account is linked through `discord_account_links.json`, `userId` and `discordUserId` are the Discord snowflake; otherwise `userId` falls back to the game account id as a string. The wallet collection must not store Discord `accessToken`, `refreshToken`, `scope`, passwords, session secrets, or raw packet data.
