/**
 * Checkpoint Manager for Error Recovery
 *
 * Saves generation progress periodically and allows resuming from checkpoints
 * if the script crashes or is interrupted.
 */

import fs from 'fs/promises';
import path from 'path';

export class CheckpointManager {
  constructor(options = {}) {
    this.checkpointDir = options.checkpointDir || 'data/checkpoints';
    this.datasetName = options.datasetName || 'unknown';
    this.checkpointInterval = options.checkpointInterval || 100;  // Save every 100 examples

    // State
    this.completed = 0;
    this.failed = 0;
    this.results = [];
    this.startTime = Date.now();
    this.lastCheckpointTime = Date.now();
  }

  /**
   * Try to load existing checkpoint
   * @returns {Promise<Object|null>} - Checkpoint data or null if none exists
   */
  async loadCheckpoint() {
    try {
      const checkpointPath = this._getCheckpointPath();
      const data = await fs.readFile(checkpointPath, 'utf-8');
      const checkpoint = JSON.parse(data);

      console.log(`📂 Found checkpoint: ${checkpoint.completed} examples completed`);
      console.log(`   Failed: ${checkpoint.failed}, Last save: ${new Date(checkpoint.lastCheckpointTime).toLocaleString()}`);

      return checkpoint;

    } catch (error) {
      if (error.code === 'ENOENT') {
        // No checkpoint exists - this is fine
        return null;
      }
      throw error;
    }
  }

  /**
   * Save checkpoint
   * @param {Object} state - Current state to save
   */
  async saveCheckpoint(state = {}) {
    try {
      // Ensure checkpoint directory exists
      await fs.mkdir(this.checkpointDir, { recursive: true });

      const checkpointPath = this._getCheckpointPath();
      const checkpoint = {
        datasetName: this.datasetName,
        completed: this.completed,
        failed: this.failed,
        results: this.results,
        startTime: this.startTime,
        lastCheckpointTime: Date.now(),
        ...state  // Allow overriding
      };

      // Atomic write
      const tempPath = `${checkpointPath}.tmp`;
      await fs.writeFile(tempPath, JSON.stringify(checkpoint, null, 2));
      await fs.rename(tempPath, checkpointPath);

      console.log(`💾 Checkpoint saved: ${this.completed} examples`);

    } catch (error) {
      console.error('⚠️  Error saving checkpoint:', error.message);
      // Don't throw - checkpoint failure shouldn't stop generation
    }
  }

  /**
   * Delete checkpoint (call after successful completion)
   */
  async deleteCheckpoint() {
    try {
      const checkpointPath = this._getCheckpointPath();
      await fs.unlink(checkpointPath);
      console.log('🗑️  Checkpoint deleted (generation complete)');
    } catch (error) {
      if (error.code !== 'ENOENT') {
        console.error('⚠️  Error deleting checkpoint:', error.message);
      }
    }
  }

  /**
   * Update progress
   * @param {Object} update - Progress update
   */
  updateProgress(update) {
    if (update.completed !== undefined) {
      this.completed = update.completed;
    }
    if (update.failed !== undefined) {
      this.failed = update.failed;
    }
    if (update.results) {
      this.results = update.results;
    }
  }

  /**
   * Check if should save checkpoint
   * @returns {boolean}
   */
  shouldCheckpoint() {
    return this.completed > 0 && this.completed % this.checkpointInterval === 0;
  }

  /**
   * Get checkpoint statistics
   * @returns {Object}
   */
  getStats() {
    const elapsed = Date.now() - this.startTime;
    const rate = this.completed > 0 ? (this.completed / (elapsed / 1000)).toFixed(2) : 0;

    return {
      datasetName: this.datasetName,
      completed: this.completed,
      failed: this.failed,
      successRate: this.completed > 0
        ? ((this.completed / (this.completed + this.failed)) * 100).toFixed(1) + '%'
        : 'N/A',
      elapsedSeconds: Math.round(elapsed / 1000),
      examplesPerSecond: rate,
      hasCheckpoint: true
    };
  }

  /**
   * Get checkpoint file path
   * @private
   */
  _getCheckpointPath() {
    const filename = `${this.datasetName}_progress.json`;
    return path.join(this.checkpointDir, filename);
  }

  /**
   * List all checkpoints
   * @static
   */
  static async listCheckpoints(checkpointDir = 'data/checkpoints') {
    try {
      const files = await fs.readdir(checkpointDir);
      const checkpoints = [];

      for (const file of files) {
        if (file.endsWith('_progress.json')) {
          const filePath = path.join(checkpointDir, file);
          const data = await fs.readFile(filePath, 'utf-8');
          const checkpoint = JSON.parse(data);
          checkpoints.push({
            filename: file,
            datasetName: checkpoint.datasetName,
            completed: checkpoint.completed,
            failed: checkpoint.failed,
            lastCheckpointTime: checkpoint.lastCheckpointTime
          });
        }
      }

      return checkpoints;

    } catch (error) {
      if (error.code === 'ENOENT') {
        return [];  // No checkpoints directory
      }
      throw error;
    }
  }

  /**
   * Clean up old checkpoints
   * @static
   */
  static async cleanupCheckpoints(checkpointDir = 'data/checkpoints', olderThanDays = 7) {
    try {
      const files = await fs.readdir(checkpointDir);
      const cutoffTime = Date.now() - (olderThanDays * 24 * 60 * 60 * 1000);
      let cleaned = 0;

      for (const file of files) {
        if (file.endsWith('_progress.json')) {
          const filePath = path.join(checkpointDir, file);
          const stats = await fs.stat(filePath);

          if (stats.mtimeMs < cutoffTime) {
            await fs.unlink(filePath);
            cleaned++;
          }
        }
      }

      if (cleaned > 0) {
        console.log(`🧹 Cleaned up ${cleaned} old checkpoint(s)`);
      }

    } catch (error) {
      console.error('⚠️  Error cleaning checkpoints:', error.message);
    }
  }
}
