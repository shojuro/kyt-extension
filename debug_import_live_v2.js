// Run this in the EXTENSION'S background page console

(async () => {
    console.clear();
    console.log('🚀 Starting Live Import Debugger (v2)...');

    // Stop background noise
    await chrome.alarms.clearAll();
    console.log('🔕 Cleared background alarms');

    // Capture logs
    const logs = [];
    const originalLog = console.log;
    const originalError = console.error;

    function capture(...args) {
        logs.push(args.map(a => (typeof a === 'object' ? JSON.stringify(a) : String(a))).join(' '));
        originalLog.apply(console, args);
    }

    console.log = capture;
    console.error = capture;

    try {
        // Use exposed class
        const HistoryImporter = self.HistoryImporter;

        if (!HistoryImporter) {
            throw new Error('HistoryImporter not found on self. Did you reload the extension?');
        }

        // Mock Supabase credentials (we just want to test fetching logic)
        // We'll mock the processBatch to avoid actual DB writes failing
        const importer = new HistoryImporter('https://mock.supabase.co', 'mock-key', 'mock-user-id');

        // Mock processBatch to just log
        importer.processBatch = async (batch) => {
            originalLog(`[MockDB] Would save ${batch.length} messages`);
        };

        // Mock ProgressTracker to avoid DB calls
        importer.progressTracker = {
            initialize: async () => { },
            update: async (u) => originalLog('[Progress]', u),
            getResumePoint: () => null,
            getProgress: () => ({ messagesImported: 0 }),
            complete: async () => originalLog('[Progress] Complete'),
            fail: async (e) => originalLog('[Progress] Failed', e)
        };

        originalLog('--- Starting Claude Import ---');

        const result = await importer.startImport(
            'claude',
            (p) => { }, // onProgress
            async () => null // onFallback
        );

        originalLog('\n✅ Import Result:', result);

    } catch (e) {
        originalLog('\n❌ Import Failed:', e);
    } finally {
        // Restore logs
        console.log = originalLog;
        console.error = originalError;

        // Output all captured logs
        originalLog('\n\n--- CAPTURED LOGS (Copy this) ---');
        originalLog(logs.join('\n'));
        originalLog('-----------------------------------');
    }
})();
