process.env.MULTIPLAYER_MODE = process.env.MULTIPLAYER_MODE || 'true';
process.env.STATIC_PORT = process.env.STATIC_PORT || '80';
process.env.DISCORD_BRIDGE_CONFIG = process.env.DISCORD_BRIDGE_CONFIG || 'discord-bridge.config.json';

require('ts-node/register');
require('./discordLocalBridge.ts');
