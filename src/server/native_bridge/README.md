# Flash Chat ↔ Discord Social SDK Bridge (C++)

This folder is an integration blueprint for mirroring Dungeon Blitz-style chat between:

- Flash socket packets handled by your game server
- Discord Social SDK lobby messages (no webhooks, no bots)

## Architecture

```text
Flash Client
   │
   ▼
Server Socket Listener
   │ raw packet bytes
   ▼
PacketParser
   │ ChatMessage { playerId, username, message }
   ▼
ChatHandler ───────────────┐
   │                       │
   │ existing broadcast    │
   ▼                       │
GameBroadcaster            │
                           │
                           ▼
                     DiscordBridge
                           │ Discord Social SDK lobby API
                           ▼
                        Discord Lobby

Reverse path:
Discord Lobby message -> DiscordBridge callback -> ChatHandler::onDiscordChat -> GameBroadcaster -> Flash clients
```

## Mock packet structure

Public chat packet (`0x002C`) in `PacketParser`:

```text
[u16 packetId=0x002C]
[u32 playerId]
[u8 usernameLen][username bytes]
[u16 messageLen][message bytes]
```

Adjust this once packet captures from your actual Flash protocol are decoded.

## Integration sketch

1. Wire socket server's incoming packet bytes into `ChatHandler::onIncomingPacket(...)`.
2. During startup:
   - `DiscordBridge::initialize(config)`
   - `DiscordBridge::joinOrCreateLobby()`
   - `DiscordBridge::setOnDiscordMessage(...)` and route callback to `ChatHandler::onDiscordChat(...)`
3. In your main loop (or dedicated thread), call `DiscordBridge::tick()` to pump SDK events.

## Reverse engineering workflow (optional)

1. Open SWF in JPEXS FFDec.
2. Search ActionScript symbols for chat strings (`chat`, `say`, `sendMessage`, `publicChat`).
3. Identify socket write call chain and packet id constants (often `0x2C` / decimal 44 for public chat variants).
4. Capture traffic from a test server and log payload bytes at receive/send boundaries.
5. Confirm endianness and string encoding (UTF-8/AMF/custom length-prefixed fields).
6. Update `PacketParser` with exact packet schema.
