import chokidar from 'chokidar';
import fs from 'fs';
import path from 'path';
import Conf from 'conf';
import { EventEmitter } from 'events';
import { sanitize } from '../utils/sanitizer.js';
import crypto from 'crypto';

class LogWatcher extends EventEmitter {
    constructor(filePath) {
        super();
        this.filePath = filePath;
        this.config = new Conf({ projectName: 'ai-memory-cli' });
        this.watcher = null;
        this.processing = false;
        this.debounceTimer = null;

        // Cache for deduplication
        this.processedHashes = new Set();
    }

    async start() {
        if (!fs.existsSync(this.filePath)) {
            throw new Error(`Log file not found: ${this.filePath}`);
        }

        console.log(`👀 Watching ${this.filePath}`);

        // Initialize cursor if needed
        this.checkInodeAndResetCursor();

        this.watcher = chokidar.watch(this.filePath, {
            persistent: true,
            usePolling: false, // Use native events
            ignoreInitial: true // Don't read whole file on start, only new changes (unless we have a cursor)
        });

        this.watcher.on('change', () => this.onChange());
        this.watcher.on('add', () => this.onChange()); // Handle log rotation (new file)

        // Process any missed content since last run
        this.processNewContent();
    }

    checkInodeAndResetCursor() {
        try {
            const stats = fs.statSync(this.filePath);
            const savedInode = this.config.get('cursor.inode');

            if (savedInode && savedInode !== stats.ino) {
                console.log('🔄 Log rotation detected (Inode changed). Resetting cursor.');
                this.config.set('cursor.offset', 0);
            }

            this.config.set('cursor.inode', stats.ino);
        } catch (e) {
            // File might not exist yet
        }
    }

    onChange() {
        // Debounce to allow write to finish
        if (this.debounceTimer) clearTimeout(this.debounceTimer);
        this.debounceTimer = setTimeout(() => this.processNewContent(), 1000);
    }

    async processNewContent() {
        if (this.processing) return;
        this.processing = true;

        try {
            this.checkInodeAndResetCursor();

            const stats = fs.statSync(this.filePath);
            const currentSize = stats.size;
            let offset = this.config.get('cursor.offset') || 0;

            if (currentSize < offset) {
                // File was truncated
                offset = 0;
            }

            if (currentSize === offset) {
                this.processing = false;
                return;
            }

            const stream = fs.createReadStream(this.filePath, {
                start: offset,
                end: currentSize,
                encoding: 'utf8'
            });

            let buffer = '';

            for await (const chunk of stream) {
                buffer += chunk;
            }

            // Update cursor immediately
            this.config.set('cursor.offset', currentSize);

            // Process lines
            const lines = buffer.split('\n');

            for (const line of lines) {
                if (!line.trim()) continue;

                try {
                    const entry = JSON.parse(line);
                    this.handleLogEntry(entry);
                } catch (e) {
                    // Ignore malformed lines (partial writes)
                }
            }

        } catch (error) {
            console.error('Error processing log:', error);
        } finally {
            this.processing = false;
        }
    }

    handleLogEntry(entry) {
        // Claude Code history.jsonl format:
        // {"display":"prompt","pastedContents":{},"timestamp":123,"project":"...","sessionId":"..."}

        if (!entry.display) return;

        const prompt = entry.display;
        const timestamp = entry.timestamp || Date.now();

        // Deduplication
        const hash = crypto.createHash('md5').update(`${timestamp}:${prompt}`).digest('hex');
        if (this.processedHashes.has(hash)) return;
        this.processedHashes.add(hash);

        // Keep set size manageable
        if (this.processedHashes.size > 1000) {
            const it = this.processedHashes.values();
            this.processedHashes.delete(it.next().value);
        }

        // Sanitize
        const sanitizedPrompt = sanitize(prompt);

        this.emit('memory', {
            content: sanitizedPrompt,
            timestamp: new Date(timestamp).toISOString(),
            source: 'claude-code',
            metadata: {
                project: entry.project,
                sessionId: entry.sessionId
            }
        });
    }
}

export default LogWatcher;
