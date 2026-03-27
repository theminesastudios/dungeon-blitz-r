require('dotenv').config({ path: require('path').resolve(__dirname, '..', '.env') });

process.env.MULTIPLAYER_MODE = 'true';
process.env.ENABLE_POLICY_SERVER = 'true';

require('../dist/main.js');
