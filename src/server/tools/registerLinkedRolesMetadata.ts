import 'dotenv/config';

type MetadataType =
    | 1
    | 2
    | 3
    | 4
    | 5
    | 6
    | 7
    | 8;

interface RoleConnectionMetadataRecord {
    key: string;
    name: string;
    description: string;
    type: MetadataType;
}

interface ApplicationCommandRecord {
    name: string;
    description: string;
    type?: number;
}

const INTEGER_GE = 2;
const BOOLEAN_EQ = 7;

async function main(): Promise<void> {
    const applicationId = String(process.env.DISCORD_APPLICATION_ID ?? process.env.DISCORD_SOCIAL_APP_ID ?? '').trim();
    const botToken = String(process.env.DISCORD_BOT_TOKEN ?? '').trim();

    if (!applicationId) {
        throw new Error('DISCORD_APPLICATION_ID is required.');
    }

    if (!botToken) {
        throw new Error('DISCORD_BOT_TOKEN is required.');
    }

    const metadata: RoleConnectionMetadataRecord[] = [
        {
            key: 'player_level',
            name: 'Level',
            description: 'Minimum Dungeon Blitz level on the linked character',
            type: INTEGER_GE
        },
        {
            key: 'mage',
            name: 'Mage',
            description: 'Linked character class is Mage',
            type: BOOLEAN_EQ
        },
        {
            key: 'rogue',
            name: 'Rogue',
            description: 'Linked character class is Rogue',
            type: BOOLEAN_EQ
        },
        {
            key: 'paladin',
            name: 'Paladin',
            description: 'Linked character class is Paladin',
            type: BOOLEAN_EQ
        },
        {
            key: 'sponsor',
            name: 'Sponsor',
            description: 'Linked account is marked as a sponsor',
            type: BOOLEAN_EQ
        }
    ];

    const metadataResponse = await fetch(
        `https://discord.com/api/v10/applications/${applicationId}/role-connections/metadata`,
        {
            method: 'PUT',
            headers: {
                Authorization: `Bot ${botToken}`,
                'Content-Type': 'application/json'
            },
            body: JSON.stringify(metadata)
        }
    );

    const metadataText = await metadataResponse.text();
    if (!metadataResponse.ok) {
        throw new Error(
            `Discord metadata registration failed: ${metadataResponse.status} ${metadataResponse.statusText}${metadataText ? ` ${metadataText}` : ''}`
        );
    }

    const command: ApplicationCommandRecord = {
        name: 'sync-linked-role',
        description: 'Sync your Dungeon Blitz linked-role metadata'
    };

    const existingCommandsResponse = await fetch(
        `https://discord.com/api/v10/applications/${applicationId}/commands`,
        {
            headers: {
                Authorization: `Bot ${botToken}`
            }
        }
    );

    const existingCommands = await existingCommandsResponse.json().catch(() => []);
    if (!existingCommandsResponse.ok || !Array.isArray(existingCommands)) {
        throw new Error(
            `Discord command lookup failed: ${existingCommandsResponse.status} ${existingCommandsResponse.statusText}`
        );
    }

    const existing = existingCommands.find((entry: any) => String(entry?.name ?? '') === command.name);
    const commandUrl = existing?.id
        ? `https://discord.com/api/v10/applications/${applicationId}/commands/${existing.id}`
        : `https://discord.com/api/v10/applications/${applicationId}/commands`;
    const commandMethod = existing?.id ? 'PATCH' : 'POST';
    const commandResponse = await fetch(commandUrl, {
        method: commandMethod,
        headers: {
            Authorization: `Bot ${botToken}`,
            'Content-Type': 'application/json'
        },
        body: JSON.stringify(command)
    });

    const commandText = await commandResponse.text();
    if (!commandResponse.ok) {
        throw new Error(
            `Discord slash command registration failed: ${commandResponse.status} ${commandResponse.statusText}${commandText ? ` ${commandText}` : ''}`
        );
    }

    console.log('Linked Roles metadata registration complete.');
    console.log(metadataText);
    console.log('Slash command registration complete.');
    console.log(commandText);
}

void main().catch((error) => {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
});
