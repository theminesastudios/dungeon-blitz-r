import * as fs from 'fs';
import * as path from 'path';

export class CharacterTemplates {
    private static templates: Record<string, any> = {};

    static load(dataDir: string) {
        const classes = ['Mage', 'Paladin', 'Rogue'];
        
        for (const cls of classes) {
            try {
                // filename example: mage_template.json (lowercase)
                const filename = `${cls.toLowerCase()}_template.json`;
                const filePath = path.join(dataDir, filename);
                
                if (fs.existsSync(filePath)) {
                    const content = fs.readFileSync(filePath, 'utf-8');
                    const data = JSON.parse(content);
                    CharacterTemplates.templates[cls] = data;
                    console.log(`[CharacterTemplates] Loaded template for ${cls}`);
                } else {
                    console.warn(`[CharacterTemplates] Template file not found: ${filename}`);
                }
            } catch (err) {
                console.error(`[CharacterTemplates] Error loading ${cls} template:`, err);
            }
        }
    }

    static get(className: string): any {
        // Return a deep copy to ensure modifications don't affect the base template
        const template = CharacterTemplates.templates[className];
        if (!template) {
            return null;
        }
        return JSON.parse(JSON.stringify(template));
    }
}
