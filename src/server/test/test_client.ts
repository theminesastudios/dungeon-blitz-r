import * as net from 'net';
import { BitBuffer } from '../network/protocol/bitBuffer';
import { BitReader } from '../network/protocol/bitReader';

const client = new net.Socket();
const PORT = 8080;
const HOST = '127.0.0.1';

// Buffer for incoming data
let buffer = Buffer.alloc(0);

client.connect(PORT, HOST, () => {
    console.log('Connected to server!');
    
    // 1. Send Version (0x11)
    // Format: method_9(version_int)
    // Version is likely a small int, e.g. 1
    const bb = new BitBuffer();
    bb.writeMethod9(123); // Random version
    sendPacket(0x11, bb);
});

client.on('data', (data: Buffer) => {
    buffer = Buffer.concat([buffer, data]);
    
    while (buffer.length >= 4) {
        const packetId = buffer.readUInt16BE(0);
        const length = buffer.readUInt16BE(2);
        
        if (buffer.length < 4 + length) break;
        
        const payload = buffer.subarray(4, 4 + length);
        buffer = buffer.subarray(4 + length);
        
        console.log(`Received Packet: 0x${packetId.toString(16)} (len=${length})`);
        handlePacket(packetId, payload);
    }
});

client.on('close', () => {
    console.log('Connection closed');
});

function sendPacket(id: number, bb: BitBuffer) {
    const payload = bb.toBuffer();
    const header = Buffer.alloc(4);
    header.writeUInt16BE(id, 0);
    header.writeUInt16BE(payload.length, 2);
    client.write(Buffer.concat([header, payload]));
    console.log(`Sent Packet: 0x${id.toString(16)}`);
}

function handlePacket(id: number, data: Buffer) {
    if (id === 0x12) {
        // Challenge
        // Structure: len(utf) + utf_string
        const len = data.readUInt16BE(0);
        const challenge = data.toString('utf-8', 2, 2 + len);
        console.log(`Received Challenge: ${challenge}`);
        
        // 2. Send Create Account (0x13)
        // Format: fbId, kongId, email, pass, legacyKey all strings (method_26)
        const bb = new BitBuffer();
        bb.writeMethod26("fb123");
        bb.writeMethod26("kong123");
        bb.writeMethod26("test@example.com");
        bb.writeMethod26("password123"); // Password
        bb.writeMethod26(""); // Legacy Key
        
        sendPacket(0x13, bb);
    } else if (id === 0x15) {
        // Character List
        const br = new BitReader(data);
        const userId = br.readMethod4();
        const maxChars = br.readMethod393();
        const charCount = br.readMethod393();
        
        console.log(`User ID: ${userId}, Max Chars: ${maxChars}, Char Count: ${charCount}`);
        
        for (let i = 0; i < charCount; i++) {
            const name = br.readMethod13();
            const cls = br.readMethod13();
            const level = br.readMethod6(6);
            console.log(`Char ${i}: ${name} (${cls}) Lvl ${level}`);
            
            // Auto-select first char
            if (i === 0) {
                console.log(`Selecting character: ${name}`);
                const bb = new BitBuffer();
                bb.writeMethod26(name);
                sendPacket(0x16, bb);
            }
        }
        
        if (charCount === 0) {
            console.log("No characters found. Creating one...");
            const bb = new BitBuffer();
            bb.writeMethod26("NeoHero"); // name
            bb.writeMethod26("paladin"); // class
            bb.writeMethod26("male"); // gender
            bb.writeMethod26("head1"); // head
            bb.writeMethod26("hair1"); // hair
            bb.writeMethod26("mouth1"); // mouth
            bb.writeMethod26("face1"); // face
            bb.writeMethod20(0, 24); // hairColor (24 bits)
            // Wait, writeMethod20 logic?
            // Test client needs to emulate sending method_20(24).
            // My test client helper usually wraps bitbuffer.
            // bb.writeMethod20 is generic? No, I need check test_client's BitBuffer copy or import.
            // test_client imports BitBuffer from ../network/protocol/bitBuffer.
            // BitBuffer.writeMethod20(value, bits).
            bb.writeMethod20(0, 24);
            bb.writeMethod20(0, 24);
            bb.writeMethod20(0, 24);
            bb.writeMethod20(0, 24);
            
            sendPacket(0x17, bb);
        }
    } else if (id === 0x21) {
        // Enter World / Transfer
        // Strict bit reading needed here matching WorldEnter.ts
        const br = new BitReader(data);
        const token = br.readMethod4();
        const oldLevelId = br.readMethod4();
        const oldSwf = br.readMethod13();
        const hasOldCoord = br.readMethod20(1) === 1;
        if (hasOldCoord) { br.readMethod4(); br.readMethod4(); }
        
        console.log(`Received Enter World (0x21): Token=${token}`);
        
        // Simulate "switching" (or just sending 0x1f on same socket for test)
        console.log(`Sending Game Server Login (0x1f)...`);
        const bb = new BitBuffer();
        bb.writeMethod9(token);
        bb.writeMethod26("test.swf");
        bb.writeMethod15(false); // first login
        bb.writeMethod15(false); // is dev
        sendPacket(0x1f, bb);
        
    } else if (id === 0x10) {
        console.log("Received Player Data (0x10)! Success!");
        client.end();
        process.exit(0);
    }
}
