process.env.MULTIPLAYER_MODE = 'false';
process.env.STATIC_PORT = process.env.STATIC_PORT || '8000';
process.env.ENABLE_POLICY_SERVER = 'false';

require('ts-node/register');
require('../main.ts');
