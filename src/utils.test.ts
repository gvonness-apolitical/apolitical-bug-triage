import { describe, it, expect } from 'vitest';
import { meetsConfidenceThreshold } from './utils.js';

describe('meetsConfidenceThreshold', () => {
  describe('with minimum "low"', () => {
    it('accepts high confidence', () => {
      expect(meetsConfidenceThreshold('high', 'low')).toBe(true);
    });

    it('accepts medium confidence', () => {
      expect(meetsConfidenceThreshold('medium', 'low')).toBe(true);
    });

    it('accepts low confidence', () => {
      expect(meetsConfidenceThreshold('low', 'low')).toBe(true);
    });
  });

  describe('with minimum "medium"', () => {
    it('accepts high confidence', () => {
      expect(meetsConfidenceThreshold('high', 'medium')).toBe(true);
    });

    it('accepts medium confidence', () => {
      expect(meetsConfidenceThreshold('medium', 'medium')).toBe(true);
    });

    it('rejects low confidence', () => {
      expect(meetsConfidenceThreshold('low', 'medium')).toBe(false);
    });
  });

  describe('with minimum "high"', () => {
    it('accepts high confidence', () => {
      expect(meetsConfidenceThreshold('high', 'high')).toBe(true);
    });

    it('rejects medium confidence', () => {
      expect(meetsConfidenceThreshold('medium', 'high')).toBe(false);
    });

    it('rejects low confidence', () => {
      expect(meetsConfidenceThreshold('low', 'high')).toBe(false);
    });
  });

  describe('with invalid minimum', () => {
    it('defaults to level 1 (accepts everything)', () => {
      expect(meetsConfidenceThreshold('low', 'invalid')).toBe(true);
      expect(meetsConfidenceThreshold('medium', 'invalid')).toBe(true);
      expect(meetsConfidenceThreshold('high', 'invalid')).toBe(true);
    });
  });
});
