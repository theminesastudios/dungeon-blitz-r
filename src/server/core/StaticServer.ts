import express from 'express';
import * as path from 'path';

export class StaticServer {
    private app: express.Application;
    private port: number;
    private contentDir: string;

    constructor(port: number = 80, relativeContentPath: string = '../../client/content/localhost') {
        this.port = port;
        this.app = express();
        
        // Resolve absolute path
        this.contentDir = path.resolve(__dirname, relativeContentPath);
        
        this.setupRoutes();
    }

    private setupRoutes(): void {
        // Serve static files
        this.app.use(express.static(this.contentDir));
        
        // Basic root handler
        this.app.get('/', (req, res) => {
            res.sendFile(path.join(this.contentDir, 'index.html'));
        });

        // Debug route to check path
        this.app.get('/debug-path', (req, res) => {
            res.send(`Serving content from: ${this.contentDir}`);
        });
    }

    public start(): void {
        this.app.listen(this.port, () => {
            console.log(`[StaticServer] Serving ${this.contentDir} on http://localhost:${this.port}`);
            console.log(`[StaticServer] Flash: http://localhost:${this.port}/p/cbp/DungeonBlitz.swf?fv=cbq&gv=cbp`);
        });
    }
}
