# Flash Chat ↔ Discord Social SDK Bridge

This folder now contains the native bridge path for Discord Social SDK device-flow integration.

The TypeScript multiplayer server forwards normalized public chat events to a local native executable over `stdin/stdout`, and the native process is responsible for:

- Discord device authorization
- Social SDK client startup
- lobby join/create
- linked channel integration
- forwarding inbound Discord chat back to the game server

Active files:

- `src/server/integrations/DiscordSocialBridge.ts`
- `src/server/discord-social-bridge.config.json`
- `src/server/native_bridge/CMakeLists.txt`
- `src/server/native_bridge/build-macos.sh`
- `src/server/native_bridge/BridgeMain.cpp`
- `src/server/native_bridge/DiscordBridge.cpp`

Optional local files:

- `src/server/native_bridge/discord_social_sdk/`

The Discord Social SDK folder is intentionally not tracked on normal game branches.
Single-player and regular local development do not need to download the SDK payload.
Install it only when you want to build or run the native Discord Social SDK bridge:

```bash
npm run install:discord-social-sdk
```

Use `npm run install:discord-social-sdk -- --force` to replace an existing local copy.

## Architecture

```text
Flash Client
   │ public chat packet 0x2C
   ▼
TypeScript Multiplayer Server
   │
   ├─ relays normal in-game public chat to nearby players
   └─ writes newline-delimited JSON to native bridge stdin
                                    │
                                    ▼
                         Native Discord Social SDK Bridge
                                    │
                                    ▼
                          Discord Lobby / Linked Channel

Reverse path:
Discord lobby / linked channel -> native bridge stdout -> game status line to online players
```

## Current behavior

- Game -> Native bridge:
  public chat is forwarded from `SocialHandler`.
- Native bridge -> Game:
  inbound messages are accepted over stdout and shown as status lines.

The inbound message is still a status line rather than a true world-chat bubble because the Flash client's public chat packet requires an in-world entity id plus message text, and Discord users do not have matching game entities by default.

## Build

1. Install Discord Social SDK files with `npm run install:discord-social-sdk`
2. Build the bridge:

```bash
cd src/server/native_bridge
./build-macos.sh
```

3. Set `DISCORD_SOCIAL_BRIDGE_ENABLED=true` and `DISCORD_SOCIAL_NATIVE_BRIDGE_ENABLED=true`
4. Start the server

By default the server looks for:

- macOS: `src/server/native_bridge/build/discord_social_bridge`
- override with `DISCORD_SOCIAL_BRIDGE_EXECUTABLE`

## Current limitations

- Inbound Discord messages are shown as game status lines, not world-chat bubbles.
- The TypeScript relay only forwards public game chat into the native bridge by default.
- `DISCORD_SOCIAL_CHAT_RELAY_MODE=native` sends public game chat through the native Social SDK lobby path.
- `DISCORD_SOCIAL_CHAT_RELAY_MODE=bot` sends public game chat through Discord's bot REST channel API.
- `DISCORD_SOCIAL_CHAT_RELAY_MODE=both` sends to both paths.
- Native Social SDK lobby/chat support requires `DISCORD_SOCIAL_NATIVE_BRIDGE_ENABLED=true`.
- Linked channel support requires `DISCORD_BOT_TOKEN` and `enableChannelLinking` because Discord's server API must grant `CanLinkLobby`.
- Discord channels can be linked to only one lobby at a time. If Discord returns `50237`, the channel is already linked; set `DISCORD_SOCIAL_LOBBY_SECRET` to the same lobby secret when you need to reuse that lobby, or unlink the old lobby/channel link before retrying.
- The bridge will try to reuse an already linked lobby when it belongs to the same Discord application and the SDK loads it for the authorized user.

## Reverse engineering workflow (optional)

1. Open SWF in JPEXS FFDec.
2. Search ActionScript symbols for chat strings (`chat`, `say`, `sendMessage`, `publicChat`).
3. Identify socket write call chain and packet id constants (often `0x2C` / decimal 44 for public chat variants).
4. Capture traffic from a test server and log payload bytes at receive/send boundaries.
5. Confirm endianness and string encoding (UTF-8/AMF/custom length-prefixed fields).
6. Update `PacketParser` with exact packet schema.
