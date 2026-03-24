process.env.MULTIPLAYER_MODE = 'false';
process.env.STATIC_PORT = process.env.STATIC_PORT || '8000';
process.env.ENABLE_POLICY_SERVER = 'false';
process.env.DEBUG_PROGRESS = process.env.DEBUG_PROGRESS || 'true';
process.env.DEBUG_PACKETS = process.env.DEBUG_PACKETS || 'true';
process.env.DEBUG_PAYLOAD_PREVIEW_BYTES = process.env.DEBUG_PAYLOAD_PREVIEW_BYTES || '512';

require('ts-node/register');
require('../main.ts');
