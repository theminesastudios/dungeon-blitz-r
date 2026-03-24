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
- `src/server/native_bridge/discord_social_sdk/`

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

1. Place Discord Social SDK files in `src/server/native_bridge/discord_social_sdk/`
2. Build the bridge:

```bash
cd src/server/native_bridge
./build-macos.sh
```

3. Set `DISCORD_SOCIAL_BRIDGE_ENABLED=true`
4. Start the server

By default the server looks for:

- macOS: `src/server/native_bridge/build/discord_social_bridge`
- override with `DISCORD_SOCIAL_BRIDGE_EXECUTABLE`

## Current limitations

- `DiscordBridge.cpp` still contains placeholder SDK calls until the exact SDK headers/libs are fully wired.
- Device flow currently emits a placeholder code.
- Linked channel join/send logic is scaffolded but not yet backed by real `discordpp` calls.

## Reverse engineering workflow (optional)

1. Open SWF in JPEXS FFDec.
2. Search ActionScript symbols for chat strings (`chat`, `say`, `sendMessage`, `publicChat`).
3. Identify socket write call chain and packet id constants (often `0x2C` / decimal 44 for public chat variants).
4. Capture traffic from a test server and log payload bytes at receive/send boundaries.
5. Confirm endianness and string encoding (UTF-8/AMF/custom length-prefixed fields).
6. Update `PacketParser` with exact packet schema.
